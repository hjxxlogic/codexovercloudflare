#include "coc/network.hpp"
#include "coc/tls.hpp"
#include <boost/asio/ssl.hpp>
#include <boost/beast.hpp>
#include <boost/beast/ssl.hpp>
namespace coc {
namespace beast = boost::beast;
namespace websocket = beast::websocket;
namespace ssl = asio::ssl;
using tcp = asio::ip::tcp;
#ifdef COC_TLS
using Transport = beast::ssl_stream<beast::tcp_stream>;
#define COC_FACTORY tls_socket
#else
using Transport = beast::tcp_stream;
#define COC_FACTORY plain_socket
#endif
namespace {
class Connection final : public Socket, public std::enable_shared_from_this<Connection> {
  asio::io_context &io_;
  ssl::context ctx_{ssl::context::tls_client};
  tcp::resolver resolver_;
  websocket::stream<Transport> ws_;
  Url url_;
  std::string token_;
  SocketMessage message_;
  SocketClosed closed_;
  beast::flat_buffer buf_{max_frame};
  std::deque<std::string> writes_;
  size_t queued_ = 0;
  bool open_ = false, ended_ = false;

public:
  Connection(asio::io_context &io, Url u, std::string t, SocketMessage m, SocketClosed c)
      : io_(io), resolver_(io),
#ifdef COC_TLS
        ws_(io, ctx_),
#else
        ws_(io),
#endif
        url_(std::move(u)), token_(std::move(t)), message_(std::move(m)), closed_(std::move(c)) {
  }
  void start() override {
    auto self = shared_from_this();
    try {
#ifdef COC_TLS
      ctx_.set_default_verify_paths();
      ws_.next_layer().set_verify_mode(ssl::verify_peer);
      verify_tls_hostname(ws_.next_layer().native_handle(), url_.host);
#endif
      resolver_.async_resolve(url_.host, url_.port, [self](auto ec, auto results) {
        if (ec) {
          self->finish();
          return;
        }
        beast::get_lowest_layer(self->ws_).expires_after(std::chrono::seconds(15));
        beast::get_lowest_layer(self->ws_).async_connect(results, [self](auto ec, auto) {
          if (ec) {
            self->finish();
            return;
          }
#ifdef COC_TLS
          self->ws_.next_layer().async_handshake(ssl::stream_base::client, [self](auto ec) {
            if (ec)
              self->finish();
            else
              self->handshake();
          });
#else
 self->handshake();
#endif
        });
      });
    } catch (...) {
      finish();
    }
  }
  void handshake() {
    auto self = shared_from_this();
    beast::get_lowest_layer(ws_).expires_never();
    ws_.set_option(websocket::stream_base::timeout::suggested(beast::role_type::client));
    ws_.read_message_max(max_frame);
    ws_.set_option(websocket::stream_base::decorator([token = token_](websocket::request_type &r) {
      r.set(beast::http::field::authorization, "Bearer " + token);
    }));
    ws_.async_handshake(url_.authority, "/ws/v1/agent", [self](auto ec) {
      if (ec) {
        self->finish();
        return;
      }
      self->open_ = true;
      self->read();
    });
  }
  void read() {
    auto self = shared_from_this();
    ws_.async_read(buf_, [self](auto ec, size_t) {
      if (ec) {
        self->finish();
        return;
      }
      try {
        if (!self->ws_.got_text())
          throw Error("INVALID_FRAME", "Text frames required");
        auto data = Json::parse(beast::buffers_to_string(self->buf_.data()));
        self->buf_.consume(self->buf_.size());
        if (!data.is_object())
          throw Error("INVALID_FRAME", "Expected object");
        self->message_(data);
        if (!self->ended_)
          self->read();
      } catch (...) {
        self->finish();
      }
    });
  }
  void send(const Json &data) override {
    if (!open_ || ended_)
      return;
    auto text = data.dump();
    if (text.size() > max_frame || queued_ + text.size() > max_queue) {
      finish();
      return;
    }
    bool idle = writes_.empty();
    queued_ += text.size();
    writes_.push_back(std::move(text));
    if (idle)
      write();
  }
  void write() {
    auto self = shared_from_this();
    ws_.text(true);
    ws_.async_write(asio::buffer(writes_.front()), [self](auto ec, size_t) {
      if (ec) {
        self->finish();
        return;
      }
      self->queued_ -= self->writes_.front().size();
      self->writes_.pop_front();
      if (!self->ended_ && !self->writes_.empty())
        self->write();
    });
  }
  void finish() {
    if (ended_)
      return;
    ended_ = true;
    open_ = false;
    resolver_.cancel();
    boost::system::error_code ec;
    beast::get_lowest_layer(ws_).socket().close(ec);
    unsigned code = ws_.reason().code;
    closed_(code);
  }
  void close() override { finish(); }
};
} // namespace
std::shared_ptr<Socket> COC_FACTORY(asio::io_context &io, const Url &u, const std::string &t,
                                    SocketMessage m, SocketClosed c) {
  return std::make_shared<Connection>(io, u, t, m, c);
}
} // namespace coc
