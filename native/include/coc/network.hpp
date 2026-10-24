#pragma once
#include "process.hpp"
namespace coc {
Json http_json(const Url &, const std::string &path, const Json &body,
               const std::string &token = "");
struct Socket {
  virtual ~Socket() = default;
  virtual void start() = 0;
  virtual void send(const Json &) = 0;
  virtual void close() = 0;
};
using SocketMessage = std::function<void(Json)>;
using SocketClosed = std::function<void(unsigned)>;
std::shared_ptr<Socket> connect_socket(asio::io_context &, const Url &, const std::string &token,
                                       SocketMessage, SocketClosed);
std::shared_ptr<Socket> plain_socket(asio::io_context &, const Url &, const std::string &,
                                     SocketMessage, SocketClosed);
std::shared_ptr<Socket> tls_socket(asio::io_context &, const Url &, const std::string &,
                                   SocketMessage, SocketClosed);
} // namespace coc
