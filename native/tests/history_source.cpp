#include "coc/delivery.hpp"
#include "coc/external.hpp"
#include "coc/history_projection.hpp"
#include <iostream>
using namespace coc;
namespace {
void projection_cases() {
  const auto path = std::filesystem::temp_directory_path() / ("coc-projection-" + uuid());
  struct Cleanup {
    std::filesystem::path path;
    ~Cleanup() { std::filesystem::remove_all(path); }
  } cleanup{path};
  Store store(path.u8string());
  const std::string session = "host~projection";
  store.save({{"id", session}});
  const Json samples = Json::array(
      {{{"item", {{"id", "agent"}, {"type", "agentMessage"}, {"text", "你好🙂"}}},
        {"text", "你好🙂"}},
       {{"item",
         {{"id", "user"},
          {"type", "userMessage"},
          {"content", Json::array({{{"type", "text"}, {"text", "一"}},
                                   {{"type", "image"}, {"url", "image"}},
                                   {{"type", "text"}, {"text", "二"}}})}}},
        {"text", "一二"}},
       {{"item",
         {{"id", "tool"},
          {"type", "commandExecution"},
          {"status", "completed"},
          {"env", {{"SECRET", "never publish"}}},
          {"token", "never publish"}}},
        {"text",
         R"({"env":{},"id":"tool","status":"completed","token":"[redacted]","type":"commandExecution"})"}}});
  for (const auto &sample : samples) {
    const auto projected = project_history_item(sample.at("item"), "turn");
    if (projected.text != sample.at("text"))
      throw std::runtime_error("Versioned projection changed established content bytes");
    const auto event = store.external_item(session, "turn", sample.at("item"));
    const auto reference = store.history_reference(session, event.at("seq"));
    if (!history_text_matches(recover_history_text(event, sample.at("item"), "external-v1"),
                              reference))
      throw std::runtime_error("Reconstruction differs from actual stored content");
    if (!store.external_item(session, "turn", sample.at("item")).is_null())
      throw std::runtime_error("Projection changed deduplication fingerprint");
  }
  Json item = {{"id", "current"}, {"type", "agentMessage"}, {"text", "原正文🙂"}};
  const auto event = store.external_item(session, "turn", item);
  const auto reference = store.history_reference(session, event.at("seq"));
  auto wrong_reference = reference;
  wrong_reference["revision"] = reference.at("revision").get<int64_t>() + 1;
  bool wrong_revision_rejected = false;
  try {
    recover_history_content(event, item, "external-v1", wrong_reference);
  } catch (const Error &error) {
    wrong_revision_rejected = error.code == "CONTENT_UNAVAILABLE";
  }
  if (!wrong_revision_rejected)
    throw std::runtime_error("Matching bytes cannot authorize a different history revision");
  item["futureMetadata"] = "new metadata";
  if (!history_text_matches(recover_history_text(event, item, "external-v1"), reference))
    throw std::runtime_error("Non-body metadata changes should not prevent exact body recovery");
  item["text"] = "原正文🙂追加输出";
  if (recover_history_content(event, item, "external-v1", reference) != "原正文🙂")
    throw std::runtime_error("A verified old text prefix should remain recoverable after append");
  item["text"] = "新正文🙂";
  if (history_text_matches(recover_history_text(event, item, "external-v1"), reference))
    throw std::runtime_error("Changed body must not satisfy the old reference");
  bool changed_rejected = false;
  try {
    recover_history_content(event, item, "external-v1", reference);
  } catch (const Error &error) {
    changed_rejected = error.code == "CONTENT_UNAVAILABLE";
  }
  if (!changed_rejected)
    throw std::runtime_error("Changed content escaped old-reference validation");

  for (const auto *projection : {"event-v1", "external-v1"}) {
    item["id"] = "wrong";
    bool rejected = false;
    try {
      recover_history_text(event, item, projection);
    } catch (const Error &error) {
      rejected = error.code == "CONTENT_UNAVAILABLE";
    }
    if (!rejected)
      throw std::runtime_error("Wrong item accepted during reconstruction");
  }
  bool rejected = false;
  try {
    project_history_item(item, "turn", 2);
  } catch (const Error &error) {
    rejected = error.code == "CONTENT_UNAVAILABLE";
  }
  if (!rejected)
    throw std::runtime_error("Unknown projection version accepted");
  const Json tool = {{"id", "ordinary"},
                     {"type", "commandExecution"},
                     {"status", "completed"},
                     {"aggregatedOutput", "output🙂"}};
  const auto tool_event =
      store.event(session, "item/completed", {{"turnId", "turn"}, {"item", tool}});
  if (!history_text_matches(recover_history_text(tool_event, tool, "event-v1"),
                            store.history_reference(session, tool_event.at("seq"))))
    throw std::runtime_error("Ordinary command body projection differs from Store::content");
  auto complete_tool = tool;
  complete_tool["aggregatedOutput"] = "early\noutput🙂\nlater";
  const auto tool_reference = store.history_reference(session, tool_event.at("seq"));
  if (recover_history_content(tool_event, complete_tool, "event-v1", tool_reference, 6) !=
      "output🙂")
    throw std::runtime_error("A registered byte span must recover the original stream body");
  for (const size_t offset : {size_t(5), size_t(7), std::numeric_limits<size_t>::max()}) {
    bool rejected_span = false;
    try {
      recover_history_content(tool_event, complete_tool, "event-v1", tool_reference, offset);
    } catch (const Error &error) {
      rejected_span = error.code == "CONTENT_UNAVAILABLE";
    }
    if (!rejected_span)
      throw std::runtime_error("Invalid source span accepted");
  }

  const Json patch = {{"id", "patch"},
                      {"type", "fileChange"},
                      {"status", "completed"},
                      {"changes", Json::array({{{"path", "a"}, {"diff", "你好"}}})}};
  const auto patch_event =
      store.event(session, "item/completed", {{"turnId", "turn"}, {"item", patch}});
  if (!history_text_matches(recover_history_text(patch_event, patch, "event-v1"),
                            store.history_reference(session, patch_event.at("seq"))))
    throw std::runtime_error("Whole-event content must retain original envelope metadata");
  auto persisted_patch = patch;
  persisted_patch["startedAtMs"] = 100;
  persisted_patch["completedAtMs"] = 200;
  const auto patch_reference = store.history_reference(session, patch_event.at("seq"));
  if (!history_text_matches(recover_history_text(patch_event, persisted_patch, "event-v1"),
                            patch_reference))
    throw std::runtime_error(
        "Added producer timestamps must not prevent exact old-content recovery");
  persisted_patch["changes"][0]["diff"] = "different file content";
  if (history_text_matches(recover_history_text(patch_event, persisted_patch, "event-v1"),
                           patch_reference))
    throw std::runtime_error("Metadata normalization must not hide changed file content");
  auto timed_patch = patch;
  timed_patch["startedAtMs"] = 100;
  const auto timed_event =
      store.event(session, "item/completed", {{"turnId", "turn"}, {"item", timed_patch}});
  const auto timed_reference = store.history_reference(session, timed_event.at("seq"));
  timed_patch["startedAtMs"] = 101;
  if (history_text_matches(recover_history_text(timed_event, timed_patch, "event-v1"),
                           timed_reference))
    throw std::runtime_error("An originally retained timestamp must not be silently changed");
}
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
    projection_cases();
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
