#include "coc/endpoint.hpp"
#include <regex>
namespace coc {
std::string business_host(const std::string &path, const Json &body) {
  std::smatch match;
  if (std::regex_search(path, match,
                        std::regex("/(?:api/v1/)?(?:admin/)?hosts/([\\w-]+)/"
                                   "(projects|project-management|thread-management|probe|threads|"
                                   "files|terminal|configuration|build)")))
    return match[1];
  if (std::regex_search(path, match, std::regex("/(?:api/v1/)?sessions/([\\w-]+)~")))
    return match[1];
  if (path.find("/sessions") != std::string::npos) {
    if (body.is_object() && body.contains("hostId"))
      return body.at("hostId");
    if (std::regex_search(path, match, std::regex("[?&]hostId=([\\w-]+)")))
      return match[1];
  }
  return "";
}
namespace {
class EndpointSocket : public Socket, public std::enable_shared_from_this<EndpointSocket> {
  asio::io_context &io_;
  Url url_;
  std::string token_, path_, host_, mode_, logical_ = uuid();
  Json request_;
  SocketMessage message_;
  SocketClosed closed_;
  std::shared_ptr<Socket> raw_;
  std::unique_ptr<SecureChannel> cipher_;
  asio::steady_timer opening_;
  bool ended_ = false, opened_ = false, keepalive_ = false;
  size_t bytes_ = 0;
  std::deque<std::string> waiting_;
  std::string partial_;
  void finish(unsigned code = 1006) {
    if (ended_)
      return;
    ended_ = true;
    opened_ = false;
    opening_.cancel();
    cipher_.reset();
    waiting_.clear();
    bytes_ = 0;
    if (raw_) {
      auto raw = std::move(raw_);
      raw->close();
    }
    closed_(code);
  }
  void encrypted(const Json &packet) {
    for (const auto &part : secure_fragments(packet))
      raw_->send({{"type", "channel-data"}, {"data", cipher_->seal(part)}});
  }
  void ready() {
    if (!cipher_->ready())
      return;
    if (mode_ == "request")
      encrypted(request_);
    else
      encrypted({{"type", "open"}, {"id", logical_}, {"path", path_}});
  }
  void frame(Json d) {
    try {
      const auto type = d.value("type", "");
      if (type == "channel-error") {
        if (mode_ == "request")
          message_({{"type", "response"}, {"error", d.at("error")}});
        else
          message_({{"type", "error"}, {"error", d.at("error")}});
        finish(1011);
      } else if (type == "channel-welcome") {
        cipher_ = std::make_unique<SecureChannel>(true, "pending");
        raw_->send({{"type", "channel-connect"}, {"key", cipher_->public_key()}});
      } else if (type == "channel-key") {
        // Binding arrives after key generation. AAD is fixed before any encryption.
        const auto header = cipher_->exchange(d.at("data"));
        binding_ = d.at("binding");
        cipher_->binding(binding_);
        raw_->send({{"type", "channel-header"}, {"data", header}});
      } else if (type == "channel-header") {
        cipher_->accept(d.at("data"));
        ready();
      } else if (type == "channel-data") {
        const auto chunk = cipher_->open(d.at("data"));
        if (chunk.empty() || (chunk[0] != '0' && chunk[0] != '1') ||
            partial_.size() + chunk.size() - 1 > max_queue)
          throw Error("INVALID_RESPONSE", "Invalid endpoint fragments");
        partial_ += chunk.substr(1);
        if (chunk[0] == '0')
          return;
        auto packet = Json::parse(partial_);
        partial_.clear();
        if (packet.value("type", "") == "opened") {
          opened_ = true;
          opening_.cancel();
          for (auto &text : waiting_)
            encrypted({{"type", "stream"}, {"id", logical_}, {"frame", Json::parse(text)}});
          waiting_.clear();
          bytes_ = 0;
          if (packet.contains("frame"))
            message_(packet.at("frame"));
        } else if (packet.value("type", "") == "stream")
          message_(packet.at("frame"));
        else if (packet.value("type", "") == "response") {
          opening_.cancel();
          message_(packet);
        } else if (packet.value("type", "") == "closed")
          finish(packet.value("code", 4000U));
      }
    } catch (...) {
      finish();
    }
  }
  std::string binding_;

public:
  EndpointSocket(asio::io_context &io, Url u, std::string token, std::string path, std::string host,
                 SocketMessage message, SocketClosed closed, Json request = nullptr)
      : io_(io), url_(std::move(u)), token_(std::move(token)), path_(std::move(path)),
        host_(std::move(host)), mode_(request.is_null() ? "stream" : "request"),
        request_(std::move(request)), message_(std::move(message)), closed_(std::move(closed)),
        opening_(io) {}
  void start() override {
    auto self = shared_from_this();
    raw_ = url_.tls ? tls_socket(
                          io_, url_, token_, [self](Json d) { self->frame(std::move(d)); },
                          [self](unsigned c) { self->finish(c); }, "/ws/v1/channel/" + host_)
                    : plain_socket(
                          io_, url_, token_, [self](Json d) { self->frame(std::move(d)); },
                          [self](unsigned c) { self->finish(c); }, "/ws/v1/channel/" + host_);
    if (keepalive_)
      raw_->keepalive();
    opening_.expires_after(std::chrono::seconds(30));
    opening_.async_wait([self](auto ec) {
      if (!ec)
        self->finish();
    });
    raw_->start();
  }
  bool ready() const override { return opened_ && !ended_; }
  void keepalive() override { keepalive_ = true; }
  void read_limit(size_t) override {}
  void send_text(std::string text) override {
    if (ended_)
      return;
    if (!opened_) {
      if (waiting_.size() >= 1024 || bytes_ + text.size() > max_queue) {
        finish();
        return;
      }
      bytes_ += text.size();
      waiting_.push_back(std::move(text));
      return;
    }
    try {
      encrypted({{"type", "stream"}, {"id", logical_}, {"frame", Json::parse(text)}});
    } catch (...) {
      finish();
    }
  }
  void close() override { finish(1000); }
};
} // namespace
std::shared_ptr<Socket> endpoint_socket(asio::io_context &io, const Url &u,
                                        const std::string &token, SocketMessage message,
                                        SocketClosed closed, const std::string &path,
                                        const std::string &host) {
  return std::make_shared<EndpointSocket>(io, u, token, path, host, std::move(message),
                                          std::move(closed));
}
Json endpoint_http(const Url &u, const std::string &path, const Json &body,
                   const std::string &token, const std::string &request,
                   std::chrono::milliseconds timeout, const HttpIntent *intent) {
  asio::io_context io;
  asio::steady_timer timer(io);
  Json result;
  bool done = false;
  Json packet = {{"type", "request"},
                 {"id", uuid()},
                 {"path", path},
                 {"body", body},
                 {"requestId", request.empty() ? uuid() : request}};
  if (intent)
    packet["intent"] = {{"instance", intent->instance}, {"ack", intent->ack}};
  std::shared_ptr<Socket> socket;
  socket = std::make_shared<EndpointSocket>(
      io, u, token, "", business_host(path, body),
      [&](Json d) {
        result = std::move(d);
        done = true;
        timer.cancel();
        socket->close();
      },
      [&](unsigned) { timer.cancel(); }, packet);
  timer.expires_after(timeout);
  timer.async_wait([&](auto ec) {
    if (!ec)
      socket->close();
  });
  socket->start();
  io.run();
  if (!done)
    throw Error("RESULT_UNKNOWN", "Endpoint response not confirmed; recover the original request");
  if (intent && result.contains("intent")) {
    const auto proof = operation_intent(result.at("intent"));
    if (proof.at("instance") != intent->instance || proof.at("requestId") != request ||
        proof.value("ack", false) != intent->ack)
      throw Error("DELIVERY_STATE_MISMATCH", "Wrong endpoint receipt");
    if (intent->commit)
      intent->commit(result.contains("error") ? Json{{"error", result.at("error")}}
                                              : Json{{"data", result.at("data")}},
                     proof);
  } else if (intent && !result.contains("error"))
    throw Error("RESULT_UNKNOWN", "Missing durable endpoint receipt");
  if (result.contains("error"))
    throw Error(result["error"].value("code", "RESULT_UNKNOWN"),
                result["error"].value("message", "Endpoint request failed"));
  return result.value("data", Json());
}
} // namespace coc
