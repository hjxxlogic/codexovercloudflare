#pragma once
#include "common.hpp"
#include <functional>
#include <limits>
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
  Json history_policy_;
  int64_t history_pack_seq_ = std::numeric_limits<int64_t>::min();
  int64_t history_pack_start_ = -1;
  int64_t history_prepare_seq_ = std::numeric_limits<int64_t>::min();
  Lock lock_;
  sqlite3 *db_ = nullptr;
  std::string delivery_instance_;
  std::string cache_namespace_;
  void cache_forget(const std::string &physical_key);
  void cache_uncharge(const std::string &physical_key);
  void history_budget_init(bool authoritative);
  std::string operation_key(const Json &intent);
  void local_operation_save(const std::string &request, const Json &record);
  std::map<std::string, sqlite3_stmt *> statements_;
  void clear_statements();
  void delivery_check_control(const std::string &stream);
  void delivery_reserve(const std::string &stream, const std::string &session,
                        const std::string &lane, int64_t slots, int64_t bytes);
  void delivery_release(const std::string &stream);
  std::function<void()> storage_failure_;
  [[noreturn]] void fail(int code);
  Json project(const std::string &id, Json event);
  Json query(const std::string &sql, const Json &args = Json::array());
  void run(const std::string &sql, const Json &args = Json::array());

public:
  explicit Store(const std::string &dir, bool authoritative = true,
                 const std::string &cache_namespace = "",
                 const Json &history_policy = Json::object());
  ~Store();
  Store(const Store &) = delete;
  Store &operator=(const Store &) = delete;
  void on_failure(std::function<void()> callback) { storage_failure_ = std::move(callback); }
  void save(const Json &session);
  Json sessions(bool active_only = false);
  Json session_page(const Json &filters);
  Json get(const std::string &id);
  Json event(const std::string &id, const std::string &type, const Json &data);
  Json event_batch(const Json &entries);
  Json replay(const std::string &id, int64_t after);
  Json history(const std::string &id, int64_t before = 0, int64_t after = -1);
  Json history_subscription(const Json &request);
  Json history_hint(const Json &request);
  Json history_budget();
  Json history_compact();
  Json history_source_register(const std::string &session, int64_t seq, const Json &origin,
                               const Json &entry, const Json &expected = nullptr);
  Json history_source(const std::string &session, int64_t seq, const Json &origin);
  Json history_source_candidate();
  Json history_source_plan(const std::string &session, int64_t seq);
  Json history_recovered_content(const std::string &session, const Json &reference,
                                 const Json &origin, const Json &entry, int64_t offset);
  std::string history_source_recover(const std::string &session, int64_t seq, const Json &origin,
                                     const Json &entry);

  void history_reserve(const std::string &session, int64_t bytes, int64_t records = 1);
  void history_release(const std::string &session);
  void history_require_capacity(const std::string &session, int64_t bytes, int64_t records);
  Json operation_begin(const Json &intent, const std::string &action, const Json &data);
  void operation_session(const std::string &key, const Json &session);
  Json operation_finish(const std::string &key, Json envelope);
  Json operation_ack(const Json &intent, const std::string &action, const Json &data);
  Json operation_budget();
  Json upload_record(const std::string &root, const std::string &owner, const std::string &id);
  Json upload_prepare(const std::string &root, const std::string &owner, const std::string &id,
                      const Json &body);
  void upload_complete(const std::string &root, const std::string &owner, const std::string &id,
                       const Json &result, bool reclaimed);
  Json upload_budget();
  Json local_operation(const std::string &request);
  Json local_operation_prepare(const std::string &request, const std::string &path,
                               const Json &body, const std::string &instance);
  void local_operation_finish(const std::string &request, const Json &envelope,
                              const Json &receipt);
  void local_operation_confirm(const std::string &request);
  Json history_reference(const std::string &id, int64_t seq);
  Json history_content(const std::string &id, const Json &reference, int64_t offset);
  Json content(const std::string &id, int64_t seq, int64_t offset, int64_t revision = -1);
  void archive_page(const std::string &id, const Json &events, const Json &cursor);
  Json external_item(const std::string &id, const std::string &turn, Json item,
                     bool historical = false);
  Json archive_event(const std::string &id, const std::string &type, const Json &data);
  const std::string &delivery_instance() const { return delivery_instance_; }
  Json control_state(const std::string &session);
  Json control_apply(const std::string &session, int64_t epoch, const std::string &control_id,
                     const std::string &owner);
  void delivery_bind(const std::string &stream, int64_t epoch, const std::string &control_id);
  Json delivery_target(const std::string &stream, int64_t seq);
  Json delivery_cancel(const std::string &session, const Json &target);
  Json delivery_open(const std::string &stream, const std::string &session, int64_t slots,
                     int64_t bytes, const std::string &lane = "normal");
  Json delivery_window(const std::string &stream);
  void delivery_verify(const std::string &stream, const Json &allocation);
  void delivery_close(const std::string &stream);
  void delivery_retire_session(const std::string &session);
  Json delivery_budget();
  void delivery_scope(const std::string &stream, const std::string &session);
  Json delivery_receive(const std::string &stream, int64_t seq, int64_t end,
                        const std::string &body);
  bool delivery_start(const std::string &stream, int64_t seq);
  void delivery_finish(const std::string &stream, int64_t seq, const Json &result);
  Json delivery_result_state(const std::string &stream);
  bool delivery_result_pending(const std::string &stream);
  void delivery_result_ack(const std::string &stream, int64_t received, int64_t bytes);
  Json delivery_content(const std::string &stream, int64_t result_seq, int64_t offset);
  Json delivery_results(const std::string &stream, int64_t after);
  Json delivery_record(const std::string &stream, int64_t seq);
  Json delivery_heads(const std::string &session);
  Json output_state(const std::string &stream);
  Json output_append(const std::string &stream, const Json &payload);
  void output_ack(const std::string &stream, int64_t received, int64_t byte_credit = -1);
  Json output_receive(const std::string &key, int64_t seq, int64_t end, const std::string &body,
                      const std::string &instance);
  void output_consumed(const std::string &key, int64_t seq);
  void output_publish(const std::string &stream, int64_t sent);
  Json output_page(const std::string &stream, int64_t after);
  void cleanup();
  void cache_put(const std::string &key, const Json &value);
  bool cache_replace(const std::string &key, const Json &previous, const Json &value);
  void local_reserve(const std::string &key, const std::string &kind);
  Json local_budget();
  Json cache_get(const std::string &key);
  void cache_clear();
};
} // namespace coc
