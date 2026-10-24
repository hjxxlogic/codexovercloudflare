#pragma once
#include "common.hpp"
#include <boost/asio.hpp>
#include <deque>
#include <functional>
#include <map>
#include <memory>
namespace coc {
namespace asio = boost::asio;
void verify_codex(const Json &config);
using Completion = std::function<void(Json, Json)>; // result, error (null on success)
class CodexProcess : public std::enable_shared_from_this<CodexProcess> {
  asio::io_context &io_;
  asio::posix::stream_descriptor input_, output_;
  asio::steady_timer poll_, kill_;
  boost::asio::streambuf buffer_{max_frame};
  std::deque<std::string> writes_;
  size_t queued_ = 0;
  int pid_ = -1, next_ = 0;
  bool exited_ = false, closing_ = false;
  struct Pending {
    Completion done;
    std::shared_ptr<asio::steady_timer> timer;
  };
  std::map<int, Pending> pending_;
  std::function<void(Json)> message_;
  std::function<void()> exit_;
  void read();
  void write();
  void reap();
  void exit();

public:
  CodexProcess(asio::io_context &, const Json &config, const std::string &cwd,
               std::function<void(Json)>, std::function<void()>);
  ~CodexProcess();
  void start();
  void send(const Json &);
  void request(const std::string &, const Json &, Completion);
  void initialize(Completion);
  void close();
};
} // namespace coc
