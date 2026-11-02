#include "coc/external.hpp"
#include <iostream>
using namespace coc;
namespace {
void read_case(const std::string &thread, const std::string &item, size_t limit,
               const std::string &expected) {
  asio::io_context io;
  const auto cwd = std::filesystem::current_path().u8string();
  bool finished = false;
  int callbacks = 0;
  Json result, failure;
  std::shared_ptr<CodexProcess> process;
  asio::steady_timer deadline(io, std::chrono::seconds(5));
  auto done = [&](Json value, Json error) {
    ++callbacks;
    if (finished)
      throw std::runtime_error("History completion delivered twice");
    finished = true;
    result = value;
    failure = error;
    deadline.cancel();
    process->close();
  };
  process = std::make_shared<CodexProcess>(
      io,
      Json{{"codexPath", "node"},
           {"codexArgs",
            Json::array({std::string(COC_SOURCE_DIR) + "/tests/fixtures/history-source-peer.mjs"})},
           {"sandbox", "read-only"}},
      cwd, [](Json) {},
      [&] {
        if (!finished)
          done(nullptr, {{"code", "PROCESS_EXIT"}});
      },
      CodexProcessRole::reader);
  deadline.async_wait([&](auto error) {
    if (!error && !finished)
      done(nullptr, {{"code", "TIMEOUT"}});
  });
  process->start();
  process->initialize([&](Json, Json error) {
    if (!error.is_null()) {
      done(nullptr, error);
      return;
    }
    read_history_item(process, thread, cwd, "turn", item, limit, done);
  });
  io.run();
  const auto code = failure.is_null() ? "" : failure.value("code", "UNKNOWN");
  if (!finished || callbacks != 1 || code != expected)
    throw std::runtime_error("History source case " + thread + "/" + item + ": " + code);
  if (expected.empty() && (result.at("turnId") != "turn" || result.at("item").at("id") != item ||
                           result.at("item").at("text") != "你好🙂"))
    throw std::runtime_error("Persisted item changed");
}
} // namespace
int main() {
  try {
    read_case("normal", "ok", 4096, "");
    read_case("foreign", "ok", 4096, "FORBIDDEN");
    read_case("wrong-thread", "ok", 4096, "FORBIDDEN");
    read_case("rebound", "ok", 4096, "FORBIDDEN");
    read_case("legacy", "ok", 4096, "EXTERNAL_HISTORY_UNSUPPORTED");
    read_case("unknown-mode", "ok", 4096, "EXTERNAL_HISTORY_UNSUPPORTED");
    read_case("bad-metadata", "ok", 4096, "INVALID_FRAME");
    read_case("changed-mode", "ok", 4096, "CONTENT_CHANGED");
    read_case("normal", "", 4096, "INVALID_REQUEST");
    read_case("normal", "missing", 4096, "CONTENT_UNAVAILABLE");
    for (const auto *item : {"wrong-turn", "wrong-item", "duplicate", "malformed"})
      read_case("normal", item, 4096, "INVALID_FRAME");
    read_case("normal", "ok", 1, "BACKPRESSURE");
    read_case("normal", "ok", 0, "INVALID_REQUEST");
    read_case("normal", "ok", 1024 * 1024 + 1, "INVALID_REQUEST");
    read_case("normal", "unsupported", 4096, "CODEX_ERROR");
    std::cout << "PASS: bounded read-only history source, identities, project revalidation, "
                 "missing/unsupported items and read limits\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "FAIL: " << error.what() << '\n';
    return 1;
  }
}
