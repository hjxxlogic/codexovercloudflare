#pragma once
#include "store.hpp"
#include <functional>
#include <set>
namespace coc {
Json history_reference_descriptor(const Json &);
std::string delivery_digest(const std::string &body);
std::string delivery_request_key(const Json &original);
Json delivery_failure(const Json &original, const std::string &code, const std::string &message);
std::string rpc_delivery_lane(const Json &message);
class CommandDelivery {
  Store &store_;
  std::string key_;
  Json control_;
  Json transfers_ = Json::object();
  Json state_, windows_ = Json::object(), baseline_ = Json::object();
  std::string exchange_id_;
  std::set<std::string> snapshots_;
  bool frozen_ = false;
  uint64_t progress_ = 0;
  void begin_recovery();
  Json receive_result(const std::string &lane, const Json &result, const Json &window);
  std::set<std::string> attempted_;
  std::function<void(Json)> send_, result_;
  void save();
  void flush();
  int64_t received_results(const std::string &lane) const;
  Json opening() const;

public:
  CommandDelivery(Store &, std::string, std::function<void(Json)>);
  const std::string stream() const { return state_.at("stream").get<std::string>(); }
  void connect(std::function<void(Json)>, const Json &control = nullptr);
  void disconnect();
  void submit(const Json &);
  bool cancel_unpublished(const Json &id);
  void observe(const Json &payload);
  bool receive(const Json &);
  void retry();
  bool pending() const;
  uint64_t progress() const { return progress_; }
  bool ready() const { return snapshots_.size() == 2; }
};
} // namespace coc
