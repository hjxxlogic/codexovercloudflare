#include "coc/approvals.hpp"
#include "coc/external.hpp"
#include <algorithm>
#include <cstdlib>
#include <fstream>
namespace coc {
ExternalApprovals::ExternalApprovals(asio::io_context &io, Json config, std::string thread,
                                     std::string cwd, std::function<void(Json)> approval,
                                     std::function<void(Json)> resolved,
                                     std::function<void(bool, std::string)> state)
    : io_(io), config_(std::move(config)), thread_(std::move(thread)), cwd_(std::move(cwd)),
      connect_timer_(io), retry_(io), approval_(std::move(approval)),
      resolved_(std::move(resolved)), state_(std::move(state)) {}
void ExternalApprovals::start() {
  if (stopped_)
    return;
  auto self = shared_from_this();
  try {
    auto endpoint = config_.value("approvalEndpoint", "");
    if (endpoint.empty()) {
      auto home = std::getenv("CODEX_HOME");
      std::filesystem::path root;
      if (home && *home)
        root = std::filesystem::u8path(home);
      else {
#ifdef _WIN32
        home = std::getenv("USERPROFILE");
#else
        home = std::getenv("HOME");
#endif
        if (!home || !*home)
          throw Error("CONFIG_ERROR", "Set externalSessions.approvalEndpoint");
        root = std::filesystem::u8path(home) / ".codex";
      }
      endpoint = "unix://" + (root / "app-server-control/app-server-control.sock").u8string();
    }
    auto message = [self](Json value) { self->receive(std::move(value)); };
    auto closed = [self](unsigned) { self->failed("Original approval server disconnected"); };
    if (endpoint.rfind("unix://", 0) == 0)
      socket_ = unix_socket(io_, endpoint.substr(7), message, closed);
    else {
      if (endpoint.rfind("ws://", 0) != 0)
        throw Error("CONFIG_ERROR",
                    "Approval endpoint must be a private Unix socket or loopback ws:// URL");
      auto url = relay_url("http://" + endpoint.substr(5));
      if (url.host != "127.0.0.1" && url.host != "::1" && url.host != "localhost")
        throw Error("CONFIG_ERROR", "Approval WebSocket must use loopback");
      std::string token;
      const auto token_path = config_.value("approvalTokenFile", "");
      if (!token_path.empty()) {
        std::ifstream file(std::filesystem::u8path(token_path), std::ios::binary);
        if (!file)
          throw Error("CONFIG_ERROR", "Cannot read approval token file");
        char bytes[4097];
        file.read(bytes, sizeof bytes);
        if (file.gcount() > 4096)
          throw Error("CONFIG_ERROR", "Invalid approval token file");
        token.assign(bytes, static_cast<size_t>(file.gcount()));
        while (!token.empty() && (token.back() == '\n' || token.back() == '\r'))
          token.pop_back();
        if (token.empty() || token.find_first_of("\r\n") != std::string::npos)
          throw Error("CONFIG_ERROR", "Invalid approval token file");
      }
      socket_ = plain_socket(io_, url, token, message, closed, "/");
    }
    attempts_ = 0;
    socket_->read_limit(max_queue);
    socket_->start();
    wait_ready();
  } catch (const std::exception &) {
    failed("Cannot connect to original approval server; check externalSessions.approvalEndpoint "
           "and its permissions");
  }
}
void ExternalApprovals::wait_ready() {
  if (stopped_)
    return;
  if (socket_ && socket_->ready()) {
    request("initialize",
            {{"clientInfo", {{"name", "coc-external-approvals"}, {"version", "0.5.7"}}},
             {"capabilities", {{"experimentalApi", true}}}},
            [self = shared_from_this()](Json, Json error) {
              if (!error.is_null()) {
                self->failed("Original server initialization failed");
                return;
              }
              self->socket_->send({{"method", "initialized"}});
              self->attach();
            });
    return;
  }
  if (++attempts_ > 200) {
    failed("Original approval server connection timed out");
    return;
  }
  connect_timer_.expires_after(std::chrono::milliseconds(50));
  connect_timer_.async_wait([self = shared_from_this()](auto error) {
    if (!error)
      self->wait_ready();
  });
}
void ExternalApprovals::request(const std::string &method, const Json &params, Completion done) {
  const auto id = "coc-approval-" + uuid();
  auto timer = std::make_shared<asio::steady_timer>(io_, std::chrono::seconds(20));
  requests_[id] = {done, timer};
  timer->async_wait([self = shared_from_this(), id](auto error) {
    if (!error && self->requests_.count(id)) {
      auto request = self->requests_.extract(id).mapped();
      request.done(nullptr,
                   {{"code", "RESULT_UNKNOWN"}, {"message", "Approval server response timed out"}});
    }
  });
  try {
    socket_->send({{"id", id}, {"method", method}, {"params", params}});
  } catch (const std::exception &error) {
    requests_.erase(id);
    timer->cancel();
    done(nullptr, error_data(error));
  }
}
void ExternalApprovals::attach() {
  request("thread/read", {{"threadId", thread_}, {"includeTurns", false}},
          [self = shared_from_this()](Json result, Json error) {
            try {
              if (!error.is_null())
                throw Error("APPROVAL_UNAVAILABLE", "Thread is not available on original server");
              const auto &thread = result.at("thread");
              if (thread.at("id") != self->thread_ ||
                  !same_project_path(thread.value("cwd", ""), self->cwd_))
                throw Error("FORBIDDEN", "Approval thread belongs to another project");
              if (thread.at("status").value("type", "notLoaded") == "notLoaded")
                throw Error("APPROVAL_UNAVAILABLE",
                            "Thread is not loaded on this server; refusing to acquire its writer");
              self->request("thread/resume", {{"threadId", self->thread_}, {"excludeTurns", true}},
                            [self](Json, Json error) {
                              if (!error.is_null()) {
                                self->failed("Cannot subscribe to original approval thread");
                                return;
                              }
                              self->connected_ = true;
                              self->state_(true, "");
                            });
            } catch (const std::exception &error) {
              self->failed(error.what());
            }
          });
}
void ExternalApprovals::receive(Json value) {
  if (stopped_)
    return;
  const auto method = value.value("method", "");
  if (method.empty() && value.contains("id") && value["id"].is_string()) {
    const auto id = value["id"].get<std::string>();
    if (requests_.count(id)) {
      auto request = requests_.extract(id).mapped();
      request.timer->cancel();
      request.done(value.value("result", Json()), value.value("error", Json()));
    }
    return;
  }
  auto params = value.value("params", Json::object());
  if (params.value("threadId", "") != thread_)
    return;
  if ((method == "item/started" || method == "item/completed") && params.contains("item") &&
      (params["item"].value("type", "") == "fileChange" ||
       params["item"].value("type", "") == "commandExecution")) {
    approval_({{"context", params}});
    return;
  }
  if (method == "serverRequest/resolved") {
    const auto key = "external:" + id_key(params.at("requestId"));
    if (approvals_.erase(key)) {
      submitted_.erase(key);
      resolved_({{"approvalId", key}, {"message", "Original server resolved the approval"}});
    }
  } else if (value.contains("id")) {
    const auto key = "external:" + id_key(value["id"]);
    if (approvals_.count(key))
      return;
    approvals_[key] = value;
    const bool supported = method == "item/commandExecution/requestApproval" ||
                           method == "item/fileChange/requestApproval" ||
                           method == "item/permissions/requestApproval";
    approval_({{"approvalId", key},
               {"method", method},
               {"params", redact(params)},
               {"unsupported", !supported}});
  }
}
Json ExternalApprovals::answer(const std::string &key, bool allow) {
  if (!connected_ || !socket_ || !socket_->ready())
    throw Error("APPROVAL_UNAVAILABLE", "Original approval connection is unavailable");
  auto it = approvals_.find(key);
  if (it == approvals_.end())
    throw Error("UNKNOWN_APPROVAL", "Approval expired or already resolved");
  if (submitted_.count(key))
    throw Error("RESULT_UNKNOWN",
                "A decision was already submitted; await original server confirmation");
  const auto &rpc = it->second;
  if (rpc.at("method") != "item/commandExecution/requestApproval" &&
      rpc.at("method") != "item/fileChange/requestApproval" &&
      rpc.at("method") != "item/permissions/requestApproval")
    throw Error("UNSUPPORTED_APPROVAL", "This interaction must be handled by its original client");
  if (rpc.at("method") == "item/permissions/requestApproval") {
    Json permissions = Json::object();
    const auto requested = rpc.at("params").at("permissions");
    if (!requested.is_object())
      throw Error("INVALID_FRAME", "Invalid requested permissions");
    if (allow)
      for (const auto &field : {"network", "fileSystem"})
        if (requested.contains(field) && !requested.at(field).is_null())
          permissions[field] = requested.at(field);
    submitted_.insert(key);
    socket_->send(
        {{"id", rpc.at("id")}, {"result", {{"permissions", permissions}, {"scope", "turn"}}}});
    return {{"state", "approval-submitted"}, {"decisionConfirmed", false}};
  }
  const auto decisions = rpc.at("params").value("availableDecisions", Json::array());
  std::string decision = allow ? "accept" : "decline";
  if (decisions.is_array() && !decisions.empty() &&
      std::find(decisions.begin(), decisions.end(), Json(decision)) == decisions.end()) {
    if (!allow && std::find(decisions.begin(), decisions.end(), Json("cancel")) != decisions.end())
      decision = "cancel";
    else
      throw Error("UNSUPPORTED_APPROVAL", "Requested one-time decision is not available");
  }
  submitted_.insert(key);
  socket_->send({{"id", rpc.at("id")}, {"result", {{"decision", decision}}}});
  return {{"state", "approval-submitted"}, {"decisionConfirmed", false}};
}
void ExternalApprovals::failed(const std::string &message) {
  if (stopped_)
    return;
  connected_ = false;
  connect_timer_.cancel();
  auto socket = std::move(socket_);
  // Suppress recursive close callbacks while tearing down this connection.
  stopped_ = true;
  if (socket)
    socket->close();
  auto requests = std::move(requests_);
  requests_.clear();
  for (auto &[id, request] : requests) {
    request.timer->cancel();
    request.done(nullptr, {{"code", "APPROVAL_UNAVAILABLE"}, {"message", message}});
  }
  approvals_.clear();
  submitted_.clear();
  stopped_ = false;
  state_(false, message);
  if (stopped_)
    return;
  retry_.expires_after(std::chrono::seconds(15));
  retry_.async_wait([self = shared_from_this()](auto error) {
    if (!error && !self->stopped_)
      self->start();
  });
}
void ExternalApprovals::close() {
  stopped_ = true;
  connected_ = false;
  connect_timer_.cancel();
  retry_.cancel();
  if (socket_)
    socket_->close();
  socket_.reset();
  auto requests = std::move(requests_);
  requests_.clear();
  for (auto &[id, request] : requests)
    request.timer->cancel();
  approvals_.clear();
  submitted_.clear();
}
} // namespace coc
