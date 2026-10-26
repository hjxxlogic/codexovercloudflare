#pragma once
#include "common.hpp"
#include <future>
#include <memory>
namespace coc {
struct UpdateSettings {
#ifdef _WIN32
  bool enabled = false;
#else
  bool enabled = true;
#endif
  int interval_hours = 1;
  std::string platform;
};
UpdateSettings update_settings(const Json &config);
bool newer_release(const std::string &candidate, const std::string &current);
std::filesystem::path executable_path();
class PreparedUpdate {
  std::filesystem::path executable_, temporary_;
  std::unique_ptr<PrivateLock> lock_;
  uint64_t device_, inode_;

public:
  Json release;
  PreparedUpdate(std::filesystem::path executable, std::filesystem::path temporary,
                 std::unique_ptr<PrivateLock> lock, uint64_t device, uint64_t inode);
  ~PreparedUpdate();
  void install();
};
std::unique_ptr<PreparedUpdate> prepare_update(const Json &config, const std::string &relay,
                                               bool manual = false);
// Automatic failures are nonfatal; explicit update reports failures to its caller.
void automatic_update(const Json &config, const std::string &relay);
void restart_updated(int argc, char **argv);
class AgentUpdater {
  std::future<std::unique_ptr<PreparedUpdate>> pending_;
  std::unique_ptr<PreparedUpdate> ready_;
  bool requested_ = false;

public:
  void request() { requested_ = true; }
  bool poll(const Json &config, const std::string &relay, bool idle);
  bool install();
};
} // namespace coc
