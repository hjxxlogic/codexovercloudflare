#pragma once
#include "network.hpp"
#include <atomic>
#include <thread>
namespace coc {
// Only the already selected local file can be accessed. Receipts contain hashes,
// never configuration contents, and survive process restarts.
class RemoteConfiguration {
  std::filesystem::path path_, receipts_;
  bool agent_;

public:
  RemoteConfiguration(std::filesystem::path path, bool agent);
  Json metadata() const;
  Json request(const Json &request, bool busy, bool &restart);
};
class ClientManagement {
  asio::io_context io_;
  asio::steady_timer retry_;
  std::shared_ptr<Socket> socket_;
  RemoteConfiguration config_;
  Json credential_;
  std::string instance_;
  std::thread thread_;
  std::atomic<bool> restart_{false};
  bool stopped_ = false;
  void connect();

public:
  ClientManagement(const std::filesystem::path &path, Json credential);
  ~ClientManagement();
  const std::string &instance() const { return instance_; }
  bool restarting() const { return restart_; }
};
// Re-executes the original argv after the caller has destroyed subprocesses.
void restart_process(int argc, char **argv, const std::string &client_instance = "");
} // namespace coc
