#include "coc/store.hpp"
#include "coc/delivery.hpp"
#include "coc/history_projection.hpp"
#include <algorithm>
#include <fcntl.h>
#include <memory>
#ifndef _WIN32
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#else
#include "coc/windows.hpp"
#endif
namespace coc {
void Store::fail(int code) {
  const bool history_capacity =
      std::string(sqlite3_errmsg(db_)).find("COC_HISTORY_CAPACITY") != std::string::npos;
  if (storage_failure_)
    storage_failure_();
  if (history_capacity)
    throw Error("BACKPRESSURE", "Authoritative history budget exhausted; new writes stopped");
  const auto primary = code & 0xff;
  const char *category = "STORAGE_ERROR";
  if (primary == SQLITE_FULL)
    category = "STORAGE_FULL";
  else if (primary == SQLITE_BUSY || primary == SQLITE_LOCKED)
    category = "STORAGE_BUSY";
  else if (primary == SQLITE_CORRUPT || primary == SQLITE_NOTADB)
    category = "STORAGE_CORRUPT";
  throw Error(category, "Journal operation failed (SQLite " + std::to_string(code) + ")");
}
#ifndef _WIN32
Store::Lock::Lock(const std::string &dir, bool exclusive) {
  std::filesystem::create_directories(dir);
  chmod(dir.c_str(), 0700);
  if (!exclusive)
    return;
  auto path = std::filesystem::path(dir) / "agent.lock";
  fd = open(path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0)
    throw Error("STORAGE_ERROR", "Cannot open Agent state lock");
  if (flock(fd, LOCK_EX | LOCK_NB) < 0) {
    ::close(fd);
    fd = -1;
    throw Error("STATE_LOCKED", "Another Agent is using this dataDir");
  }
}
Store::Lock::~Lock() {
  if (fd >= 0)
    ::close(fd);
}

#else
Store::Lock::Lock(const std::string &dir, bool exclusive) {
  auto root = std::filesystem::u8path(dir);
  std::filesystem::create_directories(root);
  private_path(root);
  if (!exclusive)
    return;
  handle = private_file(root / "agent.lock", GENERIC_READ | GENERIC_WRITE, 0, OPEN_ALWAYS);
  if (handle == INVALID_HANDLE_VALUE)
    throw Error("STATE_LOCKED", "Another Agent is using this dataDir or it is inaccessible");
}
Store::Lock::~Lock() {
  if (handle)
    CloseHandle(handle);
}
#endif

Json Store::query(const std::string &sql, const Json &args) {
  auto found = statements_.find(sql);
  sqlite3_stmt *raw = nullptr;
  if (found == statements_.end()) {
    if (statements_.size() >= 64)
      clear_statements();
    const auto prepared = sqlite3_prepare_v2(db_, sql.c_str(), -1, &raw, nullptr);
    if (prepared != SQLITE_OK)
      fail(prepared);
    statements_.emplace(sql, raw);
  } else
    raw = found->second;
  // Reset on success and on exceptions; cached bindings must never leak to a later call.
  const auto reset = [](sqlite3_stmt *statement) {
    sqlite3_reset(statement);
    sqlite3_clear_bindings(statement);
  };
  std::unique_ptr<sqlite3_stmt, decltype(reset)> guard(raw, reset);
  int i = 0;
  for (auto &a : args) {
    ++i;
    int rc;
    if (a.is_null())
      rc = sqlite3_bind_null(raw, i);
    else if (a.is_number_integer())
      rc = sqlite3_bind_int64(raw, i, a.get<int64_t>());
    else {
      auto text = a.get<std::string>();
      rc = sqlite3_bind_text(raw, i, text.c_str(), text.size(), SQLITE_TRANSIENT);
    }
    if (rc != SQLITE_OK)
      fail(rc);
  }
  Json rows = Json::array();
  int rc;
  while ((rc = sqlite3_step(raw)) == SQLITE_ROW) {
    Json row = Json::object();
    for (int c = 0; c < sqlite3_column_count(raw); ++c) {
      auto k = sqlite3_column_name(raw, c);
      if (sqlite3_column_type(raw, c) == SQLITE_NULL)
        row[k] = nullptr;
      else if (sqlite3_column_type(raw, c) == SQLITE_INTEGER)
        row[k] = sqlite3_column_int64(raw, c);
      else
        row[k] = reinterpret_cast<const char *>(sqlite3_column_text(raw, c));
    }
    rows.push_back(row);
  }
  if (rc != SQLITE_DONE)
    fail(rc);
  return rows;
}
void Store::clear_statements() {
  for (auto &[sql, statement] : statements_)
    sqlite3_finalize(statement);
  statements_.clear();
}
void Store::run(const std::string &s, const Json &a) { query(s, a); }
Store::Store(const std::string &dir, bool authoritative, const std::string &cache_namespace,
             const Json &history_policy)
    : history_policy_(history_storage_config(history_policy)), lock_(dir, authoritative),
      cache_namespace_(cache_namespace) {
  if (cache_namespace_.size() > 128)
    throw Error("INVALID_REQUEST", "Invalid local cache namespace");
  std::filesystem::create_directories(std::filesystem::u8path(dir));
#ifndef _WIN32
  chmod(dir.c_str(), 0700);
#endif
  auto path = std::filesystem::u8path(dir) / "agent.db";
  if (sqlite3_open(path.u8string().c_str(), &db_) != SQLITE_OK) {
    if (db_)
      sqlite3_close(db_);
    throw Error("STORAGE_ERROR", "Cannot open journal");
  }
#ifdef _WIN32
  private_path(path);
#else
  chmod(path.c_str(), 0600);
#endif
  sqlite3_busy_timeout(db_, 250);
  try {
    run("PRAGMA journal_mode=WAL");
    run("CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
    run("CREATE INDEX IF NOT EXISTS sessions_state ON sessions(json_extract(value,'$.state'),id)");
    run("CREATE INDEX IF NOT EXISTS sessions_project ON "
        "sessions(json_extract(value,'$.projectId'),id)");
    run("CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT NOT "
        "NULL,value TEXT NOT NULL,time INTEGER NOT NULL)");
    run("CREATE INDEX IF NOT EXISTS events_session ON events(session,seq)");
    run("BEGIN IMMEDIATE");
    const bool migrate =
        query("SELECT name FROM sqlite_master WHERE type='table' AND name='history'").empty();
    run("CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY,session TEXT NOT NULL,value "
        "TEXT NOT NULL,revision INTEGER NOT NULL)");
    run("CREATE INDEX IF NOT EXISTS history_session ON history(session,seq)");
    run("CREATE INDEX IF NOT EXISTS history_revision ON history(session,revision)");
    run("CREATE TABLE IF NOT EXISTS bodies(seq INTEGER PRIMARY KEY,size INTEGER NOT NULL,bytes "
        "INTEGER NOT NULL)");
    run("CREATE TABLE IF NOT EXISTS chunks(seq INTEGER NOT NULL,start INTEGER NOT NULL,text TEXT "
        "NOT NULL,PRIMARY KEY(seq,start))");
    run("CREATE TABLE IF NOT EXISTS streams(session TEXT,key TEXT,seq INTEGER,PRIMARY "
        "KEY(session,key))");
    if (migrate)
      run("INSERT INTO history(seq,session,value,revision) SELECT seq,session,value,MAX(0,seq) "
          "FROM events");
    for (const auto &field : std::vector<std::pair<std::string, std::string>>{
             {"history", "recovery"}, {"sessions", "source"}}) {
      bool exists = false;
      for (const auto &column : query("PRAGMA table_info(" + field.first + ")"))
        exists = exists || column.at("name") == field.second;
      if (!exists)
        run("ALTER TABLE " + field.first + " ADD COLUMN " + field.second + " TEXT");
    }
    run("CREATE TABLE IF NOT EXISTS external_items(session TEXT NOT NULL,turn TEXT NOT NULL,item "
        "TEXT NOT NULL,"
        "seq INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(session,turn,item))");
    run("CREATE TABLE IF NOT EXISTS transport2_identity(id INTEGER PRIMARY KEY "
        "CHECK(id=1),instance "
        "TEXT NOT NULL)");
    run("INSERT OR IGNORE INTO transport2_identity VALUES(1,?)", {uuid()});
    delivery_instance_ = query("SELECT instance FROM transport2_identity WHERE id=1")[0]["instance"]
                             .get<std::string>();
    run("CREATE TABLE IF NOT EXISTS transport2_operations(key TEXT PRIMARY KEY,owner TEXT NOT "
        "NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,phase TEXT NOT NULL,result TEXT,"
        "reserved INTEGER NOT NULL,UNIQUE(owner,request_id))");
    run("CREATE TABLE IF NOT EXISTS transport2_uploads(key TEXT PRIMARY KEY,owner TEXT NOT NULL,"
        "digest TEXT NOT NULL,phase TEXT NOT NULL,result TEXT,reserved INTEGER NOT NULL,"
        "active INTEGER NOT NULL)");
    run("CREATE INDEX IF NOT EXISTS transport2_upload_owner ON transport2_uploads(owner)");
    if (authoritative)
      run("UPDATE transport2_uploads SET phase='unknown',result=? WHERE phase='started'",
          {Json{{"state", "unknown"},
                {"error",
                 {{"code", "RESULT_UNKNOWN"},
                  {"message", "Agent restarted during the original upload; reconcile its file "
                              "before a new intent"}}}}
               .dump()});
    run("CREATE TABLE IF NOT EXISTS transport2_local_operations(key TEXT PRIMARY KEY,allocation "
        "TEXT NOT NULL,value TEXT NOT NULL)");
    run("CREATE INDEX IF NOT EXISTS transport2_local_operations_allocation ON "
        "transport2_local_operations(allocation,key)");
    if (authoritative)
      run("UPDATE transport2_operations SET phase='unknown',result=COALESCE(result,?) WHERE "
          "phase='started'",
          {Json{{"error",
                 {{"code", "RESULT_UNKNOWN"},
                  {"message", "Agent restarted after the original operation began; "
                              "reconcile its side effects before creating a new intent"}}}}
               .dump()});
    run("CREATE TABLE IF NOT EXISTS transport2_outputs(stream TEXT NOT NULL,seq INTEGER NOT NULL,"
        "end_bytes INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(stream,seq))");
    run("CREATE TABLE IF NOT EXISTS transport2_output_heads(stream TEXT PRIMARY KEY,sent INTEGER "
        "NOT "
        "NULL DEFAULT 0,"
        "sent_bytes INTEGER NOT NULL DEFAULT 0,published INTEGER NOT NULL DEFAULT 0,"
        "acked INTEGER NOT NULL DEFAULT 0,acked_bytes INTEGER NOT NULL DEFAULT 0)");
    run("CREATE TABLE IF NOT EXISTS transport2_output_budget(stream TEXT PRIMARY KEY,bytes "
        "INTEGER NOT NULL,records INTEGER NOT NULL)");
    run("INSERT OR IGNORE INTO transport2_output_budget SELECT stream,"
        "SUM(length(CAST(body AS BLOB))+512),COUNT(*) FROM transport2_outputs GROUP BY stream");
    run("CREATE TABLE IF NOT EXISTS transport2_streams(stream TEXT PRIMARY KEY,session TEXT NOT "
        "NULL,"
        "received INTEGER NOT NULL DEFAULT 0,received_bytes INTEGER NOT NULL DEFAULT 0,"
        "slots INTEGER NOT NULL,bytes INTEGER NOT NULL)");
    run("CREATE TABLE IF NOT EXISTS transport2_commands(stream TEXT NOT NULL,seq INTEGER NOT NULL,"
        "end_bytes INTEGER NOT NULL,body TEXT NOT NULL,phase TEXT NOT NULL,result TEXT,"
        "PRIMARY KEY(stream,seq))");
    run("CREATE INDEX IF NOT EXISTS transport2_pending ON transport2_commands(stream,phase) WHERE "
        "phase!='finished'");
    run("CREATE TABLE IF NOT EXISTS transport2_control(session TEXT PRIMARY KEY,epoch INTEGER NOT "
        "NULL,control_id TEXT NOT NULL,owner TEXT NOT NULL)");
    run("CREATE TABLE IF NOT EXISTS transport2_flow_control(stream TEXT PRIMARY KEY,session TEXT "
        "NOT NULL,epoch INTEGER NOT NULL,control_id TEXT NOT NULL,closed INTEGER NOT NULL DEFAULT "
        "0)");
    run("CREATE INDEX IF NOT EXISTS transport2_control_flows ON "
        "transport2_flow_control(session,epoch)");
    run("CREATE TABLE IF NOT EXISTS transport2_flow_owner(stream TEXT PRIMARY KEY,owner TEXT NOT "
        "NULL)");
    run("CREATE TABLE IF NOT EXISTS transport2_command_keys(stream TEXT NOT NULL,request_id TEXT "
        "NOT NULL,"
        "seq INTEGER NOT NULL,PRIMARY "
        "KEY(stream,request_id),UNIQUE(stream,seq))");
    run("CREATE TABLE IF NOT EXISTS transport2_cancel(stream TEXT NOT NULL,request_id TEXT NOT "
        "NULL,"
        "PRIMARY KEY(stream,request_id))");
    run("CREATE TABLE IF NOT EXISTS transport2_command_digests(stream TEXT NOT NULL,seq INTEGER "
        "NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(stream,seq))");
    run("CREATE TABLE IF NOT EXISTS transport2_namespaces(scope TEXT PRIMARY KEY,allocated INTEGER "
        "NOT NULL DEFAULT 0)");
    run("CREATE TABLE IF NOT EXISTS transport2_credit(stream TEXT PRIMARY KEY,session TEXT NOT "
        "NULL,lane TEXT NOT NULL,scope TEXT NOT NULL,serial INTEGER NOT NULL,generation TEXT NOT "
        "NULL,reserved INTEGER NOT NULL,credit INTEGER NOT NULL DEFAULT 0,byte_credit INTEGER NOT "
        "NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0,UNIQUE(scope,serial))");
    run("CREATE TABLE IF NOT EXISTS transport2_local_credit(key TEXT PRIMARY KEY,kind TEXT NOT "
        "NULL,reserved INTEGER NOT NULL)");
    run("CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    run("CREATE TABLE IF NOT EXISTS transport2_history_subscriptions("
        "key TEXT PRIMARY KEY,session TEXT NOT NULL,owner TEXT NOT NULL,stream TEXT NOT NULL,"
        "instance TEXT NOT NULL,serial INTEGER NOT NULL UNIQUE,generation TEXT NOT NULL,"
        "received INTEGER NOT NULL DEFAULT 0,published INTEGER NOT NULL DEFAULT 0,"
        "closed INTEGER NOT NULL DEFAULT 0)");
    run("CREATE TABLE IF NOT EXISTS transport2_cache_entries(key TEXT PRIMARY KEY,scope TEXT "
        "NOT NULL,bytes INTEGER NOT NULL)");
    run("CREATE INDEX IF NOT EXISTS transport2_cache_scope ON transport2_cache_entries(scope)");
    run("CREATE TABLE IF NOT EXISTS transport2_cache_budget(scope TEXT PRIMARY KEY,bytes "
        "INTEGER NOT NULL,records INTEGER NOT NULL)");
    run("INSERT OR IGNORE INTO transport2_cache_entries SELECT c.key,'',"
        "length(CAST(c.value AS BLOB))+length(CAST(c.key AS BLOB))*4+2048 FROM cache c WHERE "
        "NOT EXISTS(SELECT 1 FROM transport2_local_credit b WHERE b.key=c.key) AND "
        "NOT EXISTS(SELECT 1 FROM transport2_cache_entries e WHERE e.key=c.key)");
    run("INSERT INTO transport2_cache_budget SELECT scope,SUM(bytes),COUNT(*) FROM "
        "transport2_cache_entries GROUP BY scope ON CONFLICT(scope) DO UPDATE SET "
        "bytes=excluded.bytes,records=excluded.records");
    // Compact only redundant columns from the supported delivery:2 layout. The
    // enclosing startup transaction preserves the old schema/data on any failure.
    const auto has_column = [&](const std::string &table, const std::string &name) {
      const auto columns = query("PRAGMA table_info(" + table + ")");
      return std::any_of(columns.begin(), columns.end(),
                         [&](const Json &column) { return column.at("name") == name; });
    };
    if (has_column("transport2_control", "ready")) {
      for (const auto &row : query("SELECT session,ready FROM transport2_control"))
        if (Json::parse(row.at("ready").get<std::string>()) != control_state(row.at("session")))
          throw Error("STORAGE_CORRUPT", "Control confirmation disagrees with durable identity");
      run("CREATE TABLE transport2_control_compact(session TEXT PRIMARY KEY,epoch INTEGER NOT "
          "NULL,control_id TEXT NOT NULL,owner TEXT NOT NULL)");
      run("INSERT INTO transport2_control_compact SELECT session,epoch,control_id,owner "
          "FROM transport2_control");
      run("DROP TABLE transport2_control");
      run("ALTER TABLE transport2_control_compact RENAME TO transport2_control");
    }
    if (has_column("transport2_command_keys", "digest")) {
      if (!query(
               "SELECT 1 FROM transport2_command_keys k LEFT JOIN transport2_command_digests d "
               "ON d.stream=k.stream AND d.seq=k.seq WHERE d.digest IS NULL OR k.digest<>d.digest "
               "LIMIT 1")
               .empty())
        throw Error("STORAGE_CORRUPT", "Command identity disagrees with durable digest");
      run("CREATE TABLE transport2_command_keys_compact(stream TEXT NOT NULL,request_id TEXT NOT "
          "NULL,seq INTEGER NOT NULL,PRIMARY KEY(stream,request_id),UNIQUE(stream,seq))");
      run("INSERT INTO transport2_command_keys_compact SELECT stream,request_id,seq "
          "FROM transport2_command_keys");
      run("DROP TABLE transport2_command_keys");
      run("ALTER TABLE transport2_command_keys_compact RENAME TO transport2_command_keys");
    }
    if (has_column("transport2_namespaces", "closed_through")) {
      if (!query("SELECT 1 FROM transport2_namespaces n WHERE closed_through<>COALESCE("
                 "(SELECT MIN(serial)-1 FROM transport2_credit c WHERE c.scope=n.scope "
                 "AND c.closed=0),n.allocated) LIMIT 1")
               .empty())
        throw Error("STORAGE_CORRUPT", "Namespace checkpoint disagrees with credit tombstones");
      run("CREATE TABLE transport2_namespaces_compact(scope TEXT PRIMARY KEY,allocated INTEGER "
          "NOT NULL DEFAULT 0)");
      run("INSERT INTO transport2_namespaces_compact SELECT scope,allocated FROM "
          "transport2_namespaces");
      run("DROP TABLE transport2_namespaces");
      run("ALTER TABLE transport2_namespaces_compact RENAME TO transport2_namespaces");
    }
    run("CREATE TABLE IF NOT EXISTS transport2_result_heads(stream TEXT PRIMARY KEY,"
        "sent INTEGER NOT NULL DEFAULT 0,sent_bytes INTEGER NOT NULL DEFAULT 0,"
        "acked INTEGER NOT NULL DEFAULT 0,acked_bytes INTEGER NOT NULL DEFAULT 0)");
    run("CREATE TABLE IF NOT EXISTS transport2_results(stream TEXT NOT NULL,seq INTEGER NOT NULL,"
        "command_seq INTEGER NOT NULL,end_bytes INTEGER NOT NULL,body TEXT,digest TEXT NOT NULL,"
        "PRIMARY KEY(stream,seq),UNIQUE(stream,command_seq))");
    run("CREATE TABLE IF NOT EXISTS transport2_result_content(stream TEXT NOT NULL,seq INTEGER NOT "
        "NULL,body TEXT NOT NULL,PRIMARY KEY(stream,seq))");
    if (authoritative) {
      for (const auto &command : query("SELECT stream,seq,body,phase FROM transport2_commands "
                                       "WHERE phase IN ('started','received')")) {
        const bool started = command.at("phase") == "started";
        const auto result = delivery_failure(
            Json::parse(command.at("body").get<std::string>()),
            started ? "RESULT_UNKNOWN" : "SESSION_CLOSED",
            started ? "Agent restarted after execution began; query the original request"
                    : "Agent restarted before the queued command executed");
        run("UPDATE transport2_commands SET phase='finished',result=? WHERE stream=? AND seq=?",
            {result.dump(), command.at("stream"), command.at("seq")});
      }
    }
    run("CREATE INDEX IF NOT EXISTS cache_upload_expiry ON "
        "cache(json_extract(value,'$.completedAt')) WHERE key GLOB 'upload:*'");
    history_budget_init(authoritative);
    run("COMMIT");
    // Restart terminal records enter the same durable completion log as live results.
    for (const auto &record :
         query("SELECT c.stream,c.seq,c.result FROM transport2_commands c "
               "LEFT JOIN transport2_results r ON c.stream=r.stream AND "
               "c.seq=r.command_seq WHERE c.phase='finished' AND r.seq IS NULL "
               "ORDER BY c.stream,c.seq"))
      delivery_finish(record.at("stream"), record.at("seq"),
                      Json::parse(record.at("result").get<std::string>()));
    for (auto &s : authoritative ? sessions(true) : Json::array())
      if (s["state"] == "ready" || s["state"] == "starting" || s["state"] == "closing") {
        s["state"] = s["state"] == "closing" ? "closed" : "failed";
        s["running"] = false;
        save(s);
      }
  } catch (...) {
    clear_statements();
    sqlite3_close(db_);
    db_ = nullptr;
    throw;
  }
}
Store::~Store() {
  clear_statements();
  if (db_)
    sqlite3_close(db_);
}
void Store::save(const Json &s) {
  auto value = s;
  value["updatedAt"] = now();
  run("INSERT INTO sessions(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET "
      "value=excluded.value",
      {s.at("id"), value.dump()});
  if (!value.value("running", false)) {
    const bool transaction = sqlite3_get_autocommit(db_) != 0;
    if (transaction)
      run("BEGIN IMMEDIATE");
    try {
      for (const auto &flow :
           query("SELECT stream FROM transport2_credit WHERE session=? AND closed=1 AND reserved>0",
                 {s.at("id")}))
        delivery_release(flow.at("stream"));
      if (transaction)
        run("COMMIT");
    } catch (...) {
      if (transaction)
        run("ROLLBACK");
      throw;
    }
  }
}
Json Store::sessions(bool active_only) {
  Json result = Json::array();
  for (auto &r :
       query(active_only ? "SELECT value FROM sessions WHERE json_extract(value,'$.state') IN "
                           "('ready','starting','closing')"
                         : "SELECT value FROM sessions"))
    result.push_back(Json::parse(r["value"].get<std::string>()));
  return result;
}
Json Store::session_page(const Json &filters) {
  std::string sql = "SELECT id,value FROM sessions WHERE id>?";
  Json args = Json::array({filters.value("cursor", "")});
  for (auto key : {"projectId", "mode", "state"}) {
    if (filters.contains(key) && !filters[key].is_null() && filters[key] != "") {
      sql += std::string(" AND json_extract(value,'$.") + key + "')=?";
      args.push_back(filters[key]);
    }
  }
  sql += " ORDER BY id LIMIT 101";
  auto rows = query(sql, args);
  Json data = Json::array();
  size_t bytes = 0;
  std::string cursor;
  for (auto &row : rows) {
    auto value = row["value"].get<std::string>();
    if (value.size() > 96 * 1024)
      throw Error("MESSAGE_TOO_LARGE", "Session metadata exceeds page budget");
    if (data.size() == 100 || bytes + value.size() > 96 * 1024)
      break;
    data.push_back(Json::parse(value));
    bytes += value.size();
    cursor = row["id"];
  }
  return {{"data", data}, {"nextCursor", data.size() < rows.size() ? Json(cursor) : Json()}};
}
Json Store::get(const std::string &id) {
  auto r = query("SELECT value FROM sessions WHERE id=?", {id});
  if (r.empty())
    throw Error("SESSION_NOT_FOUND", "Unknown session");
  return Json::parse(r[0]["value"].get<std::string>());
}
Json Store::event(const std::string &id, const std::string &type, const Json &data) {
  return event_batch(Json::array({{{"session", id}, {"type", type}, {"data", data}}}))[0];
}
Json Store::event_batch(const Json &entries) {
  if (!entries.is_array() || entries.size() > 128)
    throw Error("INVALID_REQUEST", "Event batch exceeds 128 entries");
  Json results = Json::array();
  if (entries.empty())
    return results;
  run("BEGIN IMMEDIATE");
  try {
    for (const auto &entry : entries) {
      const auto id = entry.at("session").get<std::string>();
      const auto type = entry.at("type").get<std::string>();
      const auto &data = entry.at("data");
      Json e = {{"type", type}, {"data", data}, {"time", entry.value("time", now())}};
      run("INSERT INTO events(session,value,time) VALUES(?,?,?)", {id, e.dump(), e["time"]});
      e["seq"] = sqlite3_last_insert_rowid(db_);
      if (type == "user")
        run("UPDATE sessions SET "
            "value=json_set(value,'$.title',COALESCE(json_extract(value,'$.title'),substr(?,1,160))"
            ",'"
            "$.updatedAt',?) WHERE id=?",
            {data.value("text", ""), now(), id});
      results.push_back(project(id, e));
    }
    run("COMMIT");
    return results;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::archive_page(const std::string &id, const Json &events, const Json &cursor) {
  run("BEGIN IMMEDIATE");
  try {
    for (auto &e : events)
      archive_event(id, e.at("type"), e.at("data"));
    auto s = get(id);
    s["archiveCursor"] = cursor;
    s["archiveDone"] = cursor.is_null();
    save(s);
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::external_item(const std::string &id, const std::string &turn, Json item,
                          bool historical) {
  get(id);
  const auto projection = project_history_item(std::move(item), turn);
  item = projection.item;
  const auto item_id = item.at("id").get<std::string>();
  const auto &fingerprint = projection.fingerprint;
  auto existing =
      query("SELECT seq,fingerprint FROM external_items WHERE session=? AND turn=? AND item=?",
            {id, turn, item_id});
  if (!existing.empty() && existing[0]["fingerprint"] == fingerprint)
    return nullptr;
  const auto kind = item.value("type", "");
  const auto &type = projection.type;
  const auto &text = projection.text;
  const auto &data = projection.data;
  run("BEGIN IMMEDIATE");
  try {
    int64_t seq = existing.empty() ? 0 : existing[0]["seq"].get<int64_t>();
    std::string previous;
    if (!existing.empty())
      for (auto &part : query("SELECT text FROM chunks WHERE seq=? ORDER BY start", {seq}))
        previous += part["text"].get<std::string>();
    const bool append = !existing.empty() && text.compare(0, previous.size(), previous) == 0;
    Json raw = {{"type", "external/itemUpdate"},
                {"time", now()},
                {"data",
                 {{"turnId", turn},
                  {"itemId", item_id},
                  {"itemType", kind},
                  {"append", append},
                  {"text", append ? text.substr(previous.size()) : text}}}};
    run("INSERT INTO events(session,value,time) VALUES(?,?,?)", {id, raw.dump(), raw["time"]});
    const int64_t revision = sqlite3_last_insert_rowid(db_);
    if (existing.empty()) {
      seq = historical
                ? query("SELECT MIN(0,COALESCE(MIN(seq),0))-1 AS seq FROM "
                        "(SELECT seq FROM history UNION ALL SELECT seq FROM events)")[0]["seq"]
                      .get<int64_t>()
                : revision;
      if (historical)
        run("INSERT INTO events(seq,session,value,time) VALUES(?,?,?,?)",
            {seq, id,
             Json{{"type", "external/archiveReference"},
                  {"data", {{"revision", revision}}},
                  {"time", raw["time"]}}
                 .dump(),
             raw["time"]});
      run("INSERT INTO external_items VALUES(?,?,?,?,?)", {id, turn, item_id, seq, fingerprint});
    } else
      run("UPDATE external_items SET fingerprint=? WHERE session=? AND turn=? AND item=?",
          {fingerprint, id, turn, item_id});
    if (!append) {
      run("DELETE FROM chunks WHERE seq=?", {seq});
      run("INSERT OR REPLACE INTO bodies VALUES(?,length(?),length(CAST(? AS BLOB)))",
          {seq, text, text});
      if (!text.empty())
        run("INSERT INTO chunks VALUES(?,0,?)", {seq, text});
    } else if (text.size() > previous.size()) {
      auto suffix = text.substr(previous.size());
      run("INSERT INTO chunks SELECT seq,size,? FROM bodies WHERE seq=?", {suffix, seq});
      run("UPDATE bodies SET size=size+length(?),bytes=bytes+length(CAST(? AS BLOB)) WHERE seq=?",
          {suffix, suffix, seq});
    }
    Json event = {{"seq", seq},
                  {"revision", revision},
                  {"time", raw["time"]},
                  {"type", type},
                  {"data", data}};
    if (event.dump().size() > 12000) {
      event["contentSeq"] = seq;
      event["data"] = {{"turnId", turn},
                       {"itemId", item_id},
                       {"message", "Large external message; expand to read"}};
      if (kind != "agentMessage" && kind != "userMessage")
        event["data"]["item"] = {
            {"id", item_id}, {"type", kind}, {"status", item.value("status", "")}};
    }
    run("INSERT OR REPLACE INTO history(seq,session,value,revision) VALUES(?,?,?,?)",
        {seq, id, event.dump(), revision});
    if (type == "user")
      run("UPDATE sessions SET "
          "value=json_set(value,'$.title',COALESCE(json_extract(value,'$.title'),substr(?,1,160))) "
          "WHERE id=?",
          {text, id});
    run("COMMIT");
    return event;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::archive_event(const std::string &id, const std::string &type, const Json &data) {
  const bool transaction = sqlite3_get_autocommit(db_) != 0;
  if (transaction)
    run("BEGIN IMMEDIATE");
  try {
    Json e = {{"type", type}, {"data", data}, {"time", now()}};
    run("INSERT INTO events(seq,session,value,time) SELECT MIN(0,COALESCE(MIN(seq),0))-1,?,?,? "
        "FROM events",
        {id, e.dump(), e["time"]});
    e["seq"] = sqlite3_last_insert_rowid(db_);
    auto result = project(id, e);
    if (transaction)
      run("COMMIT");
    return result;
  } catch (...) {
    if (transaction)
      run("ROLLBACK");
    throw;
  }
}
Json Store::project(const std::string &id, Json e) {
  const auto type = e.at("type").get<std::string>();
  const int64_t revision = std::max(int64_t(0), e.at("seq").get<int64_t>());
  e["revision"] = revision;
  if (revision > 0 && (type == "user" || type == "turn/started"))
    run("DELETE FROM streams WHERE session=?", {id});
  const auto &data = e.at("data");
  std::string key;
  bool delta = type == "item/agentMessage/delta" || type == "item/commandExecution/outputDelta" ||
               type == "item/fileChange/outputDelta";
  if (revision > 0 && data.is_object() && delta)
    key = type + ":" + data.value("turnId", "") + ":" + data.value("itemId", "");
  auto previous = key.empty()
                      ? Json::array()
                      : query("SELECT seq FROM streams WHERE session=? AND key=?", {id, key});
  if (!previous.empty()) {
    auto seq = previous[0]["seq"];
    auto body = query("SELECT size,bytes FROM bodies WHERE seq=?", {seq});
    if (body.empty()) {
      // Lazily import an existing projection without rewriting its authoritative events.
      run("INSERT INTO chunks SELECT seq,0,json_extract(value,'$.data.delta') FROM "
          "history WHERE seq=? AND length(COALESCE(json_extract(value,'$.data.delta'),''))>0",
          {seq});
      run("INSERT INTO bodies SELECT seq,length(COALESCE(json_extract(value,'$.data.delta'),'')),"
          "length(CAST(COALESCE(json_extract(value,'$.data.delta'),'') AS BLOB)) FROM history "
          "WHERE seq=?",
          {seq});
      body = query("SELECT size,bytes FROM bodies WHERE seq=?", {seq});
    }
    const auto text = data.value("delta", "");
    if (!text.empty()) {
      // Coalesce small deltas into a bounded tail. Offsets remain SQLite
      // Unicode character positions; the packing limit counts UTF-8 bytes.
      const auto tail = query("SELECT start,length(CAST(text AS BLOB)) AS bytes FROM chunks "
                              "WHERE seq=? ORDER BY start DESC LIMIT 1",
                              {seq});
      if (!tail.empty() && tail[0]["bytes"].get<int64_t>() + int64_t(text.size()) <= 4096)
        run("UPDATE chunks SET text=text||? WHERE seq=? AND start=?",
            {text, seq, tail[0]["start"]});
      else
        run("INSERT INTO chunks VALUES(?,?,?)", {seq, body[0]["size"], text});
      run("UPDATE bodies SET size=size+length(?),bytes=bytes+length(CAST(? AS BLOB)) WHERE seq=?",
          {text, text, seq});
    }
    // Small projections retain their inline form. Large bodies append chunks;
    // only bounded metadata is rewritten for each subsequent delta.
    if (body[0]["bytes"].get<int64_t>() + int64_t(text.size()) <= 12000)
      run("UPDATE history SET value=json_set(value,'$.data.delta',"
          "COALESCE(json_extract(value,'$.data.delta'),'') || ?,"
          "'$.revision',?),revision=? WHERE seq=?",
          {text, revision, revision, seq});
    else
      run("UPDATE history SET value=json_set(json_remove(value,'$.data.delta'),'$.contentSeq',seq,"
          "'$.revision',?),revision=? WHERE seq=?",
          {revision, revision, seq});
    e["seq"] = seq;
  } else {
    run("INSERT INTO history(seq,session,value,revision) VALUES(?,?,?,?)",
        {e["seq"], id, e.dump(), revision});
    if (!key.empty()) {
      const auto text = data.value("delta", "");
      run("INSERT INTO bodies VALUES(?,length(?),length(CAST(? AS BLOB)))", {e["seq"], text, text});
      if (!text.empty())
        run("INSERT INTO chunks VALUES(?,0,?)", {e["seq"], text});
      if (text.size() > 12000)
        run("UPDATE history SET "
            "value=json_set(json_remove(value,'$.data.delta'),'$.contentSeq',seq) WHERE seq=?",
            {e["seq"]});
    }
    if (!key.empty())
      run("INSERT OR REPLACE INTO streams VALUES(?,?,?)", {id, key, e["seq"]});
  }
  auto rows = query(
      "SELECT seq,CASE WHEN length(CAST(value AS BLOB))>16384 THEN "
      "json_object('type',json_extract(value,'$.type'),'time',json_extract(value,'$."
      "time'),'revision',revision,'contentSeq',seq,"
      "'data',json_object('message','Large content; expand to read',"
      "'turnId',json_extract(value,'$.data.turnId'),'itemId',json_extract(value,'$.data.itemId'),"
      "'item',CASE WHEN json_type(value,'$.data.item')='object' THEN "
      "json_object('id',json_extract(value,'$.data.item.id'),'type',json_extract(value,'$.data."
      "item.type'),"
      "'status',json_extract(value,'$.data.item.status'),'exitCode',json_extract(value,'$.data."
      "item.exitCode'),"
      "'command',substr(json_extract(value,'$.data.item.command'),1,240)) ELSE NULL END)) ELSE "
      "value END "
      "AS value FROM history WHERE seq=?",
      {e["seq"]});
  auto result = Json::parse(rows[0]["value"].get<std::string>());
  result["seq"] = rows[0]["seq"];
  return result;
}
Json Store::history(const std::string &id, int64_t before, int64_t after) {
  get(id);
  const bool forward = after >= 0;
  std::string order = "seq<? ORDER BY seq DESC";
  Json arguments = Json::array({id, before});
  if (forward) {
    order = "revision>? ORDER BY revision";
    arguments = Json::array({id, after});
  } else if (before == 0) {
    order = "1=1 ORDER BY seq DESC";
    arguments = Json::array({id});
  }
  auto rows = query(
      "SELECT seq,revision,CASE WHEN length(CAST(value AS BLOB))>16384 THEN "
      "json_object('type',json_extract(value,'$.type'),'time',json_extract(value,'$.time'),'"
      "revision',revision,'contentSeq',seq,"
      "'data',json_object('message','Large content; expand to read',"
      "'turnId',json_extract(value,'$.data.turnId'),'itemId',json_extract(value,'$.data.itemId'),"
      "'item',CASE WHEN json_type(value,'$.data.item')='object' THEN "
      "json_object('id',json_extract(value,'$.data.item.id'),'type',json_extract(value,'$.data."
      "item.type'),"
      "'status',json_extract(value,'$.data.item.status'),'exitCode',json_extract(value,'$.data."
      "item.exitCode'),"
      "'command',substr(json_extract(value,'$.data.item.command'),1,240)) ELSE NULL END)) ELSE "
      "value END AS value "
      "FROM history WHERE session=? AND " +
          order + " LIMIT 201",
      arguments);
  Json events = Json::array();
  size_t bytes = 0;
  for (auto &r : rows) {
    auto e = Json::parse(r["value"].get<std::string>());
    e["seq"] = r["seq"];
    e["revision"] = r["revision"];
    auto size = e.dump().size();
    if (events.size() == 200 || bytes + size > 96 * 1024)
      break;
    bytes += size;
    events.push_back(e);
  }
  const bool more = events.size() < rows.size();
  int64_t cursor =
      events.empty()
          ? (forward ? after : before)
          : (forward ? events.back().value("revision", events.back()["seq"].get<int64_t>())
                     : events.back()["seq"].get<int64_t>());
  if (!forward)
    std::reverse(events.begin(), events.end());
  auto latest =
      query("SELECT MAX(0,COALESCE(MAX(seq),0)) AS seq FROM events WHERE session=?", {id});
  return {{"events", events},
          {"more", more},
          {"cursor", cursor},
          {"snapshotSeq", latest[0]["seq"]},
          {"direction", forward ? "after" : "before"}};
}
Json Store::content(const std::string &id, int64_t seq, int64_t offset, int64_t revision) {
  auto body = query("SELECT bodies.size,history.revision FROM bodies JOIN history USING(seq) WHERE "
                    "seq=? AND session=?",
                    {seq, id});
  if (!body.empty()) {
    const auto current = body[0]["revision"].get<int64_t>();
    if (revision >= 0 && current != revision)
      throw Error("CONTENT_CHANGED", "Content changed; restart reading from offset zero");
    const auto size = body[0]["size"].get<int64_t>();
    if (offset < 0 || offset > size)
      throw Error("INVALID_REQUEST", "Invalid content offset");
    auto start =
        query("SELECT start FROM chunks WHERE seq=? AND start<=? ORDER BY start DESC LIMIT 1",
              {seq, offset});
    std::string text;
    if (!start.empty())
      for (auto &row : query(
               "SELECT substr(text,MAX(0,?-start)+1,MIN(length(text),?+4096-start)-MAX(0,?-start)) "
               "AS text FROM chunks WHERE seq=? AND start>=? AND start<?+4096 ORDER BY start",
               {offset, offset, offset, seq, start[0]["start"], offset}))
        text += row["text"].get<std::string>();
    int64_t characters = 0;
    for (unsigned char c : text)
      if ((c & 0xc0) != 0x80)
        ++characters;
    if (characters != std::min(int64_t(4096), size - offset))
      throw Error("CONTENT_UNAVAILABLE", "History body chunks are incomplete");
    return {{"seq", seq},
            {"revision", current},
            {"offset", offset},
            {"text", text},
            {"nextOffset", std::min(size, offset + 4096)},
            {"more", offset + 4096 < size}};
  }

  auto rows =
      query("WITH content AS (SELECT COALESCE(json_extract(value,'$.data.text'),"
            "json_extract(value,'$.data.delta'),json_extract(value,'$.data.item.aggregatedOutput'),"
            "value) AS text,revision "
            "FROM history WHERE session=? AND seq=?) "
            "SELECT substr(text,?+1,4096) AS text,length(text) AS size,revision FROM content",
            {id, seq, offset});
  if (rows.empty())
    throw Error("CONTENT_NOT_FOUND", "Unknown session content");
  if (revision >= 0 && rows[0]["revision"] != revision)
    throw Error("CONTENT_CHANGED", "Content changed; restart reading from offset zero");
  auto text = rows[0]["text"].get<std::string>();
  // SQLite offsets count Unicode characters, not UTF-8 bytes.
  int64_t count = 0;
  for (unsigned char c : text)
    if ((c & 0xc0) != 0x80)
      ++count;
  return {{"seq", seq},
          {"revision", rows[0]["revision"]},
          {"offset", offset},
          {"text", text},
          {"nextOffset", offset + count},
          {"more", offset + count < rows[0]["size"].get<int64_t>()}};
}
Json Store::replay(const std::string &id, int64_t after) {
  auto page = history(id, 0, after);
  // Events are retained under the history quota; admission refuses growth before pruning.
  page["gap"] = false;
  return page;
}
Json Store::cache_get(const std::string &key) {
  auto rows = query("SELECT value FROM cache WHERE key=?", {cache_namespace_ + key});
  return rows.empty() ? Json() : Json::parse(rows[0]["value"].get<std::string>());
}
bool Store::cache_replace(const std::string &key, const Json &previous, const Json &value) {
  run("BEGIN IMMEDIATE");
  try {
    const bool matches = cache_get(key) == previous;
    if (matches)
      cache_put(key, value);
    run("COMMIT");
    return matches;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::cache_clear() {
  run("BEGIN IMMEDIATE");
  try {
    for (const auto &record :
         query("SELECT c.key FROM cache c JOIN transport2_cache_entries e ON "
               "e.key=c.key WHERE e.scope=? AND "
               "NOT EXISTS(SELECT 1 FROM transport2_local_credit b WHERE "
               "b.key=c.key) AND substr(c.key,?+1) NOT LIKE "
               "'/ws/v1/cli/%:delivery' AND substr(c.key,?+1) NOT LIKE "
               "'/ws/v1/cli/%:output'",
               {cache_namespace_, cache_namespace_.size(), cache_namespace_.size()}))
      cache_forget(record.at("key"));
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::history_compact() {
  // The scan position is only a scheduling hint: a restart may safely rescan.
  // Bound both rows and returned text, including legacy oversized chunks.
  run("BEGIN IMMEDIATE");
  try {
    std::map<std::string, Json> original_budget;
    for (const auto &scope : query("SELECT scope,bytes,records FROM transport2_history_budget"))
      original_budget.emplace(scope.at("scope").get<std::string>(), scope);
    const auto guard = query("SELECT sql FROM sqlite_master WHERE type='trigger' "
                             "AND name='transport2_history_capacity'");
    if (guard.size() != 1 || !guard.at(0).at("sql").is_string())
      throw Error("STORAGE_ERROR", "Missing history capacity guard");
    // SQLite's write lock prevents another writer from borrowing the temporary
    // accounting gap. Restore the guard and prove net non-growth before commit.
    // DDL is transactional: failure/crash restores the guard and original body.
    const auto rows =
        query("SELECT seq,start,CASE WHEN length(CAST(text AS BLOB))<=4096 THEN text ELSE NULL END "
              "AS text,length(text) AS size FROM chunks WHERE (seq,start)>(?,?) "
              "ORDER BY seq,start LIMIT 128",
              {history_pack_seq_, history_pack_start_});
    int merged = 0;
    for (const auto &row : rows) {
      if (row.at("text").is_null() || row.at("start") == 0)
        continue;
      const auto eligible = query(
          "SELECT h.session FROM history h JOIN transport2_history_budget b ON b.scope=h.session "
          "WHERE h.seq=? AND NOT EXISTS "
          "(SELECT 1 FROM transport2_history_entries r WHERE r.key='reservation:'||h.session)",
          {row.at("seq")});
      if (eligible.empty())
        continue;
      const auto previous =
          query("SELECT start,length(text) AS size,CASE WHEN length(CAST(text AS BLOB))<=4096 "
                "THEN text ELSE NULL END AS text FROM chunks WHERE seq=? AND start<? "
                "ORDER BY start DESC LIMIT 1",
                {row.at("seq"), row.at("start")});
      if (previous.empty() || previous.at(0).at("text").is_null())
        continue;
      const auto &tail = previous.at(0);
      const auto combined = tail.at("text").get<std::string>() + row.at("text").get<std::string>();
      if (combined.size() > 4096 ||
          tail.at("start").get<int64_t>() + tail.at("size").get<int64_t>() != row.at("start"))
        continue;
      // Refund the absorbed row first; the final charge is smaller. Both mutations
      // and their accounting triggers commit with unchanged body/revision metadata.
      if (merged == 0)
        run("DROP TRIGGER transport2_history_capacity");
      run("DELETE FROM chunks WHERE seq=? AND start=?", {row.at("seq"), row.at("start")});
      run("UPDATE chunks SET text=? WHERE seq=? AND start=?",
          {combined, row.at("seq"), tail.at("start")});
      const auto verified = query("SELECT text FROM chunks WHERE seq=? AND start=?",
                                  {row.at("seq"), tail.at("start")});
      if (verified.size() != 1 || verified.at(0).at("text") != combined)
        throw Error("STORAGE_ERROR", "History packing verification failed");
      ++merged;
    }
    for (const auto &scope : query("SELECT scope,bytes,records FROM transport2_history_budget")) {
      const auto previous = original_budget.find(scope.at("scope").get<std::string>());
      if (previous == original_budget.end() || scope.at("bytes") < 0 || scope.at("records") < 0 ||
          scope.at("bytes") > previous->second.at("bytes") ||
          scope.at("records") > previous->second.at("records"))
        throw Error("STORAGE_ERROR", "History packing increased committed resource usage");
    }
    if (merged > 0)
      run(guard.at(0).at("sql").get<std::string>());
    run("COMMIT");
    if (rows.size() < 128) {
      history_pack_seq_ = std::numeric_limits<int64_t>::min();
      history_pack_start_ = -1;
    } else {
      history_pack_seq_ = rows.back().at("seq");
      history_pack_start_ = rows.back().at("start");
    }
    return {{"scanned", rows.size()}, {"merged", merged}};
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::cleanup() {
  history_compact();
  run("BEGIN IMMEDIATE");
  try {
    for (const auto &record : query("SELECT key FROM cache WHERE key GLOB 'upload:*' AND "
                                    "json_extract(value,'$.completedAt')<=? ORDER BY "
                                    "json_extract(value,'$.completedAt') LIMIT 100",
                                    {now() - 86400000}))
      cache_forget(record.at("key"));
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
  // Retain request identities, including unconfirmed side effects. Expiry could
  // turn a delayed retry into a second execution. Cleanup is explicit/offline.
}
} // namespace coc
