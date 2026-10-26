#include "coc/network.hpp"
#include "coc/proxy.hpp"
#include "coc/tls.hpp"
#include <boost/asio/ssl.hpp>
#include <boost/beast.hpp>
#include <boost/beast/ssl.hpp>
#ifndef _WIN32
#include <fcntl.h>
#include <set>
#include <signal.h>
#include <sstream>
#include <sys/wait.h>
#include <unistd.h>
#else
#include "coc/windows.hpp"
#include <cstring>
#include <ws2tcpip.h>
#endif
namespace coc {
namespace beast = boost::beast;
namespace http = beast::http;
namespace ssl = asio::ssl;
using tcp = asio::ip::tcp;
namespace {
// getaddrinfo may outlive Asio cancellation. Isolate libc resolution in a
// cancellable process so the HTTP deadline also bounds DNS and leaves no worker.
#ifndef _WIN32
class DeadlineResolver {
  asio::posix::stream_descriptor output_;
  std::string buffer_;
  pid_t pid_ = -1;

public:
  explicit DeadlineResolver(asio::io_context &io) : output_(io) {}
  ~DeadlineResolver() { cancel(); }
  void cancel() {
    boost::system::error_code ignored;
    output_.close(ignored);
    if (pid_ > 0) {
      ::kill(pid_, SIGKILL);
      int status;
      while (waitpid(pid_, &status, 0) < 0 && errno == EINTR) {
      }
      pid_ = -1;
    }
  }
  void resolve(const Url &url,
               std::function<void(boost::system::error_code, std::vector<tcp::endpoint>)> done) {
    boost::system::error_code ec;
    auto address = asio::ip::make_address(url.host, ec);
    if (!ec) {
      done({}, {{address, static_cast<unsigned short>(std::stoi(url.port))}});
      return;
    }
    buffer_.clear();
    int pipe[2];
    if (pipe2(pipe, O_CLOEXEC) != 0) {
      done(asio::error::no_descriptors, {});
      return;
    }
    pid_ = fork();
    if (pid_ == 0) {
      dup2(pipe[1], STDOUT_FILENO);
      int nullfd = open("/dev/null", O_WRONLY);
      if (nullfd >= 0)
        dup2(nullfd, STDERR_FILENO);
      ::close(pipe[0]);
      ::close(pipe[1]);
      execl("/usr/bin/getent", "getent", "ahosts", url.host.c_str(), static_cast<char *>(nullptr));
      _exit(127);
    }
    ::close(pipe[1]);
    if (pid_ < 0) {
      ::close(pipe[0]);
      done(asio::error::no_descriptors, {});
      return;
    }
    output_.assign(pipe[0]);
    asio::async_read(
        output_, asio::dynamic_buffer(buffer_, 16384), [this, url, done](auto ec, size_t) {
          cancel();
          if (ec != asio::error::eof) {
            done(ec, {});
            return;
          }
          std::istringstream lines(buffer_);
          std::string line;
          std::set<std::string> seen;
          std::vector<tcp::endpoint> addresses;
          while (std::getline(lines, line) && addresses.size() < 64) {
            std::istringstream fields(line);
            std::string text;
            fields >> text;
            boost::system::error_code error;
            auto address = asio::ip::make_address(text, error);
            if (!error && seen.insert(text).second)
              addresses.emplace_back(address, static_cast<unsigned short>(std::stoi(url.port)));
          }
          done(addresses.empty() ? boost::system::error_code(asio::error::host_not_found)
                                 : boost::system::error_code(),
               addresses);
        });
  }
};
#else
// Windows exposes cancellable asynchronous DNS directly; no resolver worker
// can keep io.run() alive after the HTTP deadline indefinitely.
class DeadlineResolver {
  asio::windows::object_handle event_;
  OVERLAPPED operation_{};
  PADDRINFOEXW answers_ = nullptr;
  HANDLE cancellation_ = nullptr;
  bool pending_ = false;
  std::wstring host_, port_;
  ADDRINFOEXW hints_{};

public:
  explicit DeadlineResolver(asio::io_context &io)
      : event_(io, CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
    operation_.hEvent = event_.native_handle();
  }
  ~DeadlineResolver() {
    if (answers_)
      FreeAddrInfoExW(answers_);
  }
  void cancel() {
    if (pending_ && cancellation_)
      GetAddrInfoExCancel(&cancellation_);
  }
  void resolve(const Url &url,
               std::function<void(boost::system::error_code, std::vector<tcp::endpoint>)> done) {
    auto complete = [this, done](int status) {
      pending_ = false;
      cancellation_ = nullptr;
      std::vector<tcp::endpoint> addresses;
      if (status == 0) {
        for (auto entry = answers_; entry && addresses.size() < 64; entry = entry->ai_next) {
          tcp::endpoint endpoint;
          if ((entry->ai_family == AF_INET || entry->ai_family == AF_INET6) &&
              entry->ai_addrlen <= endpoint.capacity()) {
            std::memcpy(endpoint.data(), entry->ai_addr, entry->ai_addrlen);
            endpoint.resize(entry->ai_addrlen);
            addresses.push_back(endpoint);
          }
        }
      }
      if (answers_) {
        FreeAddrInfoExW(answers_);
        answers_ = nullptr;
      }
      done(status ? boost::system::error_code(status, boost::system::system_category())
                  : boost::system::error_code(),
           addresses);
    };
    ResetEvent(event_.native_handle());
    operation_ = {};
    operation_.hEvent = event_.native_handle();
    hints_.ai_family = AF_UNSPEC;
    hints_.ai_socktype = SOCK_STREAM;
    host_ = wide(url.host);
    port_ = wide(url.port);
    auto status = GetAddrInfoExW(host_.c_str(), port_.c_str(), NS_ALL, nullptr, &hints_, &answers_,
                                 nullptr, &operation_, nullptr, &cancellation_);
    if (status != WSA_IO_PENDING) {
      complete(status);
      return;
    }
    pending_ = true;
    event_.async_wait([this, complete](auto ec) {
      complete(ec ? int(ec.value()) : GetAddrInfoExOverlappedResult(&operation_));
    });
  }
};
#endif
template <class Stream>
std::string exchange(asio::io_context &io, Stream &stream, const Url &u, const std::string &path,
                     const Json &body, const std::string &token, const std::string &request_id,
                     std::chrono::milliseconds timeout, size_t limit = max_queue) {
  DeadlineResolver resolver(io);
  asio::steady_timer deadline(io);
  http::request<http::string_body> req{body.is_null() ? http::verb::get : http::verb::post, path,
                                       11};
  req.set(http::field::host, u.authority);
  req.set(http::field::content_type, "application/json");
  req.set(http::field::origin, u.origin);
  req.set(http::field::user_agent, "coc/0.5.2");
  if (!token.empty())
    req.set(http::field::authorization, "Bearer " + token);
  if (!body.is_null()) {
    req.set("Idempotency-Key", request_id.empty() ? uuid() : request_id);
    req.body() = body.dump();
    req.prepare_payload();
  }
  beast::flat_buffer buffer;
  http::response_parser<http::string_body> parser;
  parser.body_limit(limit);
  boost::system::error_code failure;
  bool completed = false, timed_out = false;
  const auto finish = [&](boost::system::error_code ec) {
    if (completed)
      return;
    completed = true;
    failure = ec;
    deadline.cancel();
    resolver.cancel();
    boost::system::error_code ignored;
    beast::get_lowest_layer(stream).socket().close(ignored);
  };
  const auto write = [&] {
    http::async_write(stream, req, [&](auto ec, size_t) {
      if (ec) {
        finish(ec);
        return;
      }
      http::async_read(stream, buffer, parser, [&](auto ec, size_t) { finish(ec); });
    });
  };
  deadline.expires_after(timeout);
  deadline.async_wait([&](auto ec) {
    if (!ec && !completed) {
      timed_out = true;
      finish(asio::error::timed_out);
    }
  });
  const auto connect = [&](const std::vector<tcp::endpoint> &addresses, bool proxied) {
    beast::get_lowest_layer(stream).async_connect(addresses, [&, proxied](auto ec, auto) {
      if (completed)
        return;
      const auto handshake = [&](boost::system::error_code ec) {
        if (completed)
          return;
        if (ec) {
          finish(ec);
          return;
        }
        if constexpr (std::is_same_v<Stream, beast::tcp_stream>)
          write();
        else
          stream.async_handshake(ssl::stream_base::client, [&](auto ec) {
            if (completed)
              return;
            if (ec)
              finish(ec);
            else
              write();
          });
      };
      if (ec)
        finish(ec);
      else if (proxied)
        proxy_tunnel(beast::get_lowest_layer(stream), u, handshake);
      else
        handshake({});
    });
  };
  resolver.resolve(u, [&](auto ec, auto addresses) {
    if (completed)
      return;
    if (ec) {
      finish(ec);
      return;
    }
    if (auto proxy = proxy_route(u, addresses))
      resolver.resolve(*proxy, [&](auto ec, auto endpoints) {
        if (completed)
          return;
        if (ec)
          finish(ec);
        else
          connect(endpoints, true);
      });
    else
      connect(addresses, false);
  });
  io.run();
  if (timed_out)
    throw Error(
        "HTTP_TIMEOUT",
        "Relay request exceeded its deadline; query mutating request status before retrying");
  if (failure)
    throw Error("HTTP_NETWORK", "Relay transport failed: " + failure.message());
  auto response = parser.release();
  if (response.result_int() < 200 || response.result_int() >= 300) {
    auto data = Json::parse(response.body(), nullptr, false);
    if (!data.is_object())
      throw Error("HTTP_ERROR", "Download or relay request failed");
    auto error = data.value("error", Json::object());
    throw Error(error.value("code", "HTTP_ERROR"), error.value("message", "Relay request failed"));
  }
  return response.body();
}
} // namespace
Json http_json(const Url &u, const std::string &path, const Json &body, const std::string &token,
               const std::string &request_id, std::chrono::milliseconds timeout) {
  asio::io_context io;
  if (u.tls) {
    ssl::context ctx(ssl::context::tls_client);
    configure_trust(ctx);
    beast::ssl_stream<beast::tcp_stream> stream(io, ctx);
    verify_tls_hostname(stream.native_handle(), u.host);
    stream.set_verify_mode(ssl::verify_peer);
    return Json::parse(exchange(io, stream, u, path, body, token, request_id, timeout));
  }
  beast::tcp_stream stream(io);
  return Json::parse(exchange(io, stream, u, path, body, token, request_id, timeout));
}
std::string http_download(const Url &u, const std::string &path, size_t limit,
                          std::chrono::milliseconds timeout) {
  asio::io_context io;
  if (u.tls) {
    ssl::context ctx(ssl::context::tls_client);
    configure_trust(ctx);
    beast::ssl_stream<beast::tcp_stream> stream(io, ctx);
    verify_tls_hostname(stream.native_handle(), u.host);
    stream.set_verify_mode(ssl::verify_peer);
    return exchange(io, stream, u, path, nullptr, "", "", timeout, limit);
  }
  beast::tcp_stream stream(io);
  return exchange(io, stream, u, path, nullptr, "", "", timeout, limit);
}
std::shared_ptr<Socket> connect_socket(asio::io_context &io, const Url &u, const std::string &t,
                                       SocketMessage m, SocketClosed c, const std::string &path) {
  return u.tls ? tls_socket(io, u, t, m, c, path) : plain_socket(io, u, t, m, c, path);
}
} // namespace coc
