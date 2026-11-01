#include "coc/credit.hpp"
#include "coc/store.hpp"
#include <future>
#include <iostream>
using namespace coc;
namespace {
void check(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class F> void rejects(F fn, const std::string &code) {
  try {
    fn();
  } catch (const Error &error) {
    check(error.code == code, error.what());
    return;
  }
  throw std::runtime_error("Expected rejection: " + code);
}
struct Temp {
  std::string path =
      (std::filesystem::temp_directory_path() / ("coc-operation-" + uuid())).u8string();
  ~Temp() { std::filesystem::remove_all(std::filesystem::u8path(path)); }
};
Json identity(Store &store, const std::string &request, char owner = 'a') {
  return {{"requestId", request},
          {"owner", std::string(64, owner)},
          {"instance", store.delivery_instance()}};
}
void recovery() {
  Temp temp;
  Json complete, pending;
  std::string completed_key, pending_key;
  const Json data = {{"sessionId", "host~session"}};
  {
    Store journal(temp.path);
    complete = identity(journal, "complete");
    const auto first = journal.operation_begin(complete, "stop", data);
    completed_key = first.at("key");
    const auto reservation = journal.operation_budget();
    const auto duplicate = journal.operation_begin(complete, "stop", data);
    check(first.at("state") == "new" && duplicate.at("state") == "started" &&
              duplicate.at("key") == completed_key && journal.operation_budget() == reservation,
          "Repeated admission never dispatches or reserves the original identity twice");
    rejects([&] { journal.operation_ack(complete, "stop", data); }, "RESULT_PENDING");
    rejects([&] { journal.operation_begin(complete, "stop", {{"sessionId", "host~other"}}); },
            "IDEMPOTENCY_CONFLICT");
    journal.operation_finish(completed_key, {{"data", {{"sessionId", "host~original"}}}});
    journal.operation_finish(completed_key, {{"data", {{"sessionId", "host~original"}}}});
    rejects([&] { journal.operation_finish(completed_key, {{"data", "changed"}}); },
            "IDEMPOTENCY_CONFLICT");
    pending = identity(journal, "uncertain");
    pending_key = journal.operation_begin(pending, "stop", data).at("key");
    // A secondary connection must not apply process restart recovery.
    Store secondary(temp.path, false);
    check(secondary.operation_begin(pending, "stop", data).at("state") == "started",
          "Opening a shared helper connection cannot retire live execution");
  }
  {
    Store journal(temp.path);
    const auto known = journal.operation_begin(complete, "stop", data);
    check(known.at("state") == "completed" &&
              known.at("result").at("data").at("sessionId") == "host~original",
          "A lost response is recoverable from the original request after restart");
    const auto unknown = journal.operation_begin(pending, "stop", data);
    check(unknown.at("state") == "unknown" &&
              unknown.at("result").at("error").at("code") == "RESULT_UNKNOWN",
          "Restarted execution is a durable unknown result, never fresh admission");
    rejects([&] { journal.operation_finish(pending_key, {{"data", true}}); }, "RESULT_UNAVAILABLE");
    auto foreign = complete;
    foreign["instance"] = "another-store";
    rejects([&] { journal.operation_begin(foreign, "stop", data); }, "DELIVERY_STATE_MISMATCH");
    rejects([&] { journal.operation_ack(foreign, "stop", data); }, "DELIVERY_STATE_MISMATCH");
    rejects([&] { journal.operation_ack(complete, "create", data); }, "IDEMPOTENCY_CONFLICT");
    journal.operation_ack(complete, "stop", data);
    journal.operation_ack(pending, "stop", data);
    const auto retired = journal.operation_budget();
    journal.operation_ack(complete, "stop", data);
    check(journal.operation_budget() == retired &&
              retired["global"]["reserved"] == 2 * credit::record_bytes,
          "Confirmation releases result reservation once and retains charged identity tombstones");
    rejects([&] { journal.operation_begin(complete, "stop", data); }, "RESULT_UNAVAILABLE");
    rejects([&] { journal.operation_finish(completed_key, {{"data", true}}); },
            "RESULT_UNAVAILABLE");
    const auto oversized = identity(journal, "oversized");
    rejects(
        [&] { journal.operation_begin(oversized, "create", {{"text", std::string(300000, 'x')}}); },
        "MESSAGE_TOO_LARGE");
    check(journal.operation_budget() == retired, "Rejected input does not consume a new identity");
    const auto large = journal.operation_begin(oversized, "create", data);
    journal.operation_finish(large.at("key"), {{"data", std::string(300000, 'x')}});
    check(journal.operation_begin(oversized, "create", data).at("result").at("error").at("code") ==
              "RESULT_UNKNOWN",
          "Oversized side-effect result has a reserved uncertain terminal, never false success");
  }
}
void session_recovery() {
  Temp temp;
  Json request;
  const Json input = {{"projectId", "project"}, {"mode", "web"}};
  {
    Store journal(temp.path);
    request = identity(journal, "create-crash");
    const auto key = journal.operation_begin(request, "create", input).at("key");
    const Json session = {{"id", "host~allocated"}, {"state", "starting"}, {"running", false}};
    rejects([&] { journal.operation_session("missing", session); }, "RESULT_UNAVAILABLE");
    check(journal.sessions().empty(), "Missing original intent cannot publish an orphan session");
    sqlite3 *fault = nullptr;
    check(sqlite3_open((temp.path + "/agent.db").c_str(), &fault) == SQLITE_OK,
          "Open fault injection connection");
    check(sqlite3_exec(fault,
                       "CREATE TRIGGER fail_session_receipt BEFORE UPDATE OF result ON "
                       "transport2_operations BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
                       nullptr, nullptr, nullptr) == SQLITE_OK,
          "Install receipt failure");
    rejects([&] { journal.operation_session(key, session); }, "STORAGE_ERROR");
    check(journal.sessions().empty(),
          "Receipt failure rolls back the session in the same transaction");
    check(sqlite3_exec(fault, "DROP TRIGGER fail_session_receipt", nullptr, nullptr, nullptr) ==
              SQLITE_OK,
          "Remove receipt failure");
    sqlite3_close(fault);
    journal.operation_session(key, session);
    auto pending = journal.operation_begin(request, "create", input);
    check(pending.at("state") == "started" && !pending.contains("result"),
          "Recovery evidence cannot be acknowledged as a live terminal result");
    rejects([&] { journal.operation_ack(request, "create", input); }, "RESULT_PENDING");
    rejects([&] { journal.operation_session(key, {{"id", "host~duplicate"}}); },
            "IDEMPOTENCY_CONFLICT");
    check(journal.sessions().size() == 1, "Allocation retry cannot create another session");
  }
  {
    Store journal(temp.path);
    const auto result = journal.operation_begin(request, "create", input);
    check(result.at("state") == "unknown" &&
              result.at("result").at("error").at("message").get<std::string>().find(
                  "host~allocated") != std::string::npos,
          "Original request recovers the session identity across the initialization crash gap");
    check(journal.get("host~allocated").at("state") == "failed",
          "Recovering the identity does not claim that its runtime survived restart");
    journal.operation_ack(request, "create", input);
    rejects([&] { journal.operation_begin(request, "create", input); }, "RESULT_UNAVAILABLE");
  }
}
void reservations() {
  Temp temp;
  Store journal(temp.path);
  size_t admitted = 0;
  Json first;
  std::string first_key;
  for (char owner : {'a', 'b', 'c', 'd', 'e'}) {
    size_t count = 0;
    for (; count < 200; ++count) {
      auto request = identity(journal, "operation-" + std::to_string(count), owner);
      try {
        const auto result = journal.operation_begin(request, "stop", Json::object());
        if (!admitted) {
          first = request;
          first_key = result.at("key");
        }
        ++admitted;
      } catch (const Error &error) {
        check(error.code == "BACKPRESSURE", error.what());
        break;
      }
    }
    check(count < 200, "Owner admission is bounded");
    if (owner == 'a')
      check(count > 0, "An owner can reserve available capacity");
    if (owner == 'e')
      check(count == 0, "Fresh owners cannot multiply global reservations");
  }
  const auto full = journal.operation_budget();
  check(full["global"]["reserved"] <= credit::operation_budget &&
            full["global"]["records"] == admitted,
        "Global reservations include every original operation");
  journal.operation_finish(first_key, {{"error", {{"code", "BACKPRESSURE"}}}});
  check(journal.operation_budget() == full,
        "Completing an unconfirmed result does not free its slot");
  journal.operation_ack(first, "stop", Json::object());
  check(journal.operation_begin(identity(journal, "freed", 'e'), "stop", Json::object())
                .at("state") == "new",
        "Durable client confirmation permits a new reservation");
}
void retirement() {
  Temp temp;
  Store journal(temp.path);
  for (int i = 0; i < credit::operation_records; ++i) {
    auto request = identity(journal, "retired-" + std::to_string(i));
    const auto result = journal.operation_begin(request, "create", Json::object());
    journal.operation_finish(result.at("key"), {{"data", i}});
    journal.operation_ack(request, "create", Json::object());
  }
  const auto full = journal.operation_budget();
  check(full["global"]["reserved"] == credit::record_bytes * credit::operation_records,
        "Retired original identities retain only bounded metadata reservations");
  rejects([&] { journal.operation_begin(identity(journal, "overflow"), "create", Json::object()); },
          "BACKPRESSURE");
  rejects(
      [&] { journal.operation_begin(identity(journal, "retired-0"), "create", Json::object()); },
      "RESULT_UNAVAILABLE");
  check(journal.operation_budget() == full,
        "Neither fresh identities nor late retries erase refusal boundaries");
}
void local_recovery() {
  Temp temp;
  const Json body = {{"projectId", "project"}, {"mode", "cli"}};
  const Json receipt = {
      {"requestId", "original"}, {"instance", "agent-store"}, {"owner", std::string(64, 'a')}};
  {
    Store first(temp.path, false, "credential:");
    Store second(temp.path, false, "credential:");
    auto a = std::async(std::launch::async, [&] {
      return first.local_operation_prepare("original", "/sessions", body, "agent-store");
    });
    auto b = std::async(std::launch::async, [&] {
      return second.local_operation_prepare("original", "/sessions", body, "agent-store");
    });
    check(a.get() == b.get(), "Independent CLI processes share one durable original intention");
    rejects([&] { first.local_operation_prepare("original", "/other", body, "agent-store"); },
            "IDEMPOTENCY_CONFLICT");
    rejects([&] { first.local_operation_prepare("original", "/sessions", body, "other-store"); },
            "DELIVERY_STATE_MISMATCH");
    rejects([&] { first.local_operation_confirm("original"); }, "RESULT_PENDING");
    auto wrong = receipt;
    wrong["instance"] = "other-store";
    rejects([&] { first.local_operation_finish("original", {{"data", true}}, wrong); },
            "DELIVERY_STATE_MISMATCH");
    check(first.local_operation("original").at("state") == "pending",
          "Rejected terminal proofs cannot alter the pending original");
    first.local_operation_finish("original", {{"data", {{"id", "host~original"}}}}, receipt);
    check(second.local_operation("original").at("result").at("data").at("id") == "host~original",
          "The original result commits before another process can acknowledge it");
    first.cache_clear();
    check(second.local_operation("original").at("state") == "completed",
          "Ordinary cache clearing preserves unconfirmed operations and their results");
  }
  {
    Store journal(temp.path, false, "credential:");
    check(journal.local_operation("original").at("result").at("data").at("id") == "host~original",
          "A restarted CLI recovers its original result and fixed body");
    journal.local_operation_confirm("original");
    const auto confirmed = journal.local_operation("original");
    check(confirmed.at("state") == "confirmed" && !confirmed.contains("body") &&
              confirmed.contains("result"),
          "Confirmation compacts input and retains a result tail");
    journal.local_operation_confirm("original");
    check(journal.local_operation("original") == confirmed,
          "Duplicate confirmations are idempotent");
    rejects([&] { journal.local_operation_finish("original", {{"data", "changed"}}, receipt); },
            "IDEMPOTENCY_CONFLICT");
    Store foreign(temp.path, false, "other-credential:");
    check(foreign.local_operation("original").is_null(), "Local intents remain credential scoped");
    foreign.local_operation_prepare("original", "/sessions", body, "agent-store");
    foreign.cache_clear();
    check(journal.local_operation("original") == confirmed &&
              foreign.local_operation("original").at("state") == "pending",
          "Clearing another credential cannot erase either durable journal");
  }
}
void local_capacity() {
  Temp temp;
  Store journal(temp.path, false, "credential:");
  const Json body = {{"text", std::string(240000, 'x')}};
  for (int i = 0; i < credit::local_operation_pending; ++i) {
    const auto id = "pending-" + std::to_string(i);
    journal.local_operation_prepare(id, "/sessions", body, "agent-store");
    journal.local_operation_finish(
        id, {{"data", std::string(240000, 'y')}},
        {{"requestId", id}, {"instance", "agent-store"}, {"owner", std::string(64, 'a')}});
  }
  rejects([&] { journal.local_operation_prepare("overflow", "/sessions", body, "agent-store"); },
          "BACKPRESSURE");
  const auto full = journal.local_budget().at("command");
  check(full.at("reserved") == credit::local_command_reservation &&
            full.at("occupied").get<int64_t>() > 32 * 480000 &&
            full.at("occupied") < full.at("reserved"),
        "Original inputs, terminal bodies and metadata fit the advertised shared reservation");
  journal.local_operation_confirm("pending-0");
  journal.local_operation_prepare("overflow", "/sessions", body, "agent-store");
  for (int i = 1; i < credit::local_operation_pending; ++i)
    journal.local_operation_confirm("pending-" + std::to_string(i));
  int retained = 0;
  for (int i = 0; i < credit::local_operation_pending; ++i) {
    const auto record = journal.local_operation("pending-" + std::to_string(i));
    retained += record.contains("result");
    check(!record.contains("body") && record.at("state") == "confirmed",
          "Confirmed bodies are compacted without reopening their identities");
  }
  check(retained <= credit::local_operation_tail, "Confirmed result tail is bounded independently");
  journal.cache_clear();
  check(journal.local_operation("overflow").at("body") == body,
        "Cache clearing cannot discard a pending original input");
  for (int i = 1; i < credit::local_command_budget / credit::local_command_reservation; ++i) {
    Store other(temp.path, false, "credential-" + std::to_string(i) + ":");
    other.local_operation_prepare("original", "/sessions", Json::object(), "agent-store");
  }
  Store overflow(temp.path, false, "extra-credential:");
  rejects(
      [&] {
        overflow.local_operation_prepare("original", "/sessions", Json::object(), "agent-store");
      },
      "BACKPRESSURE");
  check(overflow.local_operation("original").is_null(),
        "Fresh credentials cannot multiply global promises");
}
void local_retirement() {
  Temp temp;
  Store journal(temp.path, false, "credential:");
  for (int i = 0; i < credit::operation_records; ++i) {
    const auto id = "retired-" + std::to_string(i);
    journal.local_operation_prepare(id, "/sessions", Json::object(), "agent-store");
    journal.local_operation_finish(
        id, {{"data", i}},
        {{"requestId", id}, {"instance", "agent-store"}, {"owner", std::string(64, 'a')}});
    journal.local_operation_confirm(id);
  }
  rejects(
      [&] { journal.local_operation_prepare("extra", "/sessions", Json::object(), "agent-store"); },
      "BACKPRESSURE");
  const auto old =
      journal.local_operation_prepare("retired-0", "/sessions", Json::object(), "agent-store");
  check(
      old.at("state") == "confirmed" && !old.contains("body") && !old.contains("result"),
      "An evicted diagnostic result never permits the original intention to become pending again");
}
} // namespace
int main() {
  try {
    for (const auto &fixture : read_json(std::filesystem::path(COC_SOURCE_DIR) /
                                         "tests/operation-intent-fixtures.json")) {
      if (fixture.value("error", false))
        rejects([&] { operation_intent(fixture.at("input")); }, "INVALID_REQUEST");
      else
        check(operation_intent(fixture.at("input")) == fixture.at("output"),
              "Shared C++/Zod original operation identity example");
    }
    for (const auto &fixture :
         read_json(std::filesystem::path(COC_SOURCE_DIR) / "tests/original-write-fixtures.json"))
      check(operation_write(fixture.at("action"), fixture.at("data")) == fixture.at("write"),
            "Shared C++/Worker write admission classification");
    recovery();
    session_recovery();
    reservations();
    retirement();
    local_recovery();
    local_capacity();
    local_retirement();
    std::cout << "PASS: endpoint operation identity, original results, crash uncertainty, instance "
                 "fencing, reserved terminal capacity, confirmation and bounded retirement\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "FAIL: " << error.what() << '\n';
    return 1;
  }
}
