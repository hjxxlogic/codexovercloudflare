#pragma once
#include "network.hpp"
#include <set>
namespace coc {
// Connects to the original server. It never starts a turn or changes its policy.
class ExternalApprovals : public std::enable_shared_from_this<ExternalApprovals> {
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
  };
  std::map<std::string, Request> requests_;
  std::map<std::string, Json> approvals_;
  std::set<std::string> submitted_;
  std::function<void(Json)> approval_, resolved_;
  std::function<void(bool, std::string)> state_;
  void wait_ready();
  void request(const std::string &, const Json &, Completion);
  void receive(Json);
  void failed(const std::string &);
  void attach();

public:
  ExternalApprovals(asio::io_context &, Json config, std::string thread, std::string cwd,
                    std::function<void(Json)> approval, std::function<void(Json)> resolved,
                    std::function<void(bool, std::string)> state);
  void start();
  void close();
  Json answer(const std::string &, bool);
};
std::shared_ptr<Socket> unix_socket(asio::io_context &, const std::string &, SocketMessage,
                                    SocketClosed);
} // namespace coc
