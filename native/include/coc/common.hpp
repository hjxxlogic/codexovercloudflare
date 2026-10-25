#pragma once
#include <filesystem>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
namespace coc {
using Json = nlohmann::json;
constexpr size_t max_frame = 256 * 1024, max_queue = 8 * 1024 * 1024;
struct Error : std::runtime_error {
  std::string code;
  Error(std::string c, std::string m) : std::runtime_error(m), code(std::move(c)) {}
};
class PrivateLock {
#ifdef _WIN32
  void *handle_ = nullptr;
#else
  int fd_ = -1;
#endif

public:
  explicit PrivateLock(const std::filesystem::path &path);
  ~PrivateLock();
  PrivateLock(const PrivateLock &) = delete;
  PrivateLock &operator=(const PrivateLock &) = delete;
};
Json error_data(const std::exception &e);
int64_t now();
std::string uuid();
bool valid_id(const std::string &s);
std::string id_key(const Json &id);
Json read_json(const std::filesystem::path &path);
void save_private(const std::filesystem::path &path, const Json &data, bool exclusive = false);
struct Url {
  std::string origin, host, authority, port;
  bool tls;
};
Url relay_url(std::string text);
std::string wake_url(const Json &value);
Json agent_config(Json config);
Json guard_cli(Json message, const std::string &cwd, const std::string &sandbox,
               const std::string &thread = "");
Json redact(Json value);
Json web_command(Json value);
std::string web_fingerprint(const Json &command);
} // namespace coc
