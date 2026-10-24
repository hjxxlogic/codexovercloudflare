#include "coc/network.hpp"
#include "coc/tls.hpp"
#include <boost/asio/ssl.hpp>
#include <boost/beast.hpp>
#include <boost/beast/ssl.hpp>
namespace coc {
namespace beast = boost::beast;
namespace http = beast::http;
namespace ssl = asio::ssl;
using tcp = asio::ip::tcp;
template <class Stream>
Json exchange(Stream &s, const Url &u, const std::string &path, const Json &body,
              const std::string &token) {
  http::request<http::string_body> req{body.is_null() ? http::verb::get : http::verb::post, path,
                                       11};
  req.set(http::field::host, u.authority);
  req.set(http::field::content_type, "application/json");
  req.set(http::field::origin, u.origin);
  req.set(http::field::user_agent, "coc/0.2.1");
  if (!token.empty())
    req.set(http::field::authorization, "Bearer " + token);
  if (!body.is_null()) {
    req.set("Idempotency-Key", uuid());
    req.body() = body.dump();
    req.prepare_payload();
  }
  http::write(s, req);
  beast::flat_buffer buf;
  http::response_parser<http::string_body> parser;
  parser.body_limit(max_queue);
  http::read(s, buf, parser);
  auto r = parser.release();
  auto data = Json::parse(r.body());
  if (r.result_int() < 200 || r.result_int() >= 300) {
    auto e = data.value("error", Json::object());
    throw Error(e.value("code", "HTTP_ERROR"), e.value("message", "Relay request failed"));
  }
  return data;
}
Json http_json(const Url &u, const std::string &path, const Json &body, const std::string &token) {
  asio::io_context io;
  tcp::resolver resolver(io);
  auto addresses = resolver.resolve(u.host, u.port);
  if (u.tls) {
    ssl::context ctx(ssl::context::tls_client);
    ctx.set_default_verify_paths();
    beast::ssl_stream<beast::tcp_stream> s(io, ctx);
    verify_tls_hostname(s.native_handle(), u.host);
    s.set_verify_mode(ssl::verify_peer);
    beast::get_lowest_layer(s).expires_after(std::chrono::seconds(30));
    beast::get_lowest_layer(s).connect(addresses);
    s.handshake(ssl::stream_base::client);
    return exchange(s, u, path, body, token);
  }
  beast::tcp_stream s(io);
  s.expires_after(std::chrono::seconds(30));
  s.connect(addresses);
  return exchange(s, u, path, body, token);
}
std::shared_ptr<Socket> connect_socket(asio::io_context &io, const Url &u, const std::string &t,
                                       SocketMessage m, SocketClosed c) {
  return u.tls ? tls_socket(io, u, t, m, c) : plain_socket(io, u, t, m, c);
}
} // namespace coc
