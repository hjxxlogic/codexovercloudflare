#include "coc/tui_bridge.hpp"
#include <boost/beast.hpp>
namespace coc {
namespace beast = boost::beast;
namespace http = beast::http;
namespace ws = beast::websocket;
using tcp = asio::ip::tcp;
std::string remote_address(const Url &u, const std::string &path) {
  return std::string(u.tls ? "wss://" : "ws://") +
         (u.host.find(':') == std::string::npos ? u.host : "[" + u.host + "]") + ":" + u.port +
         path;
}
class TuiBridge::Impl : public std::enable_shared_from_this<TuiBridge::Impl> {
  asio::io_context &io_;
  tcp::acceptor acceptor_;
  std::unique_ptr<ws::stream<beast::tcp_stream>> local_;
  asio::steady_timer poll_;
  beast::flat_buffer buffer_{max_queue};
  std::unique_ptr<http::request_parser<http::empty_body>> request_;
  Url relay_;
  std::string ticket_, path_;
  std::shared_ptr<Socket> remote_;
  std::deque<std::string> writes_;
  size_t queued_ = 0;
  bool open_ = false, ended_ = false;
  void accept() {
    local_ = std::make_unique<ws::stream<beast::tcp_stream>>(io_);
    request_ = std::make_unique<http::request_parser<http::empty_body>>();
    request_->body_limit(0);
    request_->header_limit(16384);
    auto self = shared_from_this();
    acceptor_.async_accept(local_->next_layer().socket(), [self](auto ec) {
      if (ec) {
        self->close();
        return;
      }
      self->local_->next_layer().expires_after(std::chrono::seconds(15));
      http::async_read(
          self->local_->next_layer(), self->buffer_, *self->request_, [self](auto ec, size_t) {
            if (self->ended_)
              return;
            if (ec ||
                self->request_->get()[http::field::authorization] != "Bearer " + self->ticket_ ||
                self->request_->get().target() != "/" || !ws::is_upgrade(self->request_->get())) {
              boost::system::error_code ignored;
              self->local_->next_layer().socket().close(ignored);
              self->buffer_.consume(self->buffer_.size());
              self->accept();
              return;
            }
            // Accept only one authenticated TUI. Proxy credentials remain in this process.
            self->acceptor_.close();
            std::weak_ptr<Impl> weak = self;
            self->remote_ = connect_socket(
                self->io_, self->relay_, self->ticket_,
                [weak](Json message) {
                  if (auto bridge = weak.lock())
                    bridge->send(message.dump());
                },
                [weak](unsigned) {
                  if (auto bridge = weak.lock())
                    bridge->close();
                },
                self->path_);
            self->remote_->start();
            self->wait_remote(std::chrono::steady_clock::now() + std::chrono::seconds(30));
          });
    });
  }
  void wait_remote(std::chrono::steady_clock::time_point deadline) {
    if (ended_)
      return;
    if (!remote_->ready()) {
      if (std::chrono::steady_clock::now() >= deadline) {
        close();
        return;
      }
      poll_.expires_after(std::chrono::milliseconds(10));
      auto self = shared_from_this();
      poll_.async_wait([self, deadline](auto ec) {
        if (!ec)
          self->wait_remote(deadline);
      });
      return;
    }
    local_->next_layer().expires_never();
    local_->set_option(ws::stream_base::timeout::suggested(beast::role_type::server));
    local_->read_message_max(max_frame);
    auto self = shared_from_this();
    local_->async_accept(request_->get(), [self](auto ec) {
      if (ec) {
        self->close();
        return;
      }
      self->open_ = true;
      if (!self->writes_.empty())
        self->write();
      self->read();
    });
  }
  void read() {
    auto self = shared_from_this();
    local_->async_read(buffer_, [self](auto ec, size_t) {
      if (ec || !self->local_->got_text()) {
        self->close();
        return;
      }
      self->remote_->send_text(beast::buffers_to_string(self->buffer_.data()));
      self->buffer_.consume(self->buffer_.size());
      if (!self->ended_)
        self->read();
    });
  }
  void send(std::string message) {
    if (ended_)
      return;
    if (message.size() > max_frame || queued_ + message.size() > max_queue) {
      close();
      return;
    }
    const bool idle = writes_.empty();
    queued_ += message.size();
    writes_.push_back(std::move(message));
    if (open_ && idle)
      write();
  }
  void write() {
    auto self = shared_from_this();
    local_->text(true);
    local_->async_write(asio::buffer(writes_.front()), [self](auto ec, size_t) {
      if (ec) {
        self->close();
        return;
      }
      self->queued_ -= self->writes_.front().size();
      self->writes_.pop_front();
      if (!self->ended_ && !self->writes_.empty())
        self->write();
    });
  }

public:
  Impl(asio::io_context &io, Url relay, std::string ticket, std::string path)
      : io_(io), acceptor_(io, {asio::ip::address_v4::loopback(), 0}), poll_(io),
        relay_(std::move(relay)), ticket_(std::move(ticket)), path_(std::move(path)) {}
  void start() { accept(); }
  std::string url() const {
    return "ws://127.0.0.1:" + std::to_string(acceptor_.local_endpoint().port()) + "/";
  }
  void close() {
    if (ended_)
      return;
    ended_ = true;
    poll_.cancel();
    boost::system::error_code ignored;
    acceptor_.close(ignored);
    if (local_) {
      // Cancel Beast's server idle timer as well as the underlying socket.
      local_->set_option(
          ws::stream_base::timeout{ws::stream_base::none(), ws::stream_base::none(), false});
      local_->next_layer().socket().close(ignored);
    }
    if (remote_)
      remote_->close();
  }
};
TuiBridge::TuiBridge(asio::io_context &io, const Url &relay, const std::string &ticket,
                     const std::string &path)
    : impl_(std::make_shared<Impl>(io, relay, ticket, path)) {
  impl_->start();
}
TuiBridge::~TuiBridge() { impl_->close(); }
std::string TuiBridge::url() const { return impl_->url(); }
} // namespace coc
