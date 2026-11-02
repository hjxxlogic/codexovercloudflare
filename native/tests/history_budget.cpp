#include "coc/credit.hpp"
#include "coc/store.hpp"
#include <iostream>
using namespace coc;
namespace {
void check(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class F> void backpressure(F fn) {
  try {
    fn();
  } catch (const Error &error) {
    check(error.code == "BACKPRESSURE", error.what());
    return;
  }
  throw std::runtime_error("Expected history backpressure");
}
struct Temp {
  std::string path = (std::filesystem::temp_directory_path() / ("coc-history-" + uuid())).string();
  ~Temp() { std::filesystem::remove_all(path); }
};
struct Database {
  sqlite3 *db = nullptr;
  explicit Database(const std::string &dir) {
    check(sqlite3_open((dir + "/agent.db").c_str(), &db) == SQLITE_OK, "Open fixture database");
  }
  ~Database() { sqlite3_close(db); }
  void sql(const std::string &value) {
    check(sqlite3_exec(db, value.c_str(), nullptr, nullptr, nullptr) == SQLITE_OK,
          sqlite3_errmsg(db));
  }
  void legacy_schema() {
    sqlite3_stmt *query = nullptr;
    sqlite3_prepare_v2(db,
                       "SELECT name FROM sqlite_master WHERE type='trigger' AND "
                       "name LIKE 'transport2_history_%'",
                       -1, &query, nullptr);
    std::vector<std::string> names;
    while (sqlite3_step(query) == SQLITE_ROW)
      names.emplace_back(reinterpret_cast<const char *>(sqlite3_column_text(query, 0)));
    sqlite3_finalize(query);
    for (const auto &name : names)
      sql("DROP TRIGGER " + name);
    sql("DROP TABLE transport2_history_entries");
    sql("DROP TABLE transport2_history_budget");
    sql("DROP TABLE transport2_history_meta");
  }
};
void configurable_policy() {
  for (const auto &fixture :
       read_json(std::filesystem::path(COC_SOURCE_DIR) / "tests/history-policy-fixtures.json")) {
    bool valid = true;
    try {
      history_storage_config(fixture.at("input"));
    } catch (const Error &error) {
      check(error.code == "CONFIG_ERROR", "Policy error category");
      valid = false;
    }
    check(valid == fixture.at("valid").get<bool>(), fixture.at("name").get<std::string>().c_str());
  }
  Temp temp;
  Json policy = {{"maxBytes", 32768},
                 {"maxSessionBytes", 16384},
                 {"maxRecords", 20},
                 {"maxSessionRecords", 10}};
  Json before;
  {
    Store journal(temp.path, true, "", policy);
    journal.save({{"id", "one"}, {"state", "closed"}});
    journal.event("one", "record", "small");
    before = journal.history_budget();
    Store auxiliary(temp.path, false);
    check(auxiliary.history_budget() == before, "Auxiliary store preserves configured policy");
    backpressure([&] { journal.event("one", "record", std::string(20000, 'x')); });
  }
  {
    Database fixture(temp.path);
    fixture.sql("CREATE TRIGGER history_policy_fault BEFORE INSERT ON transport2_history_policy "
                "BEGIN SELECT RAISE(ABORT,'injected policy failure'); END");
  }
  bool rejected = false;
  try {
    Store failed(temp.path, true, "", {{"maxBytes", 131072}, {"maxSessionBytes", 65536}});
  } catch (const Error &) {
    rejected = true;
  }
  check(rejected, "Injected policy migration failure is reported");
  {
    Database fixture(temp.path);
    fixture.sql("DROP TRIGGER history_policy_fault");
  }
  {
    Store unchanged(temp.path, false);
    check(unchanged.history_budget() == before,
          "Failed policy transaction preserves quota and ledger");
  }
  policy["maxBytes"] = 262144;
  policy["maxSessionBytes"] = 131072;
  {
    Store raised(temp.path, true, "", policy);
    raised.event("one", "record", std::string(20000, 'x'));
    check(raised.history_budget()["global"]["bytes"] > before["global"]["bytes"],
          "Changed JSON replaces existing database trigger quota");
    before = raised.history_budget();
  }
  policy["maxBytes"] = 4096;
  policy["maxSessionBytes"] = 4096;
  {
    Store lowered(temp.path, true, "", policy);
    check(lowered.history_budget()["global"] == before["global"] &&
              lowered.history("one")["events"].size() == 2,
          "Lower quota preserves existing authority and reads");
    bool storage_failure = false;
    lowered.on_failure([&] { storage_failure = true; });
    backpressure([&] { lowered.history_require_capacity("one", 4096, 2); });
    check(!storage_failure, "Pre-execution capacity rejection does not stop the Agent");
    backpressure([&] { lowered.event("one", "record", "extra"); });
    check(lowered.history_budget()["global"] == before["global"], "Rejected growth is atomic");
  }
}
void durable_reservations() {
  Temp temp;
  const Json policy = {{"maxBytes", 32768}, {"maxSessionBytes", 32768}, {"minFreeDiskBytes", 1}};
  Json saved;
  {
    Store journal(temp.path, true, "", policy);
    journal.history_reserve("one", 20000);
    saved = journal.history_budget();
    journal.history_reserve("one", 4096);
    check(journal.history_budget() == saved, "Repeated admission never shrinks a promise");
    bool failed = false;
    journal.on_failure([&] { failed = true; });
    backpressure([&] { journal.history_reserve("two", 20000); });
    check(!failed && journal.history_budget() == saved,
          "Concurrent session reservation cannot oversubscribe or stop the Agent");
    journal.save({{"id", "two"}, {"state", "closed"}});
    backpressure([&] { journal.event("two", "record", std::string(10000, 'x')); });
    check(journal.history_budget() == saved, "Unreserved writes cannot steal promised space");
  }
  {
    Store journal(temp.path, true, "", policy);
    check(journal.history_budget() == saved, "Crash/reopen retains unused promises");
    journal.history_release("one");
    journal.history_release("one");
    check(journal.history_budget()["global"]["bytes"] == 0 &&
              journal.history_budget()["global"]["records"] == 0,
          "Explicit safe retirement refunds reservation exactly once");
    journal.history_reserve("two", 20000);
  }
}
void reservation_conversion() {
  Temp temp;
  Json checkpoint;
  const Json policy = {{"maxBytes", 65536}, {"maxSessionBytes", 65536}, {"minFreeDiskBytes", 1}};
  {
    Store journal(temp.path, true, "", policy);
    journal.save({{"id", "one"}, {"state", "closed"}});
    journal.history_reserve("one", 60000);
    const auto start = journal.history_budget();
    journal.event("one", "item/agentMessage/delta", {{"itemId", "a"}, {"delta", "你好"}});
    journal.event("one", "item/agentMessage/delta", {{"itemId", "a"}, {"delta", " world"}});
    check(journal.history_budget()["global"]["bytes"] == start["global"]["bytes"],
          "Raw events, projection and chunk growth consume reserved bytes exactly once");
    checkpoint = journal.history_budget();
    const auto page = journal.history("one");
    backpressure([&] { journal.event("one", "record", std::string(60000, 'x')); });
    check(journal.history_budget() == checkpoint && journal.history("one") == page,
          "Failure after consuming a reservation rolls back promise and body together");
  }
  {
    Store journal(temp.path, true, "", policy);
    check(journal.history_budget() == checkpoint, "Converted reservation survives restart");
    journal.history_release("one");
    const auto actual = journal.history_budget()["global"]["bytes"].get<int64_t>();
    check(actual > 0 && actual < 60000,
          "Retirement only refunds unused bytes, retaining actual body");
    journal.history_release("one");
    check(journal.history_budget()["global"]["bytes"] == actual,
          "Retirement cannot refund body twice");
  }
}
void record_reservations() {
  Temp temp;
  const Json policy = {{"maxBytes", 65536},
                       {"maxSessionBytes", 65536},
                       {"maxRecords", 8},
                       {"maxSessionRecords", 8},
                       {"minFreeDiskBytes", 1}};
  Json saved;
  {
    Store journal(temp.path, true, "", policy);
    journal.save({{"id", "one"}, {"state", "closed"}});
    journal.history_reserve("one", 40000, 8);
    saved = journal.history_budget();
    backpressure([&] { journal.history_reserve("two", 4096, 1); });
    check(journal.history_budget() == saved, "Record promises prevent another session admission");
    for (int n = 0; n < 4; ++n) {
      journal.event("one", "record", "small");
      check(journal.history_budget()["global"]["records"] == 8,
            "Each event and projection consume promised record capacity");
    }
    saved = journal.history_budget();
    backpressure([&] { journal.event("one", "record", "overflow"); });
    check(journal.history_budget() == saved,
          "Record overflow rolls back byte and record consumption");
  }
  {
    Store journal(temp.path, true, "", policy);
    check(journal.history_budget() == saved, "Record promises and consumption survive restart");
    journal.history_release("one");
    check(journal.history_budget()["global"]["records"] == 8,
          "Refunding leftover bytes cannot refund already consumed records");
  }
}
void accounting() {
  Temp temp;
  Json saved;
  {
    Store journal(temp.path);
    journal.save({{"id", "session"}, {"state", "closed"}, {"running", false}});
    journal.event("session", "item/agentMessage/delta",
                  {{"itemId", "one"}, {"delta", std::string(20000, 'x')}});
    const auto first = journal.history_budget();
    journal.event("session", "item/agentMessage/delta", {{"itemId", "one"}, {"delta", "tail"}});
    check(journal.history_budget()["global"]["bytes"] > first["global"]["bytes"],
          "Append charges raw event, chunk and projection metadata");
    Json item = {{"id", "external"}, {"type", "agentMessage"}, {"text", std::string(65536, 'y')}};
    journal.external_item("session", "turn", item);
    const auto large = journal.history_budget();
    check(journal.external_item("session", "turn", item).is_null() &&
              journal.history_budget() == large,
          "Duplicate external history does not acquire capacity twice");
    item["text"] = "replacement";
    journal.external_item("session", "turn", item);
    check(journal.history_budget()["global"]["bytes"] < large["global"]["bytes"],
          "Replacement refunds old chunks while retaining original events");
    saved = journal.history_budget();
    journal.cache_clear();
    journal.cleanup();
    check(journal.history_budget() == saved,
          "Ordinary cache cleanup retains authoritative history");
  }
  {
    Store restored(temp.path);
    check(restored.history_budget() == saved,
          "Restart recovers the exact persisted history ledger");
  }
  {
    Database fixture(temp.path);
    fixture.legacy_schema();
  }
  {
    Store imported(temp.path);
    check(imported.history_budget() == saved, "Bootstrap accounts existing events and chunks once");
    Database fixture(temp.path);
    // Simulate explicit offline removal, in an order that loses source lookup
    // information. Refunds must use the original accounting entry's scope.
    fixture.sql("BEGIN");
    for (const auto &table : {"events", "history", "chunks", "bodies", "external_items", "streams"})
      fixture.sql(std::string("DELETE FROM ") + table);
    fixture.sql("COMMIT");
    const auto empty = imported.history_budget();
    check(empty["global"]["bytes"] == 0 && empty["global"]["records"] == 0 &&
              empty["sessions"].empty(),
          "Removal refunds all body, index and scope records without orphan accounting");
  }
}
void capacity() {
  Temp temp;
  Store journal(temp.path);
  bool stopped = false;
  journal.on_failure([&] { stopped = true; });
  const std::string text(1024 * 1024, 'x');
  size_t first_count = 0, last_count = 0;
  for (size_t scope = 0; scope < 5; ++scope) {
    const auto session = "scope-" + std::to_string(scope);
    journal.save({{"id", session}, {"state", "closed"}, {"running", false}});
    size_t count = 0;
    for (; count < 40; ++count) {
      const auto before = journal.history_budget();
      const auto revision = journal.history(session).at("snapshotSeq");
      try {
        stopped = false;
        journal.event(session, "record", {{"text", text}});
      } catch (const Error &error) {
        check(error.code == "BACKPRESSURE", error.what());
        check(stopped, "History exhaustion invokes the Agent's stop-side-effects callback");
        check(journal.history_budget() == before &&
                  journal.history(session).at("snapshotSeq") == revision,
              "Rejected event rolls back body, ledger, projection and published revision");
        break;
      }
    }
    check(count > 0 && count < 40, "Finite real byte quota stops history growth");
    if (!scope)
      first_count = count;
    last_count = count;
  }
  const auto full = journal.history_budget();
  check(last_count < first_count && full["global"]["bytes"] <= credit::history_budget,
        "Additional sessions cannot multiply the global history budget");
  for (const auto &scope : full["sessions"])
    check(scope["bytes"] <= credit::history_session, "Session history stays within its quota");
  // Terminal/control records have separately reserved capacity even when
  // historical output cannot grow. No old output is deleted to make room.
  journal.delivery_open("emergency", "scope-0", 4, 512 * 1024, "priority");
  journal.delivery_receive("emergency", 1, 2, "{}");
  journal.delivery_finish("emergency", 1, {{"error", "BACKPRESSURE"}});
  check(journal.delivery_results("emergency", 0).size() == 1,
        "History exhaustion does not consume reserved terminal result capacity");
  check(journal.history_budget() == full, "Control result does not change authoritative history");
}
void namespaces() {
  Temp temp;
  Store journal(temp.path);
  for (int i = 0; i < credit::history_scopes; ++i)
    journal.event("scope-" + std::to_string(i), "record", "small");
  const auto full = journal.history_budget();
  journal.save({{"id", "overflow"}, {"state", "closed"}, {"running", false}});
  backpressure([&] { journal.archive_event("overflow", "record", "must not survive"); });
  check(journal.history_budget() == full && journal.history("overflow")["events"].empty(),
        "Scope exhaustion atomically refuses standalone archive writes");
  journal.event("scope-0", "record", "existing scope remains usable");
}
void oversized_legacy() {
  Temp temp;
  {
    Store journal(temp.path);
    journal.save({{"id", "legacy"}, {"state", "closed"}, {"running", false}});
  }
  {
    Database fixture(temp.path);
    fixture.legacy_schema();
    const auto value =
        Json{{"type", "record"}, {"data", std::string(12 * 1024 * 1024, 'x')}, {"time", 1}}.dump();
    for (int seq = 1; seq <= 3; ++seq) {
      const auto prefix = std::to_string(seq) + ",'legacy','" + value + "',";
      fixture.sql("INSERT INTO events VALUES(" + prefix + "1)");
      fixture.sql("INSERT INTO history VALUES(" + prefix + std::to_string(seq) + ")");
    }
  }
  Store journal(temp.path);
  const auto imported = journal.history_budget();
  check(imported["sessions"][0]["bytes"] > credit::history_session &&
            !journal.history("legacy")["events"].empty(),
        "Existing oversized authority remains available after accounting bootstrap");
  backpressure([&] { journal.event("legacy", "record", "no new capacity"); });
  check(journal.history_budget() == imported, "Import never silently deletes or forgives history");
}
} // namespace
int main() {
  try {
    configurable_policy();
    durable_reservations();
    reservation_conversion();
    record_reservations();
    accounting();
    capacity();
    namespaces();
    oversized_legacy();
    std::cout << "PASS: authoritative history accounting, real global/session quotas, atomic "
                 "rollback, control capacity, namespace bounds, replacement/refunds and legacy "
                 "bootstrap\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "FAIL: " << error.what() << '\n';
    return 1;
  }
}
