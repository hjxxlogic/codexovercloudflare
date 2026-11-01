#pragma once
#include "network.hpp"
#include "runtime_resources.hpp"
#include <set>
namespace coc {
Json approval_decision(const Json &rpc, bool allow);
std::string rpc_key(const Json &id);
std::shared_ptr<void> reserve_approval(const std::shared_ptr<RuntimeResources> &, const Json &,
                                       bool mirrored = false);
// Connects to the original server. It never starts a turn or changes its policy.
class ExternalApprovals : public std::enable_shared_from_this<ExternalApprovals> {
  std::shared_ptr<RuntimeResources> resources_;
  uint64_t generation_ = 0;
  asio::io_context &io_;
  Json config_;
  std::string thread_, cwd_;
  std::shared_ptr<Socket> socket_;
  asio::steady_timer connect_timer_, retry_;
  bool stopped_ = false, connected_ = false;
  int attempts_ = 0;
  struct Request {
    Completion done;
    std::shared_ptr<asio::steady_timer> timer;
    std::shared_ptr<void> reservation;
  };
  std::map<std::string, Request> requests_;
  struct Approval {
    Json rpc;
    std::shared_ptr<void> reservation;
  };
  std::map<std::string, Approval> approvals_;
  std::set<std::string> submitted_;
  std::function<void(Json, std::shared_ptr<void>)> approval_;
  std::function<void(Json)> resolved_;
  std::function<void(bool, std::string)> state_;
  void wait_ready();
  void request(const std::string &, const Json &, Completion);
  void receive(Json);
  void failed(const std::string &);
  void attach();

public:
  ExternalApprovals(
      asio::io_context &, Json config, std::string thread, std::string cwd,
      std::function<void(Json, std::shared_ptr<void>)> approval, std::function<void(Json)> resolved,
      std::function<void(bool, std::string)> state,
      std::shared_ptr<RuntimeResources> resources = std::make_shared<RuntimeResources>());
  void start();
  void close();
  Json answer(const std::string &, bool);
};
std::shared_ptr<Socket> unix_socket(asio::io_context &, const std::string &, SocketMessage,
                                    SocketClosed);
} // namespace coc
