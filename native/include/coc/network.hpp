#pragma once
#include "process.hpp"
namespace coc {
std::string http_download(const Url &, const std::string &path, size_t limit,
                          std::chrono::milliseconds timeout = std::chrono::seconds(30));
Json http_json(const Url &, const std::string &path, const Json &body,
               const std::string &token = "", const std::string &request_id = "",
               std::chrono::milliseconds timeout = std::chrono::seconds(30));
struct Socket {
  virtual ~Socket() = default;
  virtual void start() = 0;
  virtual bool ready() const { return false; }
  virtual void read_limit(size_t) {}
  void send(const Json &value) { send_text(value.dump()); }
  virtual void send_text(std::string) = 0;
  virtual void close() = 0;
};
using SocketMessage = std::function<void(Json)>;
using SocketClosed = std::function<void(unsigned)>;
std::shared_ptr<Socket> connect_socket(asio::io_context &, const Url &, const std::string &token,
                                       SocketMessage, SocketClosed,
                                       const std::string &path = "/ws/v1/agent");
std::shared_ptr<Socket> plain_socket(asio::io_context &, const Url &, const std::string &,
                                     SocketMessage, SocketClosed,
                                     const std::string &path = "/ws/v1/agent");
std::shared_ptr<Socket> tls_socket(asio::io_context &, const Url &, const std::string &,
                                   SocketMessage, SocketClosed,
                                   const std::string &path = "/ws/v1/agent");
} // namespace coc
