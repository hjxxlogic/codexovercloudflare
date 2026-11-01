#include "coc/credit.hpp"
#include "coc/process.hpp"
#include <chrono>
#include <csignal>
#include <filesystem>
#include <iostream>
#include <vector>
using namespace coc;
namespace {
void check(bool value, const std::string &message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class F> void rejects(F fn) {
  try {
    fn();
  } catch (const Error &error) {
    check(error.code == "BACKPRESSURE", error.what());
    return;
  }
  throw std::runtime_error("Expected BACKPRESSURE");
}
// The actual child consumes pipe input. Held requests model a stalled Codex;
// flush returns those original IDs, including replies arriving after timeout.
int peer() {
  std::vector<Json> held;
  std::string line;
  while (std::getline(std::cin, line)) {
    const auto request = Json::parse(line);
    const auto method = request.value("method", "reply");
    if (method == "hold") {
      held.push_back(request);
      continue;
    }
    if (method == "flush") {
      for (const auto &item : held)
        std::cout << Json{{"id", item.at("id")}, {"result", item.at("params")}}.dump() << '\n';
      held.clear();
    }
    if (request.contains("method") && request.contains("id")) {
      if (method == "error")
        std::cout << Json{{"id", request.at("id")},
                          {"error", {{"code", -123}, {"message", "Original error"}, {"data", 7}}}}
                         .dump()
                  << '\n';
      else
        std::cout
            << Json{{"id", request.at("id")}, {"result", request.value("params", Json())}}.dump()
            << '\n';
    } else
      std::cout << Json{{"method", "test/input"}, {"params", request}}.dump() << '\n';
    std::cout.flush();
  }
  return 0;
}
struct Harness {
  asio::io_context io;
  Json config;
  std::vector<std::shared_ptr<CodexProcess>> processes;
  std::vector<Json> messages;
  explicit Harness(const std::string &executable)
      : config{{"codexPath", executable},
               {"codexArgs", Json::array({"--peer"})},
               {"sandbox", "read-only"}} {}
  std::shared_ptr<CodexProcess> make(CodexProcessRole role = CodexProcessRole::runtime) {
    auto process = std::make_shared<CodexProcess>(
        io, config, std::filesystem::current_path().u8string(),
        [this](Json message) { messages.push_back(std::move(message)); }, [] {}, role);
    processes.push_back(process);
    process->start();
    return process;
  }
  template <class F> void until(F condition, int seconds = 5) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(seconds);
    while (!condition()) {
      check(std::chrono::steady_clock::now() < deadline, "Actual subprocess exchange timed out");
      io.restart();
      io.run_for(std::chrono::milliseconds(20));
    }
  }
  void clear() {
    for (auto &process : processes)
      process->close();
    processes.clear();
    io.restart();
    io.run();
    const auto usage = CodexProcess::usage();
    for (const auto &item : usage.items())
      check(item.value() == 0, "Resource lease was not released: " + usage.dump());
  }
  ~Harness() {
    for (auto &process : processes)
      process->close();
    processes.clear();
    if (std::uncaught_exceptions())
      io.stop();
    else {
      io.restart();
      io.run();
    }
  }
};
void roles(const std::string &executable) {
  Harness h(executable);
  for (int64_t n = 0; n < credit::runtime_processes; ++n)
    h.make();
  rejects([&] { h.make(); });
  for (int64_t n = 0; n < credit::reader_processes; ++n)
    h.make(CodexProcessRole::reader);
  rejects([&] { h.make(CodexProcessRole::reader); });
  check(CodexProcess::usage().at("runtimes") == credit::runtime_processes &&
            CodexProcess::usage().at("readers") == credit::reader_processes,
        "History readers must retain independent process capacity");
  h.clear();
  // Failed construction releases the reservation without needing an exit callback.
  h.config.erase("codexPath");
  bool failed = false;
  try {
    h.make();
  } catch (...) {
    failed = true;
  }
  check(failed && CodexProcess::usage().at("runtimes") == 0,
        "Failed construction leaked a process slot");
}
void pending(const std::string &executable) {
  Harness h(executable);
  auto process = h.make();
  int completed = 0, admitted = 0, refused = 0, interrupted = 0;
  for (int64_t n = 0; n < credit::process_pending; ++n)
    process->request(
        "hold", {{"n", n}},
        [&](Json, Json error) {
          check(error.is_null(), "Held request failed unexpectedly");
          ++completed;
        },
        [&] { ++admitted; });
  process->request(
      "hold", {},
      [&](Json, Json error) {
        check(error.at("code") == "BACKPRESSURE", "Normal pending count must reject");
        ++refused;
      },
      [&] { ++admitted; });
  for (int64_t n = 0; n < credit::process_priority_pending; ++n)
    process->request("turn/interrupt", {{"n", n}}, [&](Json, Json error) {
      check(error.is_null(), "Priority request failed under normal pressure");
      ++interrupted;
    });
  process->request("turn/interrupt", {}, [&](Json, Json error) {
    check(error.at("code") == "BACKPRESSURE", "Priority pending count must be bounded");
    ++refused;
  });
  check(admitted == credit::process_pending && refused == 2,
        "Rejected requests ran admission hooks");
  process->send({{"method", "flush"}});
  h.until([&] {
    return completed == credit::process_pending && interrupted == credit::process_priority_pending;
  });
  int errors = 0;
  process->request("error", {}, [&](Json, Json error) {
    check(error.at("rpc") == Json{{"code", -123}, {"message", "Original error"}, {"data", 7}},
          "RPC remapping must preserve the original server error");
    ++errors;
  });
  h.until([&] { return errors == 1; });
  check(CodexProcess::usage().at("normalPending") == 0 &&
            CodexProcess::usage().at("priorityPending") == 0,
        "Replies did not release pending budgets");
  process.reset();
  h.clear();
}
void pending_global(const std::string &executable) {
  Harness h(executable);
  int unknown = 0;
  const auto finish = [&](Json, Json error) {
    check(error.at("code") == "RESULT_UNKNOWN", "Unconfirmed process exit must remain unknown");
    ++unknown;
  };
  for (int64_t n = 0; n < credit::process_pending_global / credit::process_pending; ++n) {
    auto process = h.make();
    for (int64_t k = 0; k < credit::process_pending; ++k)
      process->request("hold", {}, finish);
  }
  auto extra = h.make();
  bool refused = false, priority = false;
  extra->request("hold", {},
                 [&](Json, Json error) { refused = error.at("code") == "BACKPRESSURE"; });
  extra->request("turn/interrupt", {}, [&](Json, Json error) { priority = error.is_null(); });
  check(refused && CodexProcess::usage().at("normalPending") == credit::process_pending_global,
        "Global pending count was exceeded");
  h.until([&] { return priority; });
  extra.reset();
  h.clear();
  check(unknown == credit::process_pending_global,
        "Process exit did not finish every original callback");
}
void byte_limits(const std::string &executable) {
  Harness h(executable);
  const Json large = {{"text", std::string(200000, 'x')}};
  auto process = h.make();
  int admitted = 0, refused = 0;
  const auto ignore = [](Json, Json) {};
  for (int n = 0; n < 2; ++n)
    process->request("hold", large, ignore, [&] { ++admitted; });
  process->request(
      "hold", large, [&](Json, Json error) { refused += error.at("code") == "BACKPRESSURE"; },
      [&] { ++admitted; });
  process->request(
      "turn/interrupt", large,
      [&](Json, Json error) { refused += error.at("code") == "BACKPRESSURE"; },
      [&] { ++admitted; });
  check(admitted == 2 && refused == 2, "Pending byte admission did not precede side effects");
  process.reset();
  h.clear();
  // Fill aggregate pending bytes while every local process is below its limit.
  for (int n = 0; n < 10; ++n) {
    auto item = h.make();
    for (int k = 0; k < 2; ++k)
      item->request("hold", large, ignore);
  }
  auto extra = h.make();
  refused = 0;
  extra->request("hold", large,
                 [&](Json, Json error) { refused += error.at("code") == "BACKPRESSURE"; });
  check(refused == 1 &&
            CodexProcess::usage().at("normalPendingBytes") <= credit::process_pending_global_bytes,
        "Global pending byte budget was exceeded");
  extra.reset();
  h.clear();
}
void input_limits(const std::string &executable) {
  Harness h(executable);
  auto process = h.make();
  for (int64_t n = 0; n < credit::process_queue_records; ++n)
    process->send({{"method", "notice"}, {"params", {{"n", n}}}});
  rejects([&] { process->send({{"method", "notice"}}); });
  for (int64_t n = 0; n < credit::process_priority_queue_records; ++n)
    process->send({{"id", n}, {"result", true}});
  rejects([&] { process->send({{"id", 99}, {"result", true}}); });
  int refused = 0, admitted = 0;
  const auto rejected = [&](Json, Json error) {
    check(error.at("code") == "BACKPRESSURE", "Input exhaustion must reject before admission");
    ++refused;
  };
  process->request("hold", {}, rejected, [&] { ++admitted; });
  process->request("turn/interrupt", {}, rejected, [&] { ++admitted; });
  check(refused == 2 && admitted == 0 && CodexProcess::usage().at("normalPending") == 0 &&
            CodexProcess::usage().at("priorityPending") == 0,
        "Input refusal leaked a pending slot or ran side effects");
  check(CodexProcess::usage().at("normalQueued") == credit::process_queue_records &&
            CodexProcess::usage().at("priorityQueued") == credit::process_priority_queue_records,
        "Input queues borrowed each other's reservations");
  h.until([&] {
    return h.messages.size() ==
           credit::process_queue_records + credit::process_priority_queue_records;
  });
  check(h.messages.at(0).at("params").at("method") == "notice", "Active frame was interrupted");
  check(!h.messages.at(1).at("params").contains("method") &&
            h.messages.at(credit::process_priority_queue_records).at("params").at("id") ==
                credit::process_priority_queue_records - 1,
        "Approval replies did not run ahead of queued normal input");
  const auto before = CodexProcess::usage();
  bool storage_error = false;
  process->request(
      "echo", {}, [&](Json, Json error) { storage_error = error.at("code") == "STORAGE_FAILED"; },
      [] { throw Error("STORAGE_FAILED", "Cannot save task admission"); });
  check(storage_error && CodexProcess::usage() == before,
        "Failed pre-send storage must release both reservations without sending");
  process.reset();
  h.clear();
  for (int n = 0; n < 8; ++n) {
    auto item = h.make();
    for (int64_t k = 0; k < credit::process_queue_records; ++k)
      item->send({{"method", "notice"}});
    for (int64_t k = 0; k < credit::process_priority_queue_records; ++k)
      item->send({{"id", k}, {"result", true}});
  }
  auto extra = h.make();
  rejects([&] { extra->send({{"method", "notice"}}); });
  rejects([&] { extra->send({{"id", 99}, {"result", true}}); });
  check(CodexProcess::usage().at("normalQueued") == credit::process_queue_global_records &&
            CodexProcess::usage().at("priorityQueued") ==
                credit::process_priority_queue_global_records,
        "Global input record budgets were exceeded");
  extra.reset();
  h.clear();
  // Large queued notifications consume bytes independently of request slots.
  for (int n = 0; n < 8; ++n) {
    auto item = h.make();
    for (int k = 0; k < 10; ++k)
      item->send({{"method", "notice"}, {"params", std::string(200000, 'x')}});
    rejects([&] { item->send({{"method", "notice"}, {"params", std::string(200000, 'x')}}); });
  }
  extra = h.make();
  for (int n = 0; n < 3; ++n)
    extra->send({{"method", "notice"}, {"params", std::string(200000, 'x')}});
  rejects([&] { extra->send({{"method", "notice"}, {"params", std::string(200000, 'x')}}); });
  check(CodexProcess::usage().at("normalQueuedBytes") <= credit::process_queue_global_bytes,
        "Global input byte budget was exceeded");
  extra.reset();
  h.clear();
  for (int n = 0; n < 5; ++n) {
    auto item = h.make();
    for (int k = 0; k < 2; ++k)
      item->send({{"id", k}, {"result", std::string(200000, 'x')}});
    rejects([&] { item->send({{"id", 3}, {"result", std::string(200000, 'x')}}); });
  }
  extra = h.make();
  rejects([&] { extra->send({{"id", 3}, {"result", std::string(200000, 'x')}}); });
  check(CodexProcess::usage().at("priorityQueuedBytes") <=
            credit::process_priority_queue_global_bytes,
        "Global priority byte budget was exceeded");
  extra.reset();
  h.clear();
}
void timeout(const std::string &executable) {
  Harness h(executable);
  auto process = h.make();
  bool unknown = false, fresh = false;
  process->request("hold", {{"old", true}}, [&](Json, Json error) {
    check(error.at("code") == "RESULT_UNKNOWN", "Timeout must not promise non-execution");
    unknown = true;
  });
  h.until([&] { return unknown; }, 23);
  check(CodexProcess::usage().at("normalPending") == 0, "Timeout leaked its pending reservation");
  process->request("flush", {{"fresh", true}}, [&](Json result, Json error) {
    check(error.is_null() && result.at("fresh") == true, "A late reply completed a new request");
    fresh = true;
  });
  h.until([&] { return fresh; });
  check(h.messages.empty(), "An internal late response leaked to client output");
  process.reset();
  h.clear();
}
} // namespace
int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (argc >= 2 && std::string(argv[1]) == "--peer")
    return peer();
  try {
    const auto executable = std::filesystem::absolute(argv[0]).u8string();
    roles(executable);
    pending(executable);
    pending_global(executable);
    byte_limits(executable);
    input_limits(executable);
    timeout(executable);
    std::cout << "PASS: actual Codex subprocess count, pending/input budgets, priority isolation, "
                 "timeout and exit\n";
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
