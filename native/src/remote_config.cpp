#include "coc/remote_config.hpp"
#include "coc/build.hpp"
#include "coc/proxy.hpp"
#include "coc/update.hpp"
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <openssl/sha.h>
#include <regex>
#include <set>
#include <sstream>
#ifdef _WIN32
#include "coc/windows.hpp"
#else
#include <unistd.h>
#endif
namespace coc {
namespace {
constexpr size_t config_limit = 64 * 1024;
std::string hash(const std::string &text) {
  unsigned char bytes[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char *>(text.data()), text.size(), bytes);
  std::ostringstream out;
  for (auto b : bytes)
    out << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(b);
  return out.str();
}
std::string contents(const std::filesystem::path &path) {
  if (!std::filesystem::is_regular_file(std::filesystem::symlink_status(path)))
    throw Error("CONFIG_ERROR", "Configuration must be a regular file");
  std::ifstream file(path, std::ios::binary);
  std::string text(config_limit + 1, '\0');
  if (!file)
    throw Error("CONFIG_ERROR", "Cannot read configuration");
  file.read(text.data(), text.size());
  text.resize(static_cast<size_t>(file.gcount()));
  if (text.size() > config_limit)
    throw Error("CONFIG_ERROR", "Configuration exceeds 64 KiB");
  return text;
}
Json validate(const std::string &text, bool agent) {
  if (text.size() > config_limit)
    throw Error("INVALID_REQUEST", "Configuration exceeds 64 KiB");
  auto data = Json::parse(text, nullptr, false);
  if (!data.is_object())
    throw Error("CONFIG_ERROR", "Configuration must be a JSON object");
  // Validation errors must never quote values from the secret configuration.
  try {
    if (agent)
      agent_config(data);
    else {
      if (data.at("version") != 2 || !data.at("entries").is_array() ||
          !data.at("selected").is_string())
        throw Error("CONFIG_ERROR", "Invalid client credentials");
      std::set<std::string> keys;
      for (const auto &entry : data.at("entries")) {
        const auto relay = entry.at("relay").get<std::string>();
        if (relay_url(relay).origin != relay || !valid_id(entry.at("hostId").get<std::string>()) ||
            entry.at("token").get<std::string>().empty() || !entry.at("name").is_string())
          throw Error("CONFIG_ERROR", "Invalid client credential entry");
        if (!keys.insert(relay + "~" + entry.at("hostId").get<std::string>()).second)
          throw Error("CONFIG_ERROR", "Duplicate client credential entry");
      }
      const auto selected = data.at("selected").get<std::string>();
      if (!selected.empty() && !keys.count(selected))
        throw Error("CONFIG_ERROR", "Selected credential does not exist");
    }
    update_settings(data);
    validate_proxy(data.value("proxy", ""));
    if (data.contains("cloudflareAccessFile") && !data["cloudflareAccessFile"].is_string())
      throw Error("CONFIG_ERROR", "Invalid Access configuration path");
  } catch (const std::exception &) {
    throw Error("CONFIG_ERROR", "Configuration validation failed; check fields and types");
  }
  return data;
}
} // namespace
RemoteConfiguration::RemoteConfiguration(std::filesystem::path path, bool agent)
    : path_(std::filesystem::absolute(std::move(path)).lexically_normal()),
      receipts_(std::filesystem::u8path(path_.u8string() + ".remote")), agent_(agent) {}
Json RemoteConfiguration::metadata() const {
  return {{"path", path_.u8string()},
          {"kind", agent_ ? "agent" : "client"},
          {"build", Json::parse(COC_BUILD_JSON)},
#ifdef _WIN32
          {"pid", GetCurrentProcessId()}
#else
          {"pid", getpid()}
#endif
  };
}
Json RemoteConfiguration::request(const Json &d, bool busy, bool &restart) {
  restart = false;
  if (!d.is_object() || !d.contains("action") || !d["action"].is_string())
    throw Error("INVALID_REQUEST", "Configuration action required");
  const auto action = d.value("action", "");
  if (action != "read" && action != "replace" && action != "restart")
    throw Error("INVALID_REQUEST", "Unknown configuration action");
  std::set<std::string> fields = {"action"};
  if (action == "replace")
    fields = {"action", "requestId", "revision", "text"};
  else if (action == "restart")
    fields = {"action", "requestId", "revision", "allowActive"};
  if (d.size() != fields.size())
    throw Error("INVALID_REQUEST", "Invalid configuration request fields");
  for (const auto &field : fields)
    if (!d.contains(field) ||
        (field == "allowActive" ? !d.at(field).is_boolean() : !d.at(field).is_string()))
      throw Error("INVALID_REQUEST", "Invalid configuration request fields");
  if (action != "read" &&
      !std::regex_match(d.at("revision").get<std::string>(), std::regex("[a-f0-9]{64}")))
    throw Error("INVALID_REQUEST", "Invalid configuration revision");
  PrivateLock lock(path_);
  const auto current = contents(path_);
  const auto revision = hash(current);
  if (action == "read")
    return {{"text", current}, {"revision", revision}, {"metadata", metadata()}, {"busy", busy}};
  const auto id = d.value("requestId", "");
  if (!valid_id(id))
    throw Error("INVALID_REQUEST", "A request ID is required");
  const auto fingerprint = hash(d.dump());
  const auto receipt_path = receipts_ / (id + ".json");
  if (std::filesystem::exists(receipt_path)) {
    const auto receipt = read_json(receipt_path);
    if (receipt.at("fingerprint") != fingerprint)
      throw Error("IDEMPOTENCY_CONFLICT", "Request ID was used for another operation");
    if (receipt.at("phase") == "completed" || receipt.at("phase") == "restart")
      return receipt.at("result");
    if (receipt.at("after") == revision) {
      auto done = receipt;
      done["phase"] = "completed";
      save_private(receipt_path, done);
      return done.at("result");
    }
    if (receipt.at("before") != revision)
      throw Error("CONFIG_CONFLICT", "Configuration changed after the interrupted replacement");
  }
  if (d.value("revision", "") != revision)
    throw Error("CONFIG_CONFLICT", "Configuration changed; read it again before writing");
  if (action == "restart") {
    validate(current, agent_);
    if (busy && !d.value("allowActive", false))
      throw Error("SESSION_BUSY", "Restart interrupts active work; explicit confirmation required");
    Json result = {{"revision", revision}, {"state", "restart-requested"}, {"requestId", id}};
    // At most once: a lost acknowledgement must never restart the process twice.
    save_private(receipt_path,
                 {{"fingerprint", fingerprint}, {"phase", "restart"}, {"result", result}});
    restart = true;
    return result;
  }
  const auto replacement = d.at("text").get<std::string>();
  validate(replacement, agent_);
  const auto next = hash(replacement);
  Json result = {{"revision", next}, {"state", "replaced"}, {"requestId", id}};
  Json receipt = {{"fingerprint", fingerprint},
                  {"before", revision},
                  {"after", next},
                  {"phase", "prepared"},
                  {"result", result}};
  save_private(receipt_path, receipt);
  // Preserve the exact old bytes, including a configuration damaged by local editing.
  save_private_text(std::filesystem::u8path(path_.u8string() + ".remote.previous"), current);
  save_private_text(path_, replacement);
  receipt["phase"] = "completed";
  save_private(receipt_path, receipt);
  return result;
}
ClientManagement::ClientManagement(const std::filesystem::path &path, Json credential)
    : retry_(io_), maintenance_(io_), config_(path, false), credential_(std::move(credential)) {
  const auto inherited = std::getenv("COC_CLIENT_RESTART_INSTANCE");
  instance_ =
      inherited &&
              std::regex_match(
                  inherited,
                  std::regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"))
          ? inherited
          : uuid();
#ifdef _WIN32
  SetEnvironmentVariableW(L"COC_CLIENT_RESTART_INSTANCE", nullptr);
#else
  unsetenv("COC_CLIENT_RESTART_INSTANCE");
#endif
  connect();
  maintain();
  thread_ = std::thread([this] {
    try {
      io_.run();
    } catch (const std::exception &) {
      // A management channel failure must not terminate the user's TUI.
      stopped_ = true;
    }
  });
}
ClientManagement::~ClientManagement() {
  asio::post(io_, [this] {
    stopped_ = true;
    retry_.cancel();
    maintenance_.cancel();
    if (socket_)
      socket_->close();
    io_.stop();
  });
  if (thread_.joinable())
    thread_.join();
}
void ClientManagement::connect() {
  if (stopped_ || restart_)
    return;
  socket_ = connect_socket(
      io_, relay_url(credential_.at("relay")), credential_.at("token"),
      [this](Json d) {
        if (d.value("type", "") == "management-ready") {
          auto metadata = config_.metadata();
          metadata["instance"] = instance_;
          socket_->send({{"type", "management-register"}, {"metadata", metadata}});
        }
        if (d.value("type", "") != "management-request")
          return;
        Json reply = {{"type", "management-result"}, {"wire", d.value("wire", "")}};
        bool restart = false;
        try {
          reply["result"] = config_.request(d.at("data"), true, restart);
        } catch (const std::exception &error) {
          reply["error"] = error_data(error);
        }
        socket_->send(reply);
        if (restart) {
          restart_ = true;
          // Keep the management thread alive while the TUI is being cleaned up.
        }
      },
      [this](unsigned code) {
        if (stopped_ || restart_ || code == 4001)
          return;
        retry_.expires_after(std::chrono::seconds(3));
        retry_.async_wait([this](auto ec) {
          if (!ec)
            connect();
        });
      },
      "/ws/v1/client-management/" + credential_.at("hostId").get<std::string>());
  socket_->start();
}
void ClientManagement::maintain() {
  maintenance_.expires_after(std::chrono::seconds(30));
  maintenance_.async_wait([this](auto ec) {
    if (!ec && !stopped_) {
      if (socket_)
        socket_->keepalive();
      maintain();
    }
  });
}
void restart_process(int, char **argv, const std::string &client_instance) {
#ifdef _WIN32
  if (!client_instance.empty())
    SetEnvironmentVariableW(L"COC_CLIENT_RESTART_INSTANCE", wide(client_instance).c_str());
  auto command = std::wstring(GetCommandLineW());
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(executable_path().c_str(), command.data(), nullptr, nullptr, FALSE, 0,
                      nullptr, nullptr, &startup, &process))
    throw Error("RESTART_FAILED", "Cannot restart process");
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  (void)argv;
#else
  auto text = executable_path().string();
  const std::string deleted = " (deleted)";
  if (text.size() > deleted.size() &&
      text.compare(text.size() - deleted.size(), deleted.size(), deleted) == 0)
    text.resize(text.size() - deleted.size());
  if (!client_instance.empty())
    setenv("COC_CLIENT_RESTART_INSTANCE", client_instance.c_str(), 1);
  execv(text.c_str(), argv);
  throw Error("RESTART_FAILED", "Cannot restart process");
#endif
}
} // namespace coc
