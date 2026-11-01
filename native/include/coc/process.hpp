#pragma once
#include "common.hpp"
#ifdef _WIN32
#include "windows.hpp"
#endif
#include <boost/asio.hpp>
#include <deque>
#include <functional>
#include <map>
#include <memory>
namespace coc {
namespace asio = boost::asio;
std::string verify_codex(const Json &config);
using Completion = std::function<void(Json, Json)>; // result, error (null on success)
enum class CodexProcessRole { runtime, reader };
class CodexProcess : public std::enable_shared_from_this<CodexProcess> {
  struct Resources;
  std::shared_ptr<Resources> resources_;
  asio::io_context &io_;
#ifdef _WIN32
  asio::windows::stream_handle input_, output_;
  std::unique_ptr<WindowsChild> child_;
#else
  asio::posix::stream_descriptor input_, output_;
#endif
  asio::steady_timer poll_, kill_;
  boost::asio::streambuf buffer_{max_queue};
  struct Write {
    std::string body;
    std::shared_ptr<void> reservation;
    bool priority;
  };
  std::deque<std::shared_ptr<Write>> writes_, priority_writes_;
  std::shared_ptr<Write> writing_;
  int pid_ = -1;
  int64_t next_ = 0;
  bool exited_ = false, closing_ = false;
  struct Pending {
    Completion done;
    std::shared_ptr<asio::steady_timer> timer;
    std::shared_ptr<void> reservation;
  };
  std::map<int64_t, Pending> pending_;
  std::function<void(Json)> message_;
  std::function<void()> exit_;
  std::shared_ptr<Write> prepare(const Json &);
  void enqueue(std::shared_ptr<Write>);
  void read();
  void write();
  void reap();
  void exit();

public:
  CodexProcess(asio::io_context &, const Json &config, const std::string &cwd,
               std::function<void(Json)>, std::function<void()>,
               CodexProcessRole role = CodexProcessRole::runtime);
  ~CodexProcess();
  void start();
  void send(const Json &);
  void request(const std::string &, const Json &, Completion,
               const std::function<void()> &before_send = {});
  static Json usage();
  void initialize(Completion);
  void close();
};
} // namespace coc
