#include "coc/store.hpp"
#include <fcntl.h>
#include <memory>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
namespace coc {
Store::Lock::Lock(const std::string &dir) {
  std::filesystem::create_directories(dir);
  chmod(dir.c_str(), 0700);
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
Store::Store(const std::string &dir) : lock_(dir) {
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
    for (auto &s : sessions())
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
  run("INSERT INTO events(session,value,time) VALUES(?,?,?)", {id, e.dump(), e["time"]});
  e["seq"] = sqlite3_last_insert_rowid(db_);
  return e;
}
Json Store::replay(const std::string &id, int64_t after) {
  auto rows =
      query("SELECT seq,value FROM events WHERE session=? AND seq>? ORDER BY seq LIMIT 1000",
            {id, after});
  auto first = query("SELECT MIN(seq) AS seq FROM events WHERE session=?", {id});
  bool pruned = !query("SELECT value FROM requests WHERE key=?", {"pruned:" + id}).empty();
  Json events = Json::array();
  for (auto &r : rows) {
    auto e = Json::parse(r["value"].get<std::string>());
    e["seq"] = r["seq"];
    events.push_back(e);
  }
  return {{"gap", pruned && (first[0]["seq"].is_null() || after < first[0]["seq"].get<int64_t>())},
          {"events", events},
          {"more", rows.size() == 1000}};
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
void Store::cleanup() {
  auto cutoff = now() - 7LL * 86400000;
  run("DELETE FROM requests WHERE time<? AND key NOT LIKE ?", {cutoff, "pruned:%"});
  auto size = [&] {
    auto v = query("SELECT SUM(length(value)) AS size FROM events")[0]["size"];
    return v.is_null() ? int64_t(0) : v.get<int64_t>();
  };
  for (auto &s : sessions())
    if (s["state"] != "ready" &&
        (s["createdAt"].get<int64_t>() < cutoff || size() > 1024LL * 1024 * 1024)) {
      run("DELETE FROM events WHERE session=?", {s["id"]});
      run("INSERT OR REPLACE INTO requests VALUES(?,?,?,?)",
          {"pruned:" + s["id"].get<std::string>(), "pruned", "true", now()});
    }
  if (size() > 1024LL * 1024 * 1024)
    throw Error("STORAGE_FULL", "Active event log exceeded storage quota");
}
} // namespace coc
