#include "coc/remote_config.hpp"
#include "coc/build.hpp"
#include "coc/credit.hpp"
#include "coc/delivery.hpp"
#include "coc/proxy.hpp"
#include "coc/update.hpp"
#include <cstdlib>
#include <fstream>
#include <regex>
#include <set>
#ifdef _WIN32
#include "coc/windows.hpp"
#else
#include <unistd.h>
#endif
namespace coc {
namespace {
constexpr size_t config_limit = 64 * 1024;
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
  const auto revision = delivery_digest(current);
  if (action == "read")
    return {{"text", current}, {"revision", revision}, {"metadata", metadata()}, {"busy", busy}};
  const auto id = d.value("requestId", "");
  if (!valid_id(id))
    throw Error("INVALID_REQUEST", "A request ID is required");
  const auto fingerprint = delivery_digest(d.dump());
  const auto receipt_path = receipts_ / (id + ".json");
  if (std::filesystem::exists(receipt_path)) {
    if (!std::filesystem::is_regular_file(std::filesystem::symlink_status(receipt_path)) ||
        std::filesystem::file_size(receipt_path) > credit::management_record_bytes)
      throw Error("STORAGE_ERROR", "Invalid original configuration receipt");
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
  // The config lock serializes admission across processes. Refusal identities
  // have no TTL; a full ledger may recover old requests but cannot admit new ones.
  if (!std::filesystem::exists(receipt_path) && std::filesystem::exists(receipts_)) {
    if (!std::filesystem::is_directory(std::filesystem::symlink_status(receipts_)))
      throw Error("STORAGE_ERROR", "Invalid configuration receipt directory");
    int64_t records = 0, bytes = 0;
    for (const auto &entry : std::filesystem::directory_iterator(receipts_)) {
      if (!std::filesystem::is_regular_file(entry.symlink_status()))
        throw Error("STORAGE_ERROR", "Invalid configuration receipt entry");
      ++records;
      bytes += static_cast<int64_t>(entry.file_size()) + 2048;
      if (records >= credit::management_records ||
          bytes + credit::management_record_bytes >
              credit::management_records * credit::management_record_bytes)
        throw Error("BACKPRESSURE", "Configuration refusal identity budget exhausted");
    }
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
  const auto next = delivery_digest(replacement);
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
    : retry_(io_), config_(path, false), credential_(std::move(credential)) {
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
    if (socket_)
      socket_->close();
    io_.stop();
  });
  if (thread_.joinable())
    thread_.join();
}
void ClientManagement::encrypted(const std::string &id, const Json &d) {
  auto &link = links_.at(id);
  if (link.expires <= now())
    throw Error("UNAUTHORIZED", "Configuration connection expired");
  for (const auto &part : secure_fragments(d))
    socket_->send({{"type", "channel-data"}, {"link", id}, {"data", link.cipher->seal(part)}});
}
void ClientManagement::channel(const Json &d) {
  const auto type = d.value("type", ""), id = d.value("link", "");
  try {
    if (type == "channel-welcome") {
      socket_->send({{"type", "channel-register"}, {"instance", instance_}});
      return;
    }
    if (type == "channel-registered")
      return;
    if (type == "channel-retire" || type == "channel-close") {
      if (id == "*")
        links_.clear();
      else
        links_.erase(id);
      if (type == "channel-retire")
        socket_->send({{"type", "channel-retired"}, {"event", d.at("event")}});
      return;
    }
    if (type == "channel-open") {
      const auto identity = d.at("identity");
      if (links_.size() >= 128 || links_.count(id) ||
          identity.at("hostId") != credential_.at("hostId") || identity.at("role") != "owner" ||
          !identity.at("permissions").value("configuration", false) ||
          identity.at("expires").get<int64_t>() <= now())
        throw Error("FORBIDDEN", "Owner connection required");
      Link link;
      link.expires = identity.at("expires");
      link.cipher = std::make_unique<SecureChannel>(false, d.at("binding"));
      const auto header = link.cipher->exchange(d.at("key"));
      const auto key = link.cipher->public_key();
      links_.emplace(id, std::move(link));
      socket_->send({{"type", "channel-key"}, {"link", id}, {"data", key}});
      socket_->send({{"type", "channel-header"}, {"link", id}, {"data", header}});
      return;
    }
    auto it = links_.find(id);
    if (it == links_.end())
      return;
    if (it->second.expires <= now())
      throw Error("UNAUTHORIZED", "Configuration connection expired");
    if (type == "channel-header") {
      it->second.cipher->accept(d.at("data"));
      return;
    }
    if (type != "channel-data")
      throw Error("INVALID_REQUEST", "Encrypted channel required");
    const auto part = it->second.cipher->open(d.at("data"));
    if (part.empty() || (part[0] != '0' && part[0] != '1') ||
        it->second.partial.size() + part.size() - 1 > max_queue)
      throw Error("BACKPRESSURE", "Invalid fragments");
    it->second.partial += part.substr(1);
    if (part[0] == '0')
      return;
    const auto packet = Json::parse(it->second.partial);
    it->second.partial.clear();
    Json reply = {{"type", "response"}, {"id", packet.at("id")}};
    bool restart = false;
    try {
      const auto path = packet.at("path").get<std::string>();
      if (packet.at("type") != "request" ||
          (path !=
               "/admin/hosts/" + credential_.at("hostId").get<std::string>() + "/configuration" &&
           path != "/api/v1/admin/hosts/" + credential_.at("hostId").get<std::string>() +
                       "/configuration"))
        throw Error("FORBIDDEN", "Configuration route required");
      if (packet.at("body").is_null()) {
        reply["data"] = config_.metadata();
        reply["data"]["instance"] = instance_;
      } else
        reply["data"] = config_.request(packet.at("body").at("command"), true, restart);
    } catch (const std::exception &error) {
      reply["error"] = error_data(error);
    }
    encrypted(id, reply);
    if (restart)
      restart_ = true;
  } catch (...) {
    links_.erase(id);
    socket_->send({{"type", "channel-close"}, {"link", id}});
  }
}
void ClientManagement::connect() {
  if (stopped_ || restart_)
    return;
  socket_ = connect_socket(
      io_, relay_url(credential_.at("relay")), credential_.at("token"),
      [this](Json d) { channel(d); },
      [this](unsigned code) {
        links_.clear();
        if (stopped_ || restart_ || code == 4001)
          return;
        retry_.expires_after(std::chrono::seconds(3));
        retry_.async_wait([this](auto ec) {
          if (!ec)
            connect();
        });
      },
      "/ws/v1/client-management/" + credential_.at("hostId").get<std::string>());
  socket_->keepalive();
  socket_->start();
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
