#include "coc/credit.hpp"
#include "coc/history_projection.hpp"
#include "coc/store.hpp"
#include <vector>
namespace coc {
namespace {
std::string reservation_key(const std::string &session, const std::string &owner) {
  if (owner.size() > 128)
    throw Error("INVALID_REQUEST", "Invalid history reservation owner");
  if (owner == "runtime-terminal")
    return "control-reservation:" + session;
  return "reservation:" + (owner.empty() ? session : Json::array({session, owner}).dump());
}
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
void Store::history_budget_init(bool authoritative) {
  run("CREATE TABLE IF NOT EXISTS transport2_history_policy(id INTEGER PRIMARY KEY CHECK(id=1),"
      "value TEXT NOT NULL)");
  if (authoritative)
    run("INSERT OR REPLACE INTO transport2_history_policy VALUES(1,?)", {history_policy_.dump()});
  else
    run("INSERT OR IGNORE INTO transport2_history_policy VALUES(1,?)", {history_policy_.dump()});
  // Auxiliary file stores must never replace the running Agent's policy with defaults.
  history_policy_ = history_storage_config(
      Json::parse(query("SELECT value FROM transport2_history_policy WHERE id=1")
                      .at(0)
                      .at("value")
                      .get<std::string>()));
  const auto limit = [](const std::string &key) {
    return "(SELECT json_extract(value,'$." + key + "') FROM transport2_history_policy WHERE id=1)";
  };
  run("CREATE TABLE IF NOT EXISTS transport2_history_budget(scope TEXT PRIMARY KEY,bytes "
      "INTEGER NOT NULL DEFAULT 0,records INTEGER NOT NULL DEFAULT 0)");
  run("CREATE TABLE IF NOT EXISTS transport2_history_entries(key TEXT PRIMARY KEY,session TEXT "
      "NOT NULL,bytes INTEGER NOT NULL)");
  bool has_records = false;
  for (const auto &column : query("PRAGMA table_info(transport2_history_entries)"))
    has_records = has_records || column.at("name") == "records";
  if (!has_records)
    run("ALTER TABLE transport2_history_entries ADD COLUMN records INTEGER NOT NULL DEFAULT 1");
  run("CREATE INDEX IF NOT EXISTS transport2_history_reservations ON "
      "transport2_history_entries(session) WHERE key GLOB 'reservation:*'");
  // Replace old trigger SQL in the enclosing schema transaction, including old
  // positional INSERTs which would otherwise break after adding the column.
  for (const auto &trigger : query("SELECT name FROM sqlite_master WHERE type='trigger' "
                                   "AND name GLOB 'transport2_history_*'")) {
    const auto name = trigger.at("name").get<std::string>();
    if (name.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_") != std::string::npos)
      throw Error("STORAGE_ERROR", "Invalid history trigger identifier");
    run("DROP TRIGGER " + name);
  }
  run("CREATE TABLE IF NOT EXISTS transport2_history_meta(id INTEGER PRIMARY KEY CHECK(id=1),"
      "archive_seq INTEGER NOT NULL DEFAULT 0 CHECK(archive_seq BETWEEN -9007199254740991 AND 0))");
  bool has_archive_sequence = false;
  for (const auto &column : query("PRAGMA table_info(transport2_history_meta)"))
    has_archive_sequence = has_archive_sequence || column.at("name") == "archive_seq";
  if (!has_archive_sequence) {
    run("ALTER TABLE transport2_history_meta ADD COLUMN archive_seq INTEGER NOT NULL DEFAULT 0 "
        "CHECK(archive_seq BETWEEN -9007199254740991 AND 0)");
    run("UPDATE transport2_history_meta SET archive_seq=(SELECT MIN(0,COALESCE(MIN(seq),0)) "
        "FROM (SELECT seq FROM history UNION ALL SELECT seq FROM events))");
  }
  const bool migrate_heads = query("SELECT name FROM sqlite_master WHERE type='table' "
                                   "AND name='transport2_history_heads'")
                                 .empty();
  run("CREATE TABLE IF NOT EXISTS transport2_history_heads(session TEXT PRIMARY KEY,"
      "revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991))");
  bool migrate_coverage = false;
  for (const auto *field : {"retired_revision", "generation"}) {
    bool exists = false;
    for (const auto &column : query("PRAGMA table_info(transport2_history_heads)"))
      exists = exists || column.at("name") == field;
    if (!exists) {
      run(std::string("ALTER TABLE transport2_history_heads ADD COLUMN ") + field +
          " INTEGER NOT NULL DEFAULT 0 CHECK(" + field + " BETWEEN 0 AND 9007199254740991)");
      migrate_coverage = true;
    }
  }
  run("INSERT OR IGNORE INTO transport2_history_budget VALUES('@global',0,0)");
  run("CREATE TRIGGER IF NOT EXISTS transport2_history_charge AFTER INSERT ON "
      "transport2_history_entries BEGIN "
      "INSERT INTO transport2_history_budget(scope) SELECT NEW.session WHERE NOT EXISTS "
      "(SELECT 1 FROM transport2_history_budget WHERE scope=NEW.session); "
      "UPDATE transport2_history_budget SET bytes=bytes+NEW.bytes,records=records+NEW.records "
      "WHERE scope IN('@global',NEW.session); END");
  run("CREATE TRIGGER IF NOT EXISTS transport2_history_resize AFTER UPDATE ON "
      "transport2_history_entries BEGIN "
      "INSERT INTO transport2_history_budget(scope) SELECT NEW.session WHERE NOT EXISTS "
      "(SELECT 1 FROM transport2_history_budget WHERE scope=NEW.session); "
      "UPDATE transport2_history_budget SET bytes=bytes "
      "+CASE WHEN scope IN('@global',NEW.session) THEN NEW.bytes ELSE 0 END "
      "-CASE WHEN scope IN('@global',OLD.session) THEN OLD.bytes ELSE 0 END,"
      "records=records+CASE WHEN scope IN('@global',NEW.session) THEN NEW.records ELSE 0 END "
      "-CASE WHEN scope IN('@global',OLD.session) THEN OLD.records ELSE 0 END "
      "WHERE scope IN('@global',OLD.session,NEW.session); "
      "DELETE FROM transport2_history_budget WHERE scope!='@global' AND records=0 AND bytes=0; "
      "END");
  run("CREATE TRIGGER IF NOT EXISTS transport2_history_refund AFTER DELETE ON "
      "transport2_history_entries BEGIN "
      "UPDATE transport2_history_budget SET bytes=bytes-OLD.bytes,records=records-OLD.records "
      "WHERE scope IN('@global',OLD.session); "
      "DELETE FROM transport2_history_budget WHERE scope!='@global' AND records=0 AND bytes=0; "
      "END");
  // Consume the promise before charging actual bytes, inside the caller's write
  // transaction. An UPSERT consumes only its growth, not its full size twice.
  const auto consume = [](const std::string &amount, const std::string &records) {
    return "UPDATE transport2_history_entries SET bytes=MAX(0,bytes-(" + amount +
           ")),records=MAX(0,records-(" + records +
           ")) WHERE key='reservation:'||NEW.session; "
           "DELETE FROM transport2_history_entries WHERE key='reservation:'||NEW.session "
           "AND bytes=0 AND records=0; ";
  };
  run("CREATE TRIGGER IF NOT EXISTS transport2_history_consume_insert BEFORE INSERT ON "
      "transport2_history_entries WHEN NEW.key NOT GLOB 'reservation:*' AND NEW.key NOT GLOB "
      "'control-reservation:*' AND NOT EXISTS "
      "(SELECT 1 FROM transport2_history_entries WHERE key=NEW.key) BEGIN " +
      consume("NEW.bytes", "NEW.records") + "END");
  run("CREATE TRIGGER IF NOT EXISTS transport2_history_consume_update BEFORE UPDATE ON "
      "transport2_history_entries WHEN NEW.key NOT GLOB 'reservation:*' AND NEW.key NOT GLOB "
      "'control-reservation:*' AND "
      "(NEW.bytes>OLD.bytes OR NEW.records>OLD.records OR NEW.session!=OLD.session) BEGIN " +
      consume(
          "CASE WHEN NEW.session=OLD.session THEN MAX(0,NEW.bytes-OLD.bytes) ELSE NEW.bytes END",
          "CASE WHEN NEW.session=OLD.session THEN MAX(0,NEW.records-OLD.records) ELSE NEW.records "
          "END") +
      "END");
  const std::string body_session = "COALESCE((SELECT session FROM history WHERE seq=$seq),"
                                   "(SELECT session FROM events WHERE seq=$seq),'@orphan')";
  const std::vector<HistoryResource> resources = {
      {"transport2_history_heads", "json_array($session)", "$session", "24"},
      {"events", "json_array($seq)", "$session", "length(CAST($value AS BLOB))"},
      {"history", "json_array($seq)", "$session",
       "length(CAST($value AS BLOB))+COALESCE((SELECT length(CAST(recovery AS BLOB)) FROM history "
       "WHERE seq=$seq),0)"},
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
        "INSERT INTO transport2_history_entries(key,session,bytes) VALUES(" + columns(key, "NEW") +
        "," + columns(resource.session, "NEW") + "," + columns(cost, "NEW") +
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
      run("INSERT OR IGNORE INTO transport2_history_entries(key,session,bytes) SELECT " +
          columns(key, "t") + "," + columns(resource.session, "t") + "," + columns(cost, "t") +
          " FROM " + resource.table + " AS t");
  }
  if (migrate_heads)
    run("INSERT INTO transport2_history_heads(session,revision) SELECT "
        "session,MAX(0,MAX(revision)) "
        "FROM history GROUP BY session");
  if (migrate_coverage)
    run("UPDATE transport2_history_heads SET revision=revision");
  for (const auto *action : {"insert", "update"})
    run(std::string("CREATE TRIGGER transport2_history_head_") + action + " AFTER " + action +
        " ON history BEGIN INSERT INTO "
        "transport2_history_heads(session,revision,retired_revision,generation) "
        "VALUES(NEW.session,MAX(0,NEW.revision,COALESCE((SELECT "
        "json_extract(value,'$.historyCoverage.revision') FROM sessions WHERE id=NEW.session),0)),"
        "COALESCE((SELECT json_extract(value,'$.historyCoverage.retired_revision') "
        "FROM sessions WHERE id=NEW.session),0),COALESCE((SELECT "
        "json_extract(value,'$.historyCoverage.generation') FROM sessions WHERE "
        "id=NEW.session),0)) "
        "ON CONFLICT(session) DO UPDATE SET "
        "revision=excluded.revision WHERE excluded.revision>revision; END");
  // Source identity belongs to the session; recovery spans belong to the
  // original history row. Neither needs a second content-ID mapping table.
  const std::string source_key = "'sessions-source:'||json_array(NEW.id)";
  const std::string source_cost =
      "(SELECT length(CAST(source AS BLOB)) FROM sessions WHERE id=NEW.id)+2048+6*length(CAST((" +
      source_key + ") AS BLOB))+6*length(CAST(NEW.id AS BLOB))";
  const auto source_charge =
      "INSERT INTO transport2_history_entries(key,session,bytes) SELECT " + source_key +
      ",NEW.id," + source_cost +
      " WHERE EXISTS(SELECT 1 FROM sessions WHERE id=NEW.id AND source IS NOT NULL) "
      "ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes; "
      "DELETE FROM transport2_history_entries WHERE key=" +
      source_key +
      " AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.id AND source IS NOT NULL); ";
  for (const auto *action : {"insert", "update"})
    run(std::string("CREATE TRIGGER transport2_history_session_source_") + action + " AFTER " +
        action + " ON sessions BEGIN " + source_charge + "END");
  if (bootstrap)
    run("INSERT OR IGNORE INTO transport2_history_entries(key,session,bytes) "
        "SELECT 'sessions-source:'||json_array(id),id,length(CAST(source AS BLOB))+2048+"
        "6*length(CAST(('sessions-source:'||json_array(id)) AS BLOB))+6*length(CAST(id AS BLOB)) "
        "FROM sessions WHERE source IS NOT NULL");
  run("CREATE TRIGGER transport2_history_session_source_insert_invalidate AFTER INSERT ON sessions "
      "BEGIN UPDATE history SET recovery=NULL WHERE session=NEW.id; END");
  run("CREATE TRIGGER transport2_history_session_source_delete AFTER DELETE ON sessions BEGIN "
      "DELETE FROM transport2_history_entries WHERE key='sessions-source:'||json_array(OLD.id); "
      "UPDATE history SET recovery=NULL WHERE session=OLD.id; END");
  run("CREATE TRIGGER transport2_history_session_source_invalidate AFTER UPDATE OF value ON "
      "sessions "
      "WHEN NEW.source IS NOT NULL AND (json_extract(NEW.value,'$.threadId') IS NOT "
      "json_extract(OLD.value,'$.threadId') OR json_extract(NEW.value,'$.projectId') IS NOT "
      "json_extract(OLD.value,'$.projectId')) BEGIN "
      "UPDATE sessions SET source=NULL WHERE id=NEW.id; "
      "UPDATE history SET recovery=NULL WHERE session=NEW.id; END");
  run("CREATE TRIGGER transport2_history_recovery_invalidate AFTER UPDATE ON history "
      "WHEN NEW.recovery IS NOT NULL AND (NEW.seq!=OLD.seq OR NEW.session!=OLD.session "
      "OR NEW.revision!=OLD.revision OR NEW.value!=OLD.value) BEGIN "
      "UPDATE history SET recovery=NULL WHERE seq=NEW.seq; END");
  // Install limits after importing existing authoritative data: a large old
  // history remains readable and can shrink, but cannot acquire more capacity.
  run("DROP TRIGGER IF EXISTS transport2_history_capacity");
  run("DROP TRIGGER IF EXISTS transport2_history_scopes");
  run("CREATE TRIGGER IF NOT EXISTS transport2_history_capacity BEFORE UPDATE ON "
      "transport2_history_budget WHEN NEW.bytes>OLD.bytes OR NEW.records>OLD.records BEGIN "
      "SELECT CASE WHEN NEW.bytes>CASE WHEN NEW.scope='@global' THEN " +
      limit("maxBytes") + " ELSE " + limit("maxSessionBytes") +
      " END OR NEW.records>CASE WHEN NEW.scope='@global' THEN " + limit("maxRecords") + " ELSE " +
      limit("maxSessionRecords") + " END THEN RAISE(ABORT,'COC_HISTORY_CAPACITY') END; END");
  run("CREATE TRIGGER IF NOT EXISTS transport2_history_scopes BEFORE INSERT ON "
      "transport2_history_budget WHEN NEW.scope!='@global' AND NOT EXISTS "
      "(SELECT 1 FROM transport2_history_budget WHERE scope=NEW.scope) BEGIN "
      "SELECT CASE WHEN (SELECT COUNT(*) FROM transport2_history_budget WHERE "
      "scope!='@global')>=" +
      limit("maxSessions") + " THEN RAISE(ABORT,'COC_HISTORY_CAPACITY') END; END");
  if (bootstrap)
    run("INSERT INTO transport2_history_meta(id,archive_seq) SELECT 1,MIN(0,COALESCE(MIN(seq),0)) "
        "FROM (SELECT seq FROM history UNION ALL SELECT seq FROM events)");
}
void Store::history_retire_next() {
  if (history_policy_.value("retainedRecords", int64_t(0)) == 0)
    return;
  const auto rows = query("SELECT session FROM transport2_history_heads JOIN sessions ON "
                          "sessions.id=session WHERE session>? "
                          "ORDER BY session LIMIT 1",
                          {history_retire_session_});
  if (rows.empty()) {
    history_retire_session_.clear();
    return;
  }
  history_retire_session_ = rows.at(0).at("session").get<std::string>();
  history_retire(history_retire_session_);
}
Json Store::history_retire(const std::string &session) {
  const auto keep = history_policy_.value("retainedRecords", int64_t(0));
  if (keep == 0)
    return {{"retired", 0}};
  run("BEGIN IMMEDIATE");
  try {
    const auto state = get(session);
    // Retirement is history-only. Active or uncertain execution promises remain pinned.
    if (!state.value("external", false) || state.value("running", false) ||
        state.value("state", "") != "closed" ||
        !query("SELECT 1 FROM transport2_history_entries WHERE session=? AND "
               "(key GLOB 'reservation:*' OR key GLOB 'control-reservation:*') LIMIT 1",
               {session})
             .empty()) {
      run("COMMIT");
      return {{"retired", 0}};
    }
    const auto releases = query("SELECT COUNT(*) AS readers,MIN(released) AS released FROM "
                                "transport2_history_subscriptions WHERE session=?",
                                {session})
                              .at(0);
    if (releases.at("readers") == 0 || releases.at("released") == 0) {
      run("COMMIT");
      return {{"retired", 0}};
    }
    const auto candidates =
        query("SELECT seq,revision FROM history WHERE session=? AND revision<=? AND seq NOT IN "
              "(SELECT seq FROM history WHERE session=? ORDER BY revision DESC,seq DESC LIMIT ?) "
              "ORDER BY revision,seq LIMIT 128",
              {session, releases.at("released"), session, keep});
    int64_t floor = 0;
    for (const auto &row : candidates) {
      const auto seq = row.at("seq");
      floor = std::max(floor, row.at("revision").get<int64_t>());
      for (const auto *table : {"chunks", "bodies", "streams", "external_items"})
        run(std::string("DELETE FROM ") + table + " WHERE seq=?", {seq});
      run("DELETE FROM events WHERE session=? AND seq=?", {session, seq});
      run("DELETE FROM history WHERE session=? AND seq=?", {session, seq});
    }
    if (!candidates.empty())
      run("UPDATE transport2_history_heads SET retired_revision=MAX(retired_revision,?),"
          "generation=generation+1 WHERE session=?",
          {floor, session});
    run("COMMIT");
    return {{"retired", candidates.size()}};
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::history_cache_compact(const Json &verified) {
  const auto policy = history_storage_config(history_policy_);
  const int64_t global_max = policy.at("cacheMaxBytes"),
                session_max = policy.at("cacheMaxSessionBytes");
  const int64_t percent = policy.at("cacheTargetPercent");
  run("BEGIN IMMEDIATE");
  try {
    // The existing ledger remains authoritative. Verified idle chunk copies
    // and inline bodies share this cache subset; descriptors and delivery
    // evidence stay. Inline cache demand counts its original UTF-8 body bytes.
    const std::string eligible =
        " FROM chunks c JOIN history h ON h.seq=c.seq JOIN sessions s ON s.id=h.session "
        "JOIN transport2_history_entries e ON e.key='chunks:'||json_array(c.seq,c.start) "
        "WHERE h.recovery IS NOT NULL AND s.source IS NOT NULL "
        "AND COALESCE(json_extract(s.value,'$.running'),0)=0 AND NOT EXISTS "
        "(SELECT 1 FROM transport2_history_entries WHERE session=h.session AND key GLOB "
        "'reservation:*') ";
    const std::string inline_eligible =
        " FROM history h JOIN sessions s ON s.id=h.session "
        "WHERE h.recovery IS NOT NULL AND s.source IS NOT NULL "
        "AND json_extract(h.value,'$.contentSeq') IS NULL "
        "AND COALESCE(json_extract(s.value,'$.running'),0)=0 AND NOT EXISTS "
        "(SELECT 1 FROM transport2_history_entries WHERE session=h.session "
        "AND key GLOB 'reservation:*') ";
    const auto usage =
        query("SELECT session,SUM(bytes) AS bytes FROM (SELECT h.session,e.bytes" + eligible +
              "UNION ALL SELECT h.session,json_extract(h.recovery,'$.length') AS bytes" +
              inline_eligible + ") GROUP BY session");
    std::map<std::string, int64_t> bytes, targets;
    Json pressured = Json::array();
    int64_t total = 0;
    for (const auto &row : usage) {
      const std::string session = row.at("session");
      const int64_t count = row.at("bytes");
      bytes[session] = count;
      total += count;
      if (count > session_max) {
        targets[session] = session_max * percent / 100;
        pressured.push_back(session);
      }
    }
    const bool global_pressure = total > global_max;
    const auto global_target = global_pressure ? global_max * percent / 100 : total;
    int64_t reclaimed = 0, records = 0;
    if (!verified.is_null() && (global_pressure || !pressured.empty())) {
      // Persisted proof alone is not fresh source evidence. The Agent supplies
      // the item it just read through the source-bound read-only adapter.
      history_source_register(verified.at("session"), verified.at("seq"), verified.at("origin"),
                              verified.at("entry"));
      const auto victims = query(
          "SELECT c.seq,c.start,h.session,e.bytes" + eligible +
              "AND (? OR h.session IN(SELECT value FROM json_each(?))) "
              "AND c.seq=? AND h.session=? ORDER BY c.seq,c.start LIMIT 128",
          {global_pressure ? 1 : 0, pressured.dump(), verified.at("seq"), verified.at("session")});
      for (const auto &row : victims) {
        const std::string session = row.at("session");
        if (total <= global_target &&
            (!targets.count(session) || bytes[session] <= targets.at(session)))
          continue;
        if (row.at("seq") != verified.at("seq") || row.at("session") != verified.at("session"))
          continue; // Never reclaim a body without this read's fresh verification.
        const int64_t cost = row.at("bytes");
        run("DELETE FROM chunks WHERE seq=? AND start=?", {row.at("seq"), row.at("start")});
        total -= cost;
        bytes[session] -= cost;
        reclaimed += cost;
        ++records;
      }
      const auto inline_rows =
          query("SELECT h.value,h.recovery,json_extract(h.recovery,'$.length') AS bytes" +
                    inline_eligible + "AND h.seq=? AND h.session=?",
                {verified.at("seq"), verified.at("session")});
      const std::string session = verified.at("session");
      if (!inline_rows.empty() &&
          (total > global_target ||
           (targets.count(session) && bytes[session] > targets.at(session)))) {
        const auto &row = inline_rows.at(0);
        const auto descriptor = history_cache_descriptor(
            Json::parse(row.at("value").get<std::string>()), verified.at("seq"));
        const auto encoded = descriptor.dump();
        const auto savings = int64_t(row.at("value").get_ref<const std::string &>().size()) -
                             int64_t(encoded.size());
        // Reattaching proof grows the row after invalidation. Do not let an
        // optional rewrite hit the fail-closed quota trigger in an already
        // over-limit store; chunk/journal reclamation can first restore room.
        const auto scopes = query("SELECT scope,bytes,records FROM transport2_history_budget "
                                  "WHERE scope IN('@global',?)",
                                  {session});
        bool within_limits = true;
        for (const auto &scope : scopes) {
          const bool global = scope.at("scope") == "@global";
          within_limits =
              within_limits &&
              scope.at("bytes") <= policy.at(global ? "maxBytes" : "maxSessionBytes") &&
              scope.at("records") <= policy.at(global ? "maxRecords" : "maxSessionRecords");
        }
        if (!descriptor.is_null() && savings > 0 && within_limits) {
          run("UPDATE history SET value=?,recovery=NULL WHERE seq=? AND session=?",
              {encoded, verified.at("seq"), session});
          run("UPDATE history SET recovery=? WHERE seq=? AND session=?",
              {row.at("recovery"), verified.at("seq"), session});
          // Recheck the new descriptor against the same fresh source before
          // committing; a changed template must never strand the old reference.
          history_source_recover(session, verified.at("seq"), verified.at("origin"),
                                 verified.at("entry"));
          total -= row.at("bytes").get<int64_t>();
          bytes[session] -= row.at("bytes").get<int64_t>();
          reclaimed += savings;
        }
      }
    }
    run("COMMIT");
    return {{"reclaimedBytes", reclaimed}, {"reclaimedRecords", records}, {"cacheBytes", total}};
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::history_turn_admit(const std::string &session, const Json &input, const Json &user,
                               const Json &task, bool start) {
  const auto encoded = input.dump().size();
  if (encoded > max_frame)
    throw Error("MESSAGE_TOO_LARGE", "Turn input exceeds history admission bound");
  run("BEGIN IMMEDIATE");
  try {
    auto state = get(session);
    if (start && state.value("running", false))
      throw Error("TURN_BUSY", "A turn is already running");
    if (!start && (!state.value("running", false) || !state.contains("turnId") ||
                   input.value("expectedTurnId", "") != state.at("turnId")))
      throw Error("TARGET_NOT_FOUND", "Steering must name the original active turn");
    // Admission, task identity and user history either all commit or all roll
    // back. The caller may publish and send to Codex only after this returns.
    history_reserve(session, 16 * 1024, 8, "runtime-terminal");
    history_reserve_output(session, 16 * 1024 + static_cast<int64_t>(encoded) * 4, 16);
    if (start) {
      state["running"] = true;
      state.erase("turnId");
      if (task.is_null())
        state.erase("activeTask");
      else
        state["activeTask"] = task;
      save(state);
    }
    auto result = event(session, "user", user);
    run("COMMIT");
    return result;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
// Reservations share the authoritative history ledger and its SQL quota checks.
// Their charged bytes include bookkeeping overhead; no second credit pool exists.
void Store::history_reserve(const std::string &session, int64_t bytes, int64_t records,
                            const std::string &owner) {
  if (session.empty() || session == "@global" || session.size() > 201 || bytes < 4096 ||
      bytes > 9007199254740991LL || records < 1 || records > 9007199254740991LL)
    throw Error("INVALID_REQUEST", "Invalid history reservation");
  run("SAVEPOINT history_reservation");
  try {
    const auto key = reservation_key(session, owner);
    auto existing =
        query("SELECT bytes,records FROM transport2_history_entries WHERE key=?", {key});
    const auto previous = existing.empty() ? int64_t(0) : existing.at(0).at("bytes").get<int64_t>();
    const auto previous_records =
        existing.empty() ? int64_t(0) : existing.at(0).at("records").get<int64_t>();
    bytes = std::max(bytes, previous);
    records = std::max(records, previous_records);
    // Repeating admission cannot shrink either dimension of a promise.
    if (bytes > previous || records > previous_records) {
      history_require_capacity(session, bytes - previous, records - previous_records);
      run("INSERT INTO transport2_history_entries(key,session,bytes,records) VALUES(?,?,?,?) "
          "ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes,records=excluded.records",
          {key, session, bytes, records});
    }
    run("RELEASE history_reservation");
  } catch (...) {
    run("ROLLBACK TO history_reservation");
    run("RELEASE history_reservation");
    throw;
  }
}
void Store::history_release(const std::string &session, const std::string &owner) {
  // Call only after the associated execution/retention responsibility is resolved.
  // The existing refund trigger removes both byte and bookkeeping-record charges.
  run("DELETE FROM transport2_history_entries WHERE key=? AND session=?",
      {reservation_key(session, owner), session});
}
void Store::history_reserve_output(const std::string &session, int64_t bytes, int64_t records) {
  if (bytes < 4096 || bytes > 9007199254740991LL || records < 1 || records > 9007199254740991LL)
    throw Error("INVALID_REQUEST", "Invalid history output window demand");
  const auto target = [](int64_t needed, int64_t window, int64_t limit) {
    const auto rounded = ((needed - 1) / window + 1) * window;
    return std::max(needed, std::min(rounded, limit));
  };
  const auto next_bytes =
      target(bytes, history_policy_.at("writeWindowBytes"), history_policy_.at("maxSessionBytes"));
  const auto next_records = target(records, history_policy_.at("writeWindowRecords"),
                                   history_policy_.at("maxSessionRecords"));
  try {
    history_reserve(session, next_bytes, next_records);
  } catch (const Error &error) {
    if (error.code != "BACKPRESSURE")
      throw;
    // Prefetching a whole window is optional. Honor already admitted output
    // and use the exact bounded demand when the remaining global slack is small.
    history_reserve(session, bytes, records);
  }
}
Json Store::history_runtime_close(const std::string &session, const Json &data) {
  if (query("SELECT key FROM transport2_history_entries WHERE key=?",
            {reservation_key(session, "runtime-terminal")})
          .empty())
    return event(session, "sessionClosed", data);
  return history_reserved_event(session, "runtime-terminal", "sessionClosed", data);
}
Json Store::history_queue_accept(const std::string &session, const std::string &owner,
                                 const Json &data) {
  return history_reserved_event(session, owner, "queueAccepted", data);
}
Json Store::history_reserved_event(const std::string &session, const std::string &owner,
                                   const std::string &type, const Json &data) {
  if (owner.empty())
    throw Error("INVALID_REQUEST", "History receipt requires its original reservation owner");
  const bool outer = sqlite3_get_autocommit(db_) != 0;
  run(outer ? "BEGIN IMMEDIATE" : "SAVEPOINT history_reserved_receipt");
  try {
    if (query("SELECT key FROM transport2_history_entries WHERE key=? AND session=?",
              {reservation_key(session, owner), session})
            .empty())
      throw Error("DELIVERY_STATE_MISMATCH", "History receipt reservation is missing");
    const auto normal = query("SELECT bytes,records FROM transport2_history_entries WHERE key=?",
                              {reservation_key(session, "")});
    history_release(session, owner);
    auto result = event(session, type, data);
    // Ordinary event accounting consumes the session's turn reservation. This
    // receipt spends only its own promise; restore any unrelated turn headroom
    // before committing, with the same global quota triggers still enforced.
    if (!normal.empty())
      run("INSERT INTO transport2_history_entries(key,session,bytes,records) VALUES(?,?,?,?) "
          "ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes,records=excluded.records",
          {reservation_key(session, ""), session, normal.at(0).at("bytes"),
           normal.at(0).at("records")});
    run(outer ? "COMMIT" : "RELEASE history_reserved_receipt");
    return result;
  } catch (...) {
    run(outer ? "ROLLBACK" : "ROLLBACK TO history_reserved_receipt");
    if (!outer)
      run("RELEASE history_reserved_receipt");
    throw;
  }
}
void Store::history_require_capacity(const std::string &session, int64_t bytes, int64_t records) {
  if (bytes < 0 || records < 0)
    throw Error("INVALID_REQUEST", "Invalid history capacity request");
  retention_cleanup();
  const auto usage = history_budget();
  const auto fits = [&](const Json &used, const char *byte_limit, const char *record_limit) {
    const auto available_bytes =
        history_policy_.at(byte_limit).get<int64_t>() - used.at("bytes").get<int64_t>();
    const auto available_records =
        history_policy_.at(record_limit).get<int64_t>() - used.at("records").get<int64_t>();
    return bytes <= available_bytes && records <= available_records;
  };
  if (!fits(usage.at("global"), "maxBytes", "maxRecords"))
    throw Error("BACKPRESSURE", "History capacity unavailable before execution");
  auto local =
      query("SELECT bytes,records FROM transport2_history_budget WHERE scope=?", {session});
  if (local.empty() &&
      usage.at("sessions").size() >= history_policy_.at("maxSessions").get<size_t>())
    throw Error("BACKPRESSURE", "History session capacity unavailable before execution");
  if (!fits(local.empty() ? Json{{"bytes", 0}, {"records", 0}} : local.at(0), "maxSessionBytes",
            "maxSessionRecords"))
    throw Error("BACKPRESSURE", "Session history capacity unavailable before execution");
  std::error_code error;
  const auto space =
      std::filesystem::space(std::filesystem::u8path(sqlite3_db_filename(db_, "main")), error);
  if (error)
    throw Error("STORAGE_ERROR", "Cannot inspect history filesystem capacity");
  if (space.available <
          static_cast<uint64_t>(history_policy_.at("minFreeDiskBytes").get<int64_t>()) ||
      static_cast<uint64_t>(bytes) >
          space.available -
              static_cast<uint64_t>(history_policy_.at("minFreeDiskBytes").get<int64_t>()))
    throw Error("BACKPRESSURE", "History filesystem reserve unavailable before execution");
}
Json Store::history_budget() {
  return {{"globalLimit", history_policy_.at("maxBytes")},
          {"sessionLimit", history_policy_.at("maxSessionBytes")},
          {"recordLimit", history_policy_.at("maxRecords")},
          {"sessionRecordLimit", history_policy_.at("maxSessionRecords")},
          {"scopeLimit", history_policy_.at("maxSessions")},
          {"global", query("SELECT bytes,records FROM transport2_history_budget WHERE "
                           "scope='@global'")
                         .at(0)},
          {"sessions", query("SELECT scope AS session,bytes,records FROM "
                             "transport2_history_budget WHERE scope!='@global' ORDER BY scope")}};
}
} // namespace coc
