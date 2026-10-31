#pragma once
#include "store.hpp"
#include <functional>
#include <set>
namespace coc {
std::string rpc_delivery_lane(const Json &message);
class CommandDelivery {
  Store &store_;
  std::string key_;
  Json state_, windows_ = Json::object();
  std::set<std::string> attempted_;
  std::function<void(Json)> send_, result_;
  void save();
  void flush();
  int64_t received_results(const std::string &lane) const;
  Json opening() const;

public:
  CommandDelivery(Store &, std::string, std::function<void(Json)>);
  const std::string stream() const { return state_.at("stream").get<std::string>(); }
  void connect(std::function<void(Json)>);
  void disconnect();
  void submit(const Json &);
  bool receive(const Json &);
  void retry();
  bool pending() const;
  bool ready() const { return windows_.contains("normal") && windows_.contains("priority"); }
};
} // namespace coc
