#pragma once
#include "common.hpp"
#include <functional>
#include <map>
#include <sqlite3.h>
namespace coc {
class Store {
public:
  struct Lock {
#ifdef _WIN32
    void *handle = nullptr;
#else
    int fd = -1;
#endif
    explicit Lock(const std::string &dir, bool exclusive);
    ~Lock();
    Lock(const Lock &) = delete;
    Lock &operator=(const Lock &) = delete;
  };

private:
  Lock lock_;
  sqlite3 *db_ = nullptr;
  std::string delivery_instance_;
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
  Json external_item(const std::string &id, const std::string &turn, Json item,
                     bool historical = false);
  Json archive_event(const std::string &id, const std::string &type, const Json &data);
  Json begin(const std::string &key, const std::string &fingerprint);
  void submitted(const std::string &key);
  void finish(const std::string &key, const Json &value);
  const std::string &delivery_instance() const { return delivery_instance_; }
  Json delivery_open(const std::string &stream, const std::string &session, int64_t slots,
                     int64_t bytes);
  Json delivery_window(const std::string &stream);
  Json delivery_receive(const std::string &stream, int64_t seq, int64_t end,
                        const std::string &body);
  bool delivery_start(const std::string &stream, int64_t seq);
  void delivery_finish(const std::string &stream, int64_t seq, const Json &result);
  Json delivery_record(const std::string &stream, int64_t seq);
  Json delivery_heads(const std::string &session);
  Json output_state(const std::string &stream);
  Json output_append(const std::string &stream, const Json &payload);
  void output_ack(const std::string &stream, int64_t received, int64_t byte_credit = -1);
  void output_publish(const std::string &stream, int64_t sent);
  Json output_page(const std::string &stream, int64_t after);
  void cleanup();
  void cache_put(const std::string &key, const Json &value);
  Json cache_get(const std::string &key);
  void cache_clear();
};
} // namespace coc
