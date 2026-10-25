#include "coc/approvals.hpp"
#ifndef _WIN32
#include <boost/asio/local/stream_protocol.hpp>
#include <boost/beast.hpp>
#include <sys/stat.h>
#include <unistd.h>
namespace coc {
namespace {
namespace beast = boost::beast;
namespace ws = beast::websocket;
class UnixSocket : public Socket, public std::enable_shared_from_this<UnixSocket> {
  ws::stream<asio::local::stream_protocol::socket> stream_;
  std::string path_;
  SocketMessage message_;
  SocketClosed closed_;
  beast::flat_buffer buffer_{max_frame};
  std::deque<std::string> writes_;
  size_t bytes_ = 0;
  bool open_ = false, ended_ = false;
  void finish() {
    if (ended_)
      return;
    ended_ = true;
    boost::system::error_code ignored;
    stream_.next_layer().close(ignored);
    closed_(0);
  }
  void read() {
    auto self = shared_from_this();
    stream_.async_read(buffer_, [self](auto error, size_t) {
      if (error) {
        self->finish();
        return;
      }
      try {
        if (!self->stream_.got_text())
          throw Error("INVALID_FRAME", "Text frames required");
        auto value = Json::parse(beast::buffers_to_string(self->buffer_.data()));
        self->buffer_.consume(self->buffer_.size());
        self->message_(value);
        if (!self->ended_)
          self->read();
      } catch (...) {
        self->finish();
      }
    });
  }
  void write() {
    auto self = shared_from_this();
    stream_.text(true);
    stream_.async_write(asio::buffer(writes_.front()), [self](auto error, size_t) {
      if (error) {
        self->finish();
        return;
      }
      self->bytes_ -= self->writes_.front().size();
      self->writes_.pop_front();
      if (!self->ended_ && !self->writes_.empty())
        self->write();
    });
  }

public:
  UnixSocket(asio::io_context &io, std::string path, SocketMessage message, SocketClosed closed)
      : stream_(io), path_(std::move(path)), message_(std::move(message)),
        closed_(std::move(closed)) {}
  bool ready() const override { return open_ && !ended_; }
  void start() override {
    auto self = shared_from_this();
    stream_.next_layer().async_connect(
        asio::local::stream_protocol::endpoint(path_), [self](auto error) {
          if (error) {
            self->finish();
            return;
          }
          self->stream_.read_message_max(max_frame);
          self->stream_.set_option(ws::stream_base::timeout::suggested(beast::role_type::client));
          self->stream_.async_handshake("localhost", "/", [self](auto error) {
            if (error) {
              self->finish();
              return;
            }
            self->open_ = true;
            self->read();
          });
        });
  }
  void send_text(std::string value) override {
    if (!ready())
      throw Error("APPROVAL_UNAVAILABLE", "Original server connection is closed");
    if (value.size() > max_frame || bytes_ + value.size() > max_queue)
      throw Error("BACKPRESSURE", "Approval transport limit reached");
    bytes_ += value.size();
    const bool idle = writes_.empty();
    writes_.push_back(std::move(value));
    if (idle)
      write();
  }
  void close() override { finish(); }
};
} // namespace
std::shared_ptr<Socket> unix_socket(asio::io_context &io, const std::string &path,
                                    SocketMessage message, SocketClosed closed) {
  if (!std::filesystem::u8path(path).is_absolute())
    throw Error("CONFIG_ERROR", "Approval socket path must be absolute");
  const auto resolved = std::filesystem::canonical(std::filesystem::u8path(path)).string();
  struct stat status {};
  if (stat(resolved.c_str(), &status) || !S_ISSOCK(status.st_mode) || status.st_uid != geteuid() ||
      (status.st_mode & 0077))
    throw Error("CONFIG_ERROR", "Approval socket must be private and owned by the Agent user");
  return std::make_shared<UnixSocket>(io, resolved, std::move(message), std::move(closed));
}
} // namespace coc
#else
namespace coc {
std::shared_ptr<Socket> unix_socket(asio::io_context &, const std::string &, SocketMessage,
                                    SocketClosed) {
  throw Error("CONFIG_ERROR", "Use a loopback WebSocket approvalEndpoint on Windows");
}
} // namespace coc
#endif
