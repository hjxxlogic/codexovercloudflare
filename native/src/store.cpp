#include "coc/store.hpp"
#include <algorithm>
#include <fcntl.h>
#include <memory>
#include <openssl/sha.h>
#ifndef _WIN32
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#else
#include "coc/windows.hpp"
#endif
namespace coc {
void Store::fail(int code) {
  if (storage_failure_)
    storage_failure_();
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
Store::Store(const std::string &dir, bool authoritative) : lock_(dir, authoritative) {
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
    run("CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,value "
        "TEXT,time INTEGER NOT NULL)");
    run("CREATE TABLE IF NOT EXISTS request_states(key TEXT PRIMARY KEY,state TEXT NOT NULL)");
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
      run("INSERT INTO history SELECT seq,session,value,MAX(0,seq) FROM events");
    run("CREATE TABLE IF NOT EXISTS external_items(session TEXT NOT NULL,turn TEXT NOT NULL,item "
        "TEXT NOT NULL,"
        "seq INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(session,turn,item))");
    run("CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    run("CREATE INDEX IF NOT EXISTS cache_upload_expiry ON "
        "cache(json_extract(value,'$.completedAt')) WHERE key GLOB 'upload:*'");
    run("COMMIT");
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
  run("INSERT OR REPLACE INTO sessions VALUES(?,?)", {s.at("id"), value.dump()});
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
Json Store::request_status(const std::string &key) {
  auto rows = query("SELECT value FROM requests WHERE key=?", {key});
  if (rows.empty())
    return {{"state", "not_found"}};
  if (rows[0]["value"].is_null()) {
    auto state = query("SELECT state FROM request_states WHERE key=?", {key});
    return {{"state", state.empty() ? Json("unknown") : state[0]["state"]}};
  }
  auto value = Json::parse(rows[0]["value"].get<std::string>());
  return {{"state", value.contains("requestError") ? "failed" : "completed"}, {"result", value}};
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
  item = redact(std::move(item));
  const auto item_id = item.at("id").get<std::string>();
  if (item_id.empty() || item_id.size() > 200 || turn.size() > 200)
    throw Error("INVALID_FRAME", "Invalid external item identity");
  auto serialized = item.dump();
  unsigned char hash[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char *>(serialized.data()), serialized.size(), hash);
  std::string fingerprint;
  for (auto byte : hash) {
    fingerprint += "0123456789abcdef"[byte >> 4];
    fingerprint += "0123456789abcdef"[byte & 15];
  }
  auto existing =
      query("SELECT seq,fingerprint FROM external_items WHERE session=? AND turn=? AND item=?",
            {id, turn, item_id});
  if (!existing.empty() && existing[0]["fingerprint"] == fingerprint)
    return nullptr;
  const auto kind = item.value("type", "");
  std::string type = item.value("status", "") == "inProgress" ? "item/started" : "item/completed";
  std::string text = serialized;
  Json data = {{"turnId", turn}, {"itemId", item_id}, {"item", item}};
  if (kind == "agentMessage") {
    type = "item/agentMessage/delta";
    text = item.value("text", "");
    data = {{"turnId", turn}, {"itemId", item_id}, {"delta", text}};
  } else if (kind == "userMessage") {
    type = "user";
    text.clear();
    for (auto &part : item.value("content", Json::array()))
      if (part.value("type", "") == "text")
        text += part.value("text", "");
    data = {{"turnId", turn}, {"itemId", item_id}, {"text", text}};
  }
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
    run("INSERT OR REPLACE INTO history VALUES(?,?,?,?)", {seq, id, event.dump(), revision});
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
  Json e = {{"type", type}, {"data", data}, {"time", now()}};
  run("INSERT INTO events(seq,session,value,time) SELECT MIN(0,COALESCE(MIN(seq),0))-1,?,?,? "
      "FROM events",
      {id, e.dump(), e["time"]});
  e["seq"] = sqlite3_last_insert_rowid(db_);
  return project(id, e);
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
    run("INSERT INTO history VALUES(?,?,?,?)", {e["seq"], id, e.dump(), revision});
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
  auto first = query("SELECT MIN(seq) AS seq FROM events WHERE session=?", {id});
  bool pruned = !query("SELECT value FROM requests WHERE key=?", {"pruned:" + id}).empty();
  page["gap"] = pruned && (first[0]["seq"].is_null() || after < first[0]["seq"].get<int64_t>());
  return page;
}
Json Store::begin(const std::string &key, const std::string &fp) {
  auto r = query("SELECT fingerprint,value FROM requests WHERE key=?", {key});
  if (!r.empty()) {
    if (r[0]["fingerprint"] != fp)
      throw Error("IDEMPOTENCY_CONFLICT", "Request ID was used for different content");
    if (r[0]["value"].is_null())
      throw Error("RESULT_UNKNOWN", "Previous request may have executed; inspect session state");
    auto value = Json::parse(r[0]["value"].get<std::string>());
    if (value.contains("requestError"))
      throw Error(value["requestError"]["code"], value["requestError"]["message"]);
    return {{"cached", true}, {"value", value}};
  }
  run("INSERT INTO requests VALUES(?,?,NULL,?)", {key, fp, now()});
  run("INSERT OR REPLACE INTO request_states VALUES(?,?)", {key, "received"});
  return {{"cached", false}};
}
void Store::submitted(const std::string &key) {
  run("INSERT OR REPLACE INTO request_states VALUES(?,?)", {key, "submitted"});
}
void Store::finish(const std::string &key, const Json &v) {
  run("UPDATE requests SET value=? WHERE key=?", {v.dump(), key});
  run("INSERT OR REPLACE INTO request_states VALUES(?,?)",
      {key, v.contains("requestError") ? "failed" : "completed"});
}
void Store::cache_put(const std::string &key, const Json &value) {
  run("INSERT OR REPLACE INTO cache VALUES(?,?)", {key, value.dump()});
}
Json Store::cache_get(const std::string &key) {
  auto rows = query("SELECT value FROM cache WHERE key=?", {key});
  return rows.empty() ? Json() : Json::parse(rows[0]["value"].get<std::string>());
}
void Store::cache_clear() { run("DELETE FROM cache"); }
void Store::cleanup() {
  run("DELETE FROM cache WHERE key IN (SELECT key FROM cache WHERE key GLOB 'upload:*' AND "
      "json_extract(value,'$.completedAt')<=? ORDER BY json_extract(value,'$.completedAt') LIMIT "
      "100)",
      {now() - 86400000});
  // Retain request identities, including unconfirmed side effects. Expiry could
  // turn a delayed retry into a second execution. Cleanup is explicit/offline.
}
} // namespace coc
