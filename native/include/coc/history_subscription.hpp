#pragma once
#include "process.hpp"
#include "store.hpp"
namespace coc {
// History bodies are shared in the Agent journal. This owns only a reader's
// persistent identity/confirmation floor and one bounded retry exchange.
class HistorySubscription {
  Store &store_;
  std::string key_, exchange_, request_;
  Json saved_;
  asio::steady_timer retry_;
  std::function<int64_t()> durable_;
  std::function<void(Json)> send_;
  std::function<void(int64_t)> dirty_;
  std::function<void()> ready_;
  std::function<void(const Json &)> failed_;
  int64_t maximum_ = 0, pending_ = -1, published_ = 0;
  int attempts_ = 0;
  bool opened_ = false, stopped_ = false;
  void transmit();
  [[noreturn]] void mismatch(const std::string &message);

public:
  HistorySubscription(asio::io_context &io, Store &store, std::string key,
                      std::function<int64_t()> durable, std::function<void(int64_t)> dirty,
                      std::function<void()> ready, std::function<void(const Json &)> failed);
  ~HistorySubscription();
  void connect(std::function<void(Json)> send);
  void disconnect();
  void stop();
  void commit();
  bool receive(const Json &frame);
};
} // namespace coc
