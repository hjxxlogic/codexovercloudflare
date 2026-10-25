#pragma once
#include "common.hpp"
#include <functional>
#include <map>
#include <sqlite3.h>
namespace coc {
class Store {
  struct Lock {
    int fd = -1;
    explicit Lock(const std::string &dir, bool exclusive);
    ~Lock();
  };
  Lock lock_;
  sqlite3 *db_ = nullptr;
  std::map<std::string, sqlite3_stmt *> statements_;
  void clear_statements();
  std::function<void()> storage_failure_;
  [[noreturn]] void fail(int code);
  Json project(const std::string &id, Json event);
  Json query(const std::string &sql, const Json &args = Json::array());
  void run(const std::string &sql, const Json &args = Json::array());

public:
  explicit Store(const std::string &dir, bool authoritative = true);
  ~Store();
  Store(const Store &) = delete;
  Store &operator=(const Store &) = delete;
  void on_failure(std::function<void()> callback) { storage_failure_ = std::move(callback); }
  void save(const Json &session);
  Json sessions(bool active_only = false);
  Json session_page(const Json &filters);
  Json request_status(const std::string &key);
  Json get(const std::string &id);
  Json event(const std::string &id, const std::string &type, const Json &data);
  Json event_batch(const Json &entries);
  Json replay(const std::string &id, int64_t after);
  Json history(const std::string &id, int64_t before = 0, int64_t after = -1);
  Json content(const std::string &id, int64_t seq, int64_t offset, int64_t revision = -1);
  void archive_page(const std::string &id, const Json &events, const Json &cursor);
  Json archive_event(const std::string &id, const std::string &type, const Json &data);
  Json begin(const std::string &key, const std::string &fingerprint);
  void submitted(const std::string &key);
  void finish(const std::string &key, const Json &value);
  void cleanup();
  void cache_put(const std::string &key, const Json &value);
  Json cache_get(const std::string &key);
  void cache_clear();
};
} // namespace coc
