#include "coc/delivery.hpp"
#include "coc/external.hpp"
#include "coc/history_projection.hpp"
#include <fstream>
#include <iostream>
#ifndef _WIN32
#include <sys/stat.h>
#endif
using namespace coc;
namespace {
template <class F> void rejects_source(F fn, const std::string &code) {
  try {
    fn();
  } catch (const Error &error) {
    if (error.code == code)
      return;
    throw std::runtime_error("Expected " + code + ", got " + error.code);
  }
  throw std::runtime_error("Expected " + code);
}
void origin_cases() {
  const auto root = std::filesystem::temp_directory_path() / ("coc-origin-" + uuid());
  struct Cleanup {
    std::filesystem::path path;
    ~Cleanup() { std::filesystem::remove_all(path); }
  } cleanup{root};
  const auto home = root / ".codex";
  const auto project = root / "project";
  std::filesystem::create_directories(home / "sessions");
  std::filesystem::create_directories(project);
  auto file = home / "sessions" / "thread.jsonl";
  std::ofstream(file) << "initial";
  Json thread = {
      {"id", "thread"}, {"createdAt", 1}, {"cwd", project.u8string()}, {"path", file.u8string()}};
  const auto origin = history_source_origin(thread, home, project.u8string());
  if (origin.at("environment").get<std::string>().size() != 64)
    throw std::runtime_error("Missing source identity digest");
  std::ofstream(file, std::ios::app) << "append";
  if (history_source_origin(thread, home, project.u8string()) != origin)
    throw std::runtime_error("Ordinary source append changed instance identity");
  std::filesystem::create_directories(home / "archived");
  const auto archived = home / "archived" / "thread.jsonl";
  std::filesystem::rename(file, archived);
  file = archived;
  thread["path"] = file.u8string();
  if (history_source_origin(thread, home, project.u8string()) != origin)
    throw std::runtime_error("Archiving the same source file should retain identity");
  const auto replacement = home / "replacement.jsonl";
  std::ofstream(replacement) << "initialappend";
  std::filesystem::rename(replacement, file);
  const auto replaced = history_source_origin(thread, home, project.u8string());
  if (replaced == origin)
    throw std::runtime_error("Same-path source replacement reused old instance identity");
  thread["createdAt"] = 2;
  if (history_source_origin(thread, home, project.u8string()) == replaced)
    throw std::runtime_error("Changed thread creation identity was ignored");
  thread["createdAt"] = 1;
  std::filesystem::remove(file);
  rejects_source([&] { history_source_origin(thread, home, project.u8string()); },
                 "CONTENT_UNAVAILABLE");
  std::ofstream(project / "outside.jsonl") << "outside";
  thread["path"] = (project / "outside.jsonl").u8string();
  rejects_source([&] { history_source_origin(thread, home, project.u8string()); }, "FORBIDDEN");
  thread["path"] = nullptr;
  rejects_source([&] { history_source_origin(thread, home, project.u8string()); },
                 "CONTENT_UNAVAILABLE");
  thread["path"] = (home / "sessions").u8string();
  rejects_source([&] { history_source_origin(thread, home, project.u8string()); },
                 "CONTENT_UNAVAILABLE");
#ifndef _WIN32
  const auto fifo = home / "fifo";
  if (mkfifo(fifo.c_str(), 0600) != 0)
    throw std::runtime_error("Create source FIFO fixture");
  thread["path"] = fifo.u8string();
  rejects_source([&] { history_source_origin(thread, home, project.u8string()); },
                 "CONTENT_UNAVAILABLE");
  std::filesystem::create_symlink(project / "outside.jsonl", home / "escape.jsonl");
  thread["path"] = (home / "escape.jsonl").u8string();
  rejects_source([&] { history_source_origin(thread, home, project.u8string()); }, "FORBIDDEN");
#endif
}
void durable_source_cases() {
  const auto path = std::filesystem::temp_directory_path() / ("coc-source-map-" + uuid());
  std::filesystem::create_directories(path);
  struct Cleanup {
    std::filesystem::path path;
    ~Cleanup() { std::filesystem::remove_all(path); }
  } cleanup{path};
  const auto sql = [](const std::filesystem::path &dir, const std::string &statement) {
    sqlite3 *db = nullptr;
    if (sqlite3_open((dir / "agent.db").u8string().c_str(), &db) != SQLITE_OK)
      throw std::runtime_error("Open source fixture");
    const int code = sqlite3_exec(db, statement.c_str(), nullptr, nullptr, nullptr);
    sqlite3_close(db);
    if (code != SQLITE_OK)
      throw std::runtime_error("Source fixture SQL failed");
  };
  const Json origin = {{"environment", std::string(64, 'a')},
                       {"projectPath", std::filesystem::canonical(path).u8string()}};
  const std::string session = "host~source";
  const Json entry = {{"turnId", "turn"},
                      {"completedAtMs", 1},
                      {"item",
                       {{"id", "item"},
                        {"type", "commandExecution"},
                        {"aggregatedOutput", "before|原输出🙂|after"}}}};
  int64_t seq = 0;
  Json registered, budget;
  {
    Store store((path / "data").u8string());
    store.save(
        {{"id", session}, {"projectId", "project"}, {"threadId", "thread"}, {"state", "closed"}});
    const auto event = store.event(session, "item/commandExecution/outputDelta",
                                   {{"turnId", "turn"}, {"itemId", "item"}, {"delta", "原输出🙂"}});
    seq = event.at("seq");
    store.history_reserve(session, 65536, 16);
    budget = store.history_budget();
    rejects_source([&] { store.history_source_register(session, seq, origin, entry); },
                   "BACKPRESSURE");
    if (store.history_budget() != budget)
      throw std::runtime_error("Source mapping consumed task promise");
    store.history_release(session);
    const auto before = store.history_budget();
    sql(path / "data", "CREATE TRIGGER fail_source BEFORE UPDATE ON transport2_history_budget "
                       "WHEN NEW.scope='@global' AND NEW.bytes>OLD.bytes "
                       "BEGIN SELECT RAISE(ABORT,'injected source accounting failure'); END");
    rejects_source([&] { store.history_source_register(session, seq, origin, entry); },
                   "STORAGE_ERROR");
    if (store.history_budget() != before || store.content(session, seq, 0).at("text") != "原输出🙂")
      throw std::runtime_error("Failed registration changed body or budget");
    rejects_source([&] { store.history_source(session, seq, origin); }, "CONTENT_UNAVAILABLE");
    sql(path / "data", "DROP TRIGGER fail_source");
    registered = store.history_source_register(session, seq, origin, entry);
    budget = store.history_budget();
    if (registered.at("offset") != 7 ||
        registered.at("event").dump().find("原输出") != std::string::npos ||
        budget.at("global").at("records").get<int64_t>() !=
            before.at("global").at("records").get<int64_t>() + 1 ||
        budget.at("global").at("bytes") <= before.at("global").at("bytes"))
      throw std::runtime_error(
          "Source mapping must retain only bounded charged metadata and byte offset");
    if (store.history_source_register(session, seq, origin, entry) != registered ||
        store.history_budget() != budget)
      throw std::runtime_error("Repeated source registration is not idempotent");
    auto changed = entry;
    changed["item"]["aggregatedOutput"] = "different";
    rejects_source([&] { store.history_source_register(session, seq, origin, changed); },
                   "CONTENT_UNAVAILABLE");
    changed = entry;
    changed["completedAtMs"] = nullptr;
    rejects_source([&] { store.history_source_register(session, seq, origin, changed); },
                   "CONTENT_UNAVAILABLE");
    changed = entry;
    changed["item"]["status"] = "inProgress";
    rejects_source([&] { store.history_source_register(session, seq, origin, changed); },
                   "CONTENT_UNAVAILABLE");
    changed = entry;
    changed["turnId"] = "another";
    rejects_source([&] { store.history_source_register(session, seq, origin, changed); },
                   "CONTENT_UNAVAILABLE");
    if (store.history_budget() != budget)
      throw std::runtime_error("Rejected registration changed accounting");
  }
  {
    Store store((path / "data").u8string());
    if (store.history_source(session, seq, origin) != registered ||
        store.history_budget() != budget ||
        store.history_source_recover(session, seq, origin, entry) != "原输出🙂")
      throw std::runtime_error("Restart lost verified source, body span or accounting");
    auto other = origin;
    other["environment"] = std::string(64, 'b');
    rejects_source([&] { store.history_source(session, seq, other); }, "DELIVERY_STATE_MISMATCH");
    rejects_source([&] { store.history_source_register(session, seq, other, entry); },
                   "DELIVERY_STATE_MISMATCH");
    auto state = store.get(session);
    state["threadId"] = "different";
    store.save(state);
    rejects_source([&] { store.history_source(session, seq, origin); }, "DELIVERY_STATE_MISMATCH");
    state["threadId"] = "thread";
    store.save(state);
    const auto next = store.event(session, "item/commandExecution/outputDelta",
                                  {{"turnId", "turn"}, {"itemId", "item"}, {"delta", "追加"}});
    if (next.at("seq") != seq)
      throw std::runtime_error("Fixture changed stable history identity");
    rejects_source([&] { store.history_source(session, seq, origin); }, "CONTENT_UNAVAILABLE");
    sql(path / "data", "CREATE TEMP TABLE source_check(n INTEGER CHECK(n=0)); "
                       "INSERT INTO source_check SELECT COUNT(*) FROM transport2_history_sources; "
                       "INSERT INTO source_check SELECT COUNT(*) FROM transport2_history_entries "
                       "WHERE key GLOB 'transport2_history_sources:*'");
  }
  {
    Store store((path / "external").u8string());
    store.save({{"id", session},
                {"projectId", "project"},
                {"threadId", "thread"},
                {"state", "closed"},
                {"external", true}});
    auto item = Json{{"id", "external"}, {"type", "agentMessage"}, {"text", "external body"}};
    const auto event = store.external_item(session, "turn", item);
    const Json external = {{"turnId", "turn"}, {"completedAtMs", 1}, {"item", item}};
    store.history_source_register(session, event.at("seq"), origin, external);
    if (store.history_source_recover(session, event.at("seq"), origin, external) != "external body")
      throw std::runtime_error("External source projection failed");
    item["text"] = "rewritten";
    store.external_item(session, "turn", item);
    rejects_source([&] { store.history_source(session, event.at("seq"), origin); },
                   "CONTENT_UNAVAILABLE");
    sql(path / "external",
        "CREATE TEMP TABLE source_check(n INTEGER CHECK(n=0)); "
        "INSERT INTO source_check SELECT COUNT(*) FROM transport2_history_sources; "
        "INSERT INTO source_check SELECT COUNT(*) FROM transport2_history_entries "
        "WHERE key GLOB 'transport2_history_sources:*'");
  }
  {
    Store store((path / "envelope").u8string());
    store.save(
        {{"id", session}, {"projectId", "project"}, {"threadId", "thread"}, {"state", "closed"}});
    const std::string diff = "unique-patch-body:" + std::string(20000, '+');
    Json item = {{"id", "patch"},
                 {"type", "fileChange"},
                 {"status", "completed"},
                 {"changes", Json::array({{{"path", "file"}, {"diff", diff}}})}};
    const auto event = store.event(session, "item/completed", {{"turnId", "turn"}, {"item", item}});
    item["startedAtMs"] = 1;
    item["completedAtMs"] = 2;
    const Json source_entry = {{"turnId", "turn"}, {"completedAtMs", 2}, {"item", item}};
    const auto source =
        store.history_source_register(session, event.at("seq"), origin, source_entry);
    if (source.at("event").dump().find("unique-patch-body") != std::string::npos ||
        !history_text_matches(
            store.history_source_recover(session, event.at("seq"), origin, source_entry),
            source.at("reference")))
      throw std::runtime_error("Large envelope source mapping duplicated or changed original body");
    const auto overlap =
        store.event(session, "item/commandExecution/outputDelta",
                    {{"turnId", "overlap"}, {"itemId", "overlap"}, {"delta", "ababaca"}});
    const Json overlap_entry = {
        {"turnId", "overlap"},
        {"completedAtMs", 1},
        {"item",
         {{"id", "overlap"}, {"type", "commandExecution"}, {"aggregatedOutput", "ababababacazz"}}}};
    if (store.history_source_register(session, overlap.at("seq"), origin, overlap_entry)
                .at("offset") != 4 ||
        store.history_source_recover(session, overlap.at("seq"), origin, overlap_entry) !=
            "ababaca")
      throw std::runtime_error("Repeated-prefix source span search is incorrect");
    store.save({{"id", "host~other"}, {"projectId", "project"}, {"threadId", "thread"}});
    rejects_source([&] { store.history_source("host~other", event.at("seq"), origin); },
                   "CONTENT_UNAVAILABLE");
    sql(path / "envelope",
        "DELETE FROM history; CREATE TEMP TABLE source_check(n INTEGER CHECK(n=0)); "
        "INSERT INTO source_check SELECT COUNT(*) FROM transport2_history_sources; "
        "INSERT INTO source_check SELECT COUNT(*) FROM transport2_history_entries "
        "WHERE key GLOB 'transport2_history_sources:*'");
  }
  Json usage;
  {
    Store store((path / "limited").u8string());
    store.save(
        {{"id", session}, {"projectId", "project"}, {"threadId", "thread"}, {"state", "closed"}});
    const auto event = store.event(session, "item/commandExecution/outputDelta",
                                   {{"turnId", "turn"}, {"itemId", "item"}, {"delta", "原输出🙂"}});
    seq = event.at("seq");
    usage = store.history_budget().at("global");
  }
  {
    Store store((path / "limited").u8string(), true, "",
                {{"maxBytes", usage.at("bytes")},
                 {"maxSessionBytes", usage.at("bytes")},
                 {"minFreeDiskBytes", 1}});
    bool failed = false;
    store.on_failure([&] { failed = true; });
    rejects_source([&] { store.history_source_register(session, seq, origin, entry); },
                   "BACKPRESSURE");
    if (failed || store.history_budget().at("global") != usage)
      throw std::runtime_error(
          "Optional mapping capacity refusal caused storage failure or growth");
  }
}
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
               const std::string &expected, bool bound = false) {
  asio::io_context io;
  const auto root = std::filesystem::temp_directory_path() / ("coc-source-read-" + uuid());
  const auto cwd = bound ? root.u8string() : std::filesystem::current_path().u8string();
  const auto home = root / ".codex";
  if (bound) {
    std::filesystem::create_directories(home);
    std::ofstream(home / "session.jsonl") << "initial";
  }
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
    if (bound)
      read_history_source(process, home, thread, cwd, "turn", item, limit, done,
                          thread == "wrong-origin" ? Json{{"environment", "wrong"}} : Json());
    else
      read_history_item(process, thread, cwd, "turn", item, limit, done);
  });
  io.run();
  if (bound) {
    std::filesystem::remove_all(root);
    if (failure.is_null()) {
      if (result.at("origin").at("environment").get<std::string>().size() != 64)
        throw std::runtime_error("Missing source identity");
      result = result.at("entry").get<Json>();
    }
  }
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
    origin_cases();
    durable_source_cases();
    projection_cases();
    read_case("normal", "ok", 4096, "");
    for (const auto *thread : {"normal", "source-append", "source-archive"})
      read_case(thread, "ok", 4096, "", true);
    read_case("source-replace", "ok", 4096, "DELIVERY_STATE_MISMATCH", true);
    read_case("wrong-origin", "ok", 4096, "DELIVERY_STATE_MISMATCH", true);
    read_case("no-path", "ok", 4096, "CONTENT_UNAVAILABLE", true);
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
