#pragma once
#include "network.hpp"
#include <boost/beast/core/tcp_stream.hpp>
#include <optional>
namespace coc {
// Configure once, before starting network threads. Never changes subprocess environment.
void validate_proxy(const std::string &url);
void configure_proxy(const std::string &url);
bool proxy_enabled();
bool local_address(const asio::ip::address &address);
// Select before DNS: only localhost and literal local addresses bypass the proxy.
std::optional<Url> proxy_route(const Url &);
void proxy_tunnel(boost::beast::tcp_stream &, const Url &,
                  std::function<void(boost::system::error_code)>);
} // namespace coc
