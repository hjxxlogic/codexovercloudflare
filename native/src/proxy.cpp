#include "coc/proxy.hpp"
#include <boost/beast/core/flat_buffer.hpp>
#include <boost/beast/http.hpp>
#include <cctype>
#include <openssl/evp.h>
#include <regex>
namespace coc {
namespace {
namespace beast = boost::beast;
namespace http = beast::http;
struct Proxy {
  Url url;
  bool socks = false;
  std::string user, password;
};
std::optional<Proxy> configured;
std::string decode(const std::string &s) {
  std::string out;
  for (size_t i = 0; i < s.size(); ++i) {
    unsigned char c = s[i];
    if (c == '%') {
      if (i + 2 >= s.size() || !std::isxdigit(static_cast<unsigned char>(s[i + 1])) ||
          !std::isxdigit(static_cast<unsigned char>(s[i + 2])))
        throw Error("CONFIG_ERROR", "Invalid proxy credential encoding");
      c = static_cast<unsigned char>(std::stoi(s.substr(i + 1, 2), nullptr, 16));
      i += 2;
    }
    if (c < 32 || c == 127)
      throw Error("CONFIG_ERROR", "Invalid proxy credentials");
    out += static_cast<char>(c);
  }
  return out;
}
class Tunnel : public std::enable_shared_from_this<Tunnel> {
  beast::tcp_stream &stream_;
  Url target_;
  Proxy proxy_;
  std::function<void(boost::system::error_code)> done_;
  std::vector<unsigned char> output_, input_;
  http::request<http::empty_body> request_;
  http::response_parser<http::empty_body> response_;
  beast::flat_buffer buffer_{16384};
  void fail() { done_(asio::error::access_denied); }
  void read(size_t size, std::function<void()> next) {
    input_.resize(size);
    auto self = shared_from_this();
    asio::async_read(stream_, asio::buffer(input_), [self, next](auto ec, size_t) {
      if (ec)
        self->done_(ec);
      else
        next();
    });
  }
  void write(std::vector<unsigned char> bytes, std::function<void()> next) {
    output_ = std::move(bytes);
    auto self = shared_from_this();
    asio::async_write(stream_, asio::buffer(output_), [self, next](auto ec, size_t) {
      if (ec)
        self->done_(ec);
      else
        next();
    });
  }
  void connect_socks() {
    auto self = shared_from_this();
    std::vector<unsigned char> bytes{5, 1, 0};
    boost::system::error_code ec;
    auto address = asio::ip::make_address(target_.host, ec);
    if (!ec && address.is_v4()) {
      bytes.push_back(1);
      auto raw = address.to_v4().to_bytes();
      bytes.insert(bytes.end(), raw.begin(), raw.end());
    } else if (!ec) {
      bytes.push_back(4);
      auto raw = address.to_v6().to_bytes();
      bytes.insert(bytes.end(), raw.begin(), raw.end());
    } else {
      if (target_.host.size() > 255) {
        fail();
        return;
      }
      bytes.push_back(3);
      bytes.push_back(static_cast<unsigned char>(target_.host.size()));
      bytes.insert(bytes.end(), target_.host.begin(), target_.host.end());
    }
    auto port = std::stoi(target_.port);
    bytes.push_back(static_cast<unsigned char>(port >> 8));
    bytes.push_back(static_cast<unsigned char>(port));
    write(std::move(bytes), [self] {
      self->read(4, [self] {
        auto &b = self->input_;
        if (b[0] != 5 || b[1] != 0 || b[2] != 0) {
          self->fail();
          return;
        }
        if (b[3] == 1 || b[3] == 4)
          self->read(b[3] == 1 ? 6 : 18, [self] { self->done_({}); });
        else if (b[3] == 3)
          self->read(
              1, [self] { self->read(size_t(self->input_[0]) + 2, [self] { self->done_({}); }); });
        else
          self->fail();
      });
    });
  }

public:
  Tunnel(beast::tcp_stream &stream, Url target, Proxy proxy,
         std::function<void(boost::system::error_code)> done)
      : stream_(stream), target_(std::move(target)), proxy_(std::move(proxy)),
        done_(std::move(done)) {}
  void start() {
    auto self = shared_from_this();
    if (!proxy_.socks) {
      auto authority =
          (target_.host.find(':') == std::string::npos ? target_.host : "[" + target_.host + "]") +
          ":" + target_.port;
      request_ = {http::verb::connect, authority, 11};
      request_.set(http::field::host, authority);
      if (!proxy_.user.empty()) {
        auto credentials = proxy_.user + ":" + proxy_.password;
        std::string encoded(4 * ((credentials.size() + 2) / 3), '\0');
        EVP_EncodeBlock(reinterpret_cast<unsigned char *>(encoded.data()),
                        reinterpret_cast<const unsigned char *>(credentials.data()),
                        static_cast<int>(credentials.size()));
        request_.set(http::field::proxy_authorization, "Basic " + encoded);
      }
      response_.skip(true);
      response_.header_limit(16384);
      http::async_write(stream_, request_, [self](auto ec, size_t) {
        if (ec) {
          self->done_(ec);
          return;
        }
        http::async_read_header(
            self->stream_, self->buffer_, self->response_, [self](auto ec, size_t) {
              if (ec)
                self->done_(ec);
              else if (self->response_.get().result_int() < 200 ||
                       self->response_.get().result_int() >= 300 || self->buffer_.size())
                self->fail();
              else
                self->done_({});
            });
      });
      return;
    }
    auto method = static_cast<unsigned char>(proxy_.user.empty() ? 0 : 2);
    write({5, 1, method}, [self, method] {
      self->read(2, [self, method] {
        if (self->input_[0] != 5 || self->input_[1] != method) {
          self->fail();
          return;
        }
        if (!method) {
          self->connect_socks();
          return;
        }
        std::vector<unsigned char> auth{1, static_cast<unsigned char>(self->proxy_.user.size())};
        auth.insert(auth.end(), self->proxy_.user.begin(), self->proxy_.user.end());
        auth.push_back(static_cast<unsigned char>(self->proxy_.password.size()));
        auth.insert(auth.end(), self->proxy_.password.begin(), self->proxy_.password.end());
        self->write(std::move(auth), [self] {
          self->read(2, [self] {
            if (self->input_[0] != 1 || self->input_[1] != 0)
              self->fail();
            else
              self->connect_socks();
          });
        });
      });
    });
  }
};
} // namespace
static std::optional<Proxy> parse_proxy(const std::string &text) {
  if (text.empty())
    return {};
  std::smatch m;
  static const std::regex pattern(
      R"(^(http|socks5|socks5h|socks)://(?:([^/@:]+):([^/@]*)@)?(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):([0-9]{1,5})/?$)");
  if (text.size() > 2048 || !std::regex_match(text, m, pattern) || std::stoi(m[5]) < 1 ||
      std::stoi(m[5]) > 65535)
    throw Error(
        "CONFIG_ERROR",
        "proxy must be http://[user:password@]host:port or socks5://[user:password@]host:port");
  Proxy p;
  p.socks = m[1] != "http";
  p.user = decode(m[2]);
  p.password = decode(m[3]);
  if (p.socks && !p.user.empty() &&
      (p.user.size() > 255 || p.password.empty() || p.password.size() > 255))
    throw Error("CONFIG_ERROR", "SOCKS5 credentials require 1-255 bytes each");
  p.url = {"", m[4], m[4], m[5], false};
  if (p.url.host.front() == '[')
    p.url.host = p.url.host.substr(1, p.url.host.size() - 2);
  return p;
}
void validate_proxy(const std::string &text) { (void)parse_proxy(text); }
void configure_proxy(const std::string &text) { configured = parse_proxy(text); }
bool proxy_enabled() { return configured.has_value(); }
bool local_address(const asio::ip::address &a) {
  if (a.is_loopback() || a.is_unspecified())
    return true;
  if (a.is_v6()) {
    auto v = a.to_v6();
    if (v.is_v4_mapped()) {
      auto b = v.to_bytes();
      return local_address(
          asio::ip::address_v4(asio::ip::address_v4::bytes_type{{b[12], b[13], b[14], b[15]}}));
    }
    return v.is_link_local() || v.is_site_local() || (v.to_bytes()[0] & 0xfe) == 0xfc;
  }
  auto n = a.to_v4().to_uint();
  return (n >> 24) == 0 || (n >> 24) == 10 || (n >> 24) == 127 || (n >> 20) == 0xac1 ||
         (n >> 16) == 0xc0a8 || (n >> 16) == 0xa9fe || (n >> 22) == 0x191;
}
std::optional<Url> proxy_route(const Url &target,
                               const std::vector<asio::ip::tcp::endpoint> &addresses) {
  if (!configured || target.host == "localhost")
    return {};
  for (const auto &endpoint : addresses)
    if (local_address(endpoint.address()))
      return {};
  return configured->url;
}
void proxy_tunnel(beast::tcp_stream &stream, const Url &target,
                  std::function<void(boost::system::error_code)> done) {
  if (!configured) {
    done(asio::error::invalid_argument);
    return;
  }
  std::make_shared<Tunnel>(stream, target, *configured, std::move(done))->start();
}
} // namespace coc
