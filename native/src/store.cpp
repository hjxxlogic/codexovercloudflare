#include "coc/store.hpp"
#include <algorithm>
#include <fcntl.h>
#include <memory>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
namespace coc {
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

Json Store::query(const std::string &sql, const Json &args) {
  sqlite3_stmt *raw = nullptr;
  if (sqlite3_prepare_v2(db_, sql.c_str(), -1, &raw, nullptr) != SQLITE_OK)
    throw Error("STORAGE_ERROR", "Cannot prepare journal query");
  std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> s(raw, sqlite3_finalize);
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
      throw Error("STORAGE_ERROR", "Cannot bind journal query");
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
    throw Error("STORAGE_ERROR", "Journal operation failed");
  return rows;
}
void Store::run(const std::string &s, const Json &a) { query(s, a); }
Store::Store(const std::string &dir, bool authoritative) : lock_(dir, authoritative) {
  std::filesystem::create_directories(dir);
  chmod(dir.c_str(), 0700);
  auto path = std::filesystem::path(dir) / "agent.db";
  if (sqlite3_open(path.c_str(), &db_) != SQLITE_OK) {
    if (db_)
      sqlite3_close(db_);
    throw Error("STORAGE_ERROR", "Cannot open journal");
  }
  chmod(path.c_str(), 0600);
  sqlite3_busy_timeout(db_, 5000);
  try {
    run("PRAGMA journal_mode=WAL");
    run("CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
    run("CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT NOT "
        "NULL,value TEXT NOT NULL,time INTEGER NOT NULL)");
    run("CREATE INDEX IF NOT EXISTS events_session ON events(session,seq)");
    run("CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,value "
        "TEXT,time INTEGER NOT NULL)");
    run("BEGIN IMMEDIATE");
    const bool migrate =
        query("SELECT name FROM sqlite_master WHERE type='table' AND name='history'").empty();
    run("CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY,session TEXT NOT NULL,value "
        "TEXT NOT NULL,revision INTEGER NOT NULL)");
    run("CREATE INDEX IF NOT EXISTS history_session ON history(session,seq)");
    run("CREATE INDEX IF NOT EXISTS history_revision ON history(session,revision)");
    run("CREATE TABLE IF NOT EXISTS streams(session TEXT,key TEXT,seq INTEGER,PRIMARY "
        "KEY(session,key))");
    if (migrate)
      run("INSERT INTO history SELECT seq,session,value,MAX(0,seq) FROM events");
    run("CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    run("COMMIT");
    for (auto &s : authoritative ? sessions() : Json::array())
      if (s["state"] == "ready") {
        s["state"] = "failed";
        s["running"] = false;
        save(s);
      }
  } catch (...) {
    sqlite3_close(db_);
    db_ = nullptr;
    throw;
  }
}
Store::~Store() {
  if (db_)
    sqlite3_close(db_);
}
void Store::save(const Json &s) {
  run("INSERT OR REPLACE INTO sessions VALUES(?,?)", {s.at("id"), s.dump()});
}
Json Store::sessions() {
  Json result = Json::array();
  for (auto &r : query("SELECT value FROM sessions"))
    result.push_back(Json::parse(r["value"].get<std::string>()));
  return result;
}
Json Store::get(const std::string &id) {
  auto r = query("SELECT value FROM sessions WHERE id=?", {id});
  if (r.empty())
    throw Error("SESSION_NOT_FOUND", "Unknown session");
  return Json::parse(r[0]["value"].get<std::string>());
}
Json Store::event(const std::string &id, const std::string &type, const Json &data) {
  Json e = {{"type", type}, {"data", data}, {"time", now()}};
  run("BEGIN IMMEDIATE");
  try {
    run("INSERT INTO events(session,value,time) VALUES(?,?,?)", {id, e.dump(), e["time"]});
    e["seq"] = sqlite3_last_insert_rowid(db_);
    auto result = project(id, e);
    run("COMMIT");
    return result;
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
    run("UPDATE history SET "
        "value=json_set(value,'$.data.delta',COALESCE(json_extract(value,'$.data.delta'),'')||?,'$."
        "revision',?),revision=? WHERE seq=?",
        {data.value("delta", ""), revision, revision, seq});
    e["seq"] = seq;
  } else {
    run("INSERT INTO history VALUES(?,?,?,?)", {e["seq"], id, e.dump(), revision});
    if (!key.empty())
      run("INSERT OR REPLACE INTO streams VALUES(?,?,?)", {id, key, e["seq"]});
  }
  auto rows = query("SELECT seq,CASE WHEN length(CAST(value AS BLOB))>16384 THEN "
                    "json_object('type',json_extract(value,'$.type'),'time',json_extract(value,'$."
                    "time'),'revision',revision,'contentSeq',seq,"
                    "'data',json_object('message','Large content; expand to read')) ELSE value END "
                    "AS value FROM history WHERE seq=?",
                    {e["seq"]});
  auto result = Json::parse(rows[0]["value"].get<std::string>());
  result["seq"] = rows[0]["seq"];
  return result;
}
Json Store::history(const std::string &id, int64_t before, int64_t after) {
  get(id);
  const bool forward = after >= 0;
  auto rows = query(
      "SELECT seq,revision,CASE WHEN length(CAST(value AS BLOB))>16384 THEN "
      "json_object('type',json_extract(value,'$.type'),'time',json_extract(value,'$.time'),'"
      "revision',revision,'contentSeq',seq,"
      "'data',json_object('message','Large content; expand to read')) ELSE value END AS value "
      "FROM history WHERE session=? AND " +
          std::string(forward ? "revision>? ORDER BY revision"
                              : before == 0 ? "1=1 ORDER BY seq DESC" : "seq<? ORDER BY seq DESC") +
          " LIMIT 201",
      forward ? Json::array({id, after})
              : before == 0 ? Json::array({id}) : Json::array({id, before}));
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
    return {{"cached", true}, {"value", Json::parse(r[0]["value"].get<std::string>())}};
  }
  run("INSERT INTO requests VALUES(?,?,NULL,?)", {key, fp, now()});
  return {{"cached", false}};
}
void Store::finish(const std::string &key, const Json &v) {
  run("UPDATE requests SET value=? WHERE key=?", {v.dump(), key});
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
  // History is authoritative local data. Only expire request deduplication entries.
  run("DELETE FROM requests WHERE time<? AND key NOT LIKE ?", {now() - 7LL * 86400000, "pruned:%"});
}
} // namespace coc
