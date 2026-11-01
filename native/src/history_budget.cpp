#include "coc/credit.hpp"
#include "coc/store.hpp"
#include <vector>
namespace coc {
namespace {
struct HistoryResource {
  std::string table, key, session, bytes;
};
std::string columns(std::string expression, const std::string &alias) {
  size_t offset = 0;
  while ((offset = expression.find('$', offset)) != std::string::npos) {
    expression.replace(offset, 1, alias + ".");
    offset += alias.size() + 1;
  }
  return expression;
}
} // namespace
void Store::history_budget_init() {
  run("CREATE TABLE IF NOT EXISTS transport2_history_budget(scope TEXT PRIMARY KEY,bytes "
      "INTEGER NOT NULL DEFAULT 0,records INTEGER NOT NULL DEFAULT 0)");
  run("CREATE TABLE IF NOT EXISTS transport2_history_entries(key TEXT PRIMARY KEY,session TEXT "
      "NOT NULL,bytes INTEGER NOT NULL)");
  run("CREATE TABLE IF NOT EXISTS transport2_history_meta(id INTEGER PRIMARY KEY CHECK(id=1))");
  run("INSERT OR IGNORE INTO transport2_history_budget VALUES('@global',0,0)");
  run("CREATE TRIGGER IF NOT EXISTS transport2_history_charge AFTER INSERT ON "
      "transport2_history_entries BEGIN "
      "INSERT INTO transport2_history_budget(scope) SELECT NEW.session WHERE NOT EXISTS "
      "(SELECT 1 FROM transport2_history_budget WHERE scope=NEW.session); "
      "UPDATE transport2_history_budget SET bytes=bytes+NEW.bytes,records=records+1 "
      "WHERE scope IN('@global',NEW.session); END");
  run("CREATE TRIGGER IF NOT EXISTS transport2_history_resize AFTER UPDATE ON "
      "transport2_history_entries BEGIN "
      "INSERT INTO transport2_history_budget(scope) SELECT NEW.session WHERE NOT EXISTS "
      "(SELECT 1 FROM transport2_history_budget WHERE scope=NEW.session); "
      "UPDATE transport2_history_budget SET bytes=bytes "
      "+CASE WHEN scope IN('@global',NEW.session) THEN NEW.bytes ELSE 0 END "
      "-CASE WHEN scope IN('@global',OLD.session) THEN OLD.bytes ELSE 0 END,"
      "records=records+CASE WHEN scope IN('@global',NEW.session) THEN 1 ELSE 0 END "
      "-CASE WHEN scope IN('@global',OLD.session) THEN 1 ELSE 0 END "
      "WHERE scope IN('@global',OLD.session,NEW.session); "
      "DELETE FROM transport2_history_budget WHERE scope!='@global' AND records=0; END");
  run("CREATE TRIGGER IF NOT EXISTS transport2_history_refund AFTER DELETE ON "
      "transport2_history_entries BEGIN "
      "UPDATE transport2_history_budget SET bytes=bytes-OLD.bytes,records=records-1 "
      "WHERE scope IN('@global',OLD.session); "
      "DELETE FROM transport2_history_budget WHERE scope!='@global' AND records=0; END");
  const std::string body_session = "COALESCE((SELECT session FROM history WHERE seq=$seq),"
                                   "(SELECT session FROM events WHERE seq=$seq),'@orphan')";
  const std::vector<HistoryResource> resources = {
      {"events", "json_array($seq)", "$session", "length(CAST($value AS BLOB))"},
      {"history", "json_array($seq)", "$session", "length(CAST($value AS BLOB))"},
      {"chunks", "json_array($seq,$start)", body_session, "length(CAST($text AS BLOB))"},
      {"bodies", "json_array($seq)", body_session, "0"},
      {"streams", "json_array($session,$key)", "$session", "length(CAST($key AS BLOB))"},
      {"external_items", "json_array($session,$turn,$item)", "$session",
       "length(CAST($fingerprint AS BLOB))+length(CAST($turn AS BLOB))+"
       "length(CAST($item AS BLOB))"}};
  const bool bootstrap = query("SELECT id FROM transport2_history_meta").empty();
  for (const auto &resource : resources) {
    const auto key = "'" + resource.table + ":'||" + resource.key;
    // Account copies and indexes separately, including the accounting record
    // itself. Protocol UTF-8 end positions are never used as disk accounting.
    const auto cost = resource.bytes + "+2048+6*length(CAST((" + key +
                      ") AS BLOB))+6*length(CAST((" + resource.session + ") AS BLOB))";
    const auto insert =
        "INSERT INTO transport2_history_entries VALUES(" + columns(key, "NEW") + "," +
        columns(resource.session, "NEW") + "," + columns(cost, "NEW") +
        ") "
        "ON CONFLICT(key) DO UPDATE SET session=excluded.session,bytes=excluded.bytes; ";
    run("CREATE TRIGGER IF NOT EXISTS transport2_history_" + resource.table +
        "_insert AFTER INSERT ON " + resource.table + " BEGIN " + insert + "END");
    run("CREATE TRIGGER IF NOT EXISTS transport2_history_" + resource.table +
        "_update AFTER UPDATE ON " + resource.table +
        " BEGIN "
        "DELETE FROM transport2_history_entries WHERE key=" +
        columns(key, "OLD") + " AND " + columns(key, "OLD") + "!=" + columns(key, "NEW") + "; " +
        insert + "END");
    run("CREATE TRIGGER IF NOT EXISTS transport2_history_" + resource.table +
        "_delete AFTER DELETE ON " + resource.table +
        " BEGIN "
        "DELETE FROM transport2_history_entries WHERE key=" +
        columns(key, "OLD") + "; END");
    if (bootstrap)
      run("INSERT OR IGNORE INTO transport2_history_entries SELECT " + columns(key, "t") + "," +
          columns(resource.session, "t") + "," + columns(cost, "t") + " FROM " + resource.table +
          " AS t");
  }
  // Install limits after importing existing authoritative data: a large old
  // history remains readable and can shrink, but cannot acquire more capacity.
  run("CREATE TRIGGER IF NOT EXISTS transport2_history_capacity BEFORE UPDATE ON "
      "transport2_history_budget WHEN NEW.bytes>OLD.bytes OR NEW.records>OLD.records BEGIN "
      "SELECT CASE WHEN NEW.bytes>CASE WHEN NEW.scope='@global' THEN " +
      std::to_string(credit::history_budget) + " ELSE " + std::to_string(credit::history_session) +
      " END OR NEW.records>CASE WHEN NEW.scope='@global' THEN " +
      std::to_string(credit::history_records) + " ELSE " +
      std::to_string(credit::history_session_records) +
      " END THEN RAISE(ABORT,'COC_HISTORY_CAPACITY') END; END");
  run("CREATE TRIGGER IF NOT EXISTS transport2_history_scopes BEFORE INSERT ON "
      "transport2_history_budget WHEN NEW.scope!='@global' AND NOT EXISTS "
      "(SELECT 1 FROM transport2_history_budget WHERE scope=NEW.scope) BEGIN "
      "SELECT CASE WHEN (SELECT COUNT(*) FROM transport2_history_budget WHERE "
      "scope!='@global')>=" +
      std::to_string(credit::history_scopes) +
      " THEN RAISE(ABORT,'COC_HISTORY_CAPACITY') END; END");
  run("INSERT OR IGNORE INTO transport2_history_meta VALUES(1)");
}
Json Store::history_budget() {
  return {{"globalLimit", credit::history_budget},
          {"sessionLimit", credit::history_session},
          {"recordLimit", credit::history_records},
          {"sessionRecordLimit", credit::history_session_records},
          {"scopeLimit", credit::history_scopes},
          {"global", query("SELECT bytes,records FROM transport2_history_budget WHERE "
                           "scope='@global'")
                         .at(0)},
          {"sessions", query("SELECT scope AS session,bytes,records FROM "
                             "transport2_history_budget WHERE scope!='@global' ORDER BY scope")}};
}
} // namespace coc
