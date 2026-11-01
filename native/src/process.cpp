#include "coc/process.hpp"
#include "coc/credit.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <iostream>
#include <mutex>
#ifndef _WIN32
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#else
#include "coc/windows.hpp"
#endif
namespace coc {
namespace {
struct ResourceCounter {
  size_t records = 0, bytes = 0;
};
struct ProcessTotals {
  std::mutex mutex;
  size_t runtimes = 0, readers = 0;
  std::array<ResourceCounter, 4> used;
};
ProcessTotals &process_totals() {
  static ProcessTotals totals;
  return totals;
}
const std::array<size_t, 4> local_records = {
    credit::process_pending, credit::process_priority_pending, credit::process_queue_records,
    credit::process_priority_queue_records};
const std::array<size_t, 4> global_records = {
    credit::process_pending_global, credit::process_priority_pending_global,
    credit::process_queue_global_records, credit::process_priority_queue_global_records};
const std::array<size_t, 4> local_bytes = {
    credit::process_pending_bytes, credit::process_priority_pending_bytes,
    credit::process_queue_bytes, credit::process_priority_queue_bytes};
const std::array<size_t, 4> global_bytes = {
    credit::process_pending_global_bytes, credit::process_priority_pending_global_bytes,
    credit::process_queue_global_bytes, credit::process_priority_queue_global_bytes};
bool priority_message(const Json &message) {
  return message.value("method", "") == "turn/interrupt" ||
         (!message.contains("method") && message.contains("id"));
}
Json codex_environment(const Json &config) {
  Json environment = Json::object();
  const auto proxy = config.value("codexUseProxy", false) ? config.value("proxy", "") : "";
  for (const auto key : {"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY",
                         "all_proxy", "NO_PROXY", "no_proxy"})
    environment[key] = nullptr;
  if (!proxy.empty()) {
    for (const auto key :
         {"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"})
      environment[key] = proxy;
    environment["NO_PROXY"] = environment["no_proxy"] = "localhost,127.0.0.1,::1";
  }
  return environment;
}
#ifndef _WIN32
std::vector<std::string> child_environment(const Json &changes) {
  std::vector<std::string> environment;
  for (auto entry = ::environ; *entry; ++entry) {
    std::string value(*entry);
    const auto end = value.find('=');
    auto key = value.substr(0, end);
    std::transform(key.begin(), key.end(), key.begin(),
                   [](unsigned char c) { return char(std::toupper(c)); });
    if (!changes.contains(key))
      environment.push_back(std::move(value));
  }
  for (auto it = changes.begin(); it != changes.end(); ++it)
    if (!it.value().is_null())
      environment.push_back(it.key() + "=" + it.value().get<std::string>());
  return environment;
}
#endif
} // namespace
struct CodexProcess::Resources : std::enable_shared_from_this<Resources> {
  CodexProcessRole role;
  bool active = true;
  std::array<ResourceCounter, 4> used;
  explicit Resources(CodexProcessRole value) : role(value) {
    auto &totals = process_totals();
    std::lock_guard<std::mutex> lock(totals.mutex);
    auto &count = role == CodexProcessRole::reader ? totals.readers : totals.runtimes;
    const auto limit =
        role == CodexProcessRole::reader ? credit::reader_processes : credit::runtime_processes;
    if (count >= static_cast<size_t>(limit))
      throw Error("BACKPRESSURE", "Codex process budget exhausted");
    ++count;
  }
  void release_process() {
    auto &totals = process_totals();
    std::lock_guard<std::mutex> lock(totals.mutex);
    if (active) {
      --(role == CodexProcessRole::reader ? totals.readers : totals.runtimes);
      active = false;
    }
  }
  ~Resources() { release_process(); }
  struct Lease {
    std::shared_ptr<Resources> owner;
    size_t kind, bytes;
    Lease(std::shared_ptr<Resources> value, size_t category, size_t charge)
        : owner(std::move(value)), kind(category), bytes(charge) {
      auto &totals = process_totals();
      std::lock_guard<std::mutex> lock(totals.mutex);
      auto &local = owner->used[kind];
      auto &global = totals.used[kind];
      if (local.records >= local_records[kind] || global.records >= global_records[kind] ||
          bytes > local_bytes[kind] - local.bytes || bytes > global_bytes[kind] - global.bytes)
        throw Error("BACKPRESSURE", "Codex pending or input budget exhausted");
      ++local.records;
      local.bytes += bytes;
      ++global.records;
      global.bytes += bytes;
    }
    ~Lease() {
      auto &totals = process_totals();
      std::lock_guard<std::mutex> lock(totals.mutex);
      --owner->used[kind].records;
      owner->used[kind].bytes -= bytes;
      --totals.used[kind].records;
      totals.used[kind].bytes -= bytes;
    }
  };
  std::shared_ptr<void> take(size_t kind, size_t bytes) {
    return std::make_shared<Lease>(shared_from_this(), kind, bytes);
  }
};
Json CodexProcess::usage() {
  auto &totals = process_totals();
  std::lock_guard<std::mutex> lock(totals.mutex);
  return {{"runtimes", totals.runtimes},
          {"readers", totals.readers},
          {"normalPending", totals.used[0].records},
          {"normalPendingBytes", totals.used[0].bytes},
          {"priorityPending", totals.used[1].records},
          {"priorityPendingBytes", totals.used[1].bytes},
          {"normalQueued", totals.used[2].records},
          {"normalQueuedBytes", totals.used[2].bytes},
          {"priorityQueued", totals.used[3].records},
          {"priorityQueuedBytes", totals.used[3].bytes}};
}
#ifndef _WIN32
std::string verify_codex(const Json &c) {
  std::vector<std::string> args = {c.at("codexPath")};
  for (auto &a : c.at("codexArgs"))
    args.push_back(a);
  args.push_back("--version");
  const auto changes =
      c.contains("codexUseProxy") || c.contains("proxy") ? codex_environment(c) : Json::object();
  auto environment = child_environment(changes);
  std::vector<char *> envp;
  for (auto &entry : environment)
    envp.push_back(entry.data());
  envp.push_back(nullptr);
  std::vector<char *> argv;
  for (auto &a : args)
    argv.push_back(a.data());
  argv.push_back(nullptr);
  int fds[2];
  if (pipe2(fds, O_CLOEXEC) < 0)
    throw Error("SPAWN_FAILED", "Cannot verify Codex version");
  int pid = fork();
  if (pid == 0) {
    setpgid(0, 0);
    dup2(fds[1], 1);
    int dev = open("/dev/null", O_WRONLY);
    if (dev >= 0) {
      dup2(dev, 2);
      ::close(dev);
    }
    ::close(fds[0]);
    ::close(fds[1]);
    execvpe(argv[0], argv.data(), envp.data());
    _exit(127);
  }
  ::close(fds[1]);
  if (pid < 0) {
    ::close(fds[0]);
    throw Error("SPAWN_FAILED", "Cannot verify Codex version");
  }
  setpgid(pid, pid);
  fcntl(fds[0], F_SETFL, O_NONBLOCK);
  std::string output;
  int status = 0;
  bool ended = false;
  auto deadline = now() + 10000;
  while (now() < deadline) {
    char b[512];
    auto n = ::read(fds[0], b, sizeof b);
    if (n > 0) {
      output.append(b, n);
      if (output.size() > 4096)
        break;
    }
    int r = waitpid(pid, &status, WNOHANG);
    if (r == pid) {
      ended = true;
      while ((n = ::read(fds[0], b, sizeof b)) > 0 && output.size() <= 4096)
        output.append(b, n);
      break;
    }
    pollfd fd{fds[0], POLLIN, 0};
    poll(&fd, 1, 20);
  }
  ::close(fds[0]);
  if (!ended) {
    ::kill(-pid, SIGKILL);
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
  }
  while (!output.empty() && (output.back() == '\n' || output.back() == '\r'))
    output.pop_back();
  if (!ended || !WIFEXITED(status) || WEXITSTATUS(status) != 0 || output.empty() ||
      output.size() > 4096)
    throw Error("CODEX_VERSION", "Cannot read Codex version");
  return output;
}

CodexProcess::CodexProcess(asio::io_context &io, const Json &c, const std::string &cwd,
                           std::function<void(Json)> msg, std::function<void()> ex,
                           CodexProcessRole role)
    : resources_(std::make_shared<Resources>(role)), io_(io), input_(io), output_(io), poll_(io),
      kill_(io), message_(std::move(msg)), exit_(std::move(ex)) {
  std::vector<std::string> args = {c.at("codexPath")};
  for (auto &a : c.at("codexArgs"))
    args.push_back(a);
  args.insert(args.end(), {"app-server", "--listen", "stdio://", "-c",
                           "sandbox_mode=\"" + c.at("sandbox").get<std::string>() + "\"", "-c",
                           "approval_policy=\"on-request\""});
  auto environment = child_environment(codex_environment(c));
  std::vector<char *> envp;
  for (auto &entry : environment)
    envp.push_back(entry.data());
  envp.push_back(nullptr);
  std::vector<char *> argv;
  for (auto &a : args)
    argv.push_back(a.data());
  argv.push_back(nullptr);
  int in[2], out[2];
  if (pipe2(in, O_CLOEXEC) < 0)
    throw Error("SPAWN_FAILED", "Cannot create input pipe");
  if (pipe2(out, O_CLOEXEC) < 0) {
    ::close(in[0]);
    ::close(in[1]);
    throw Error("SPAWN_FAILED", "Cannot create output pipe");
  }
  pid_ = fork();
  if (pid_ == 0) {
    setpgid(0, 0);
    if (chdir(cwd.c_str()) < 0)
      _exit(126);
    dup2(in[0], 0);
    dup2(out[1], 1);
    int nullfd = open("/dev/null", O_WRONLY);
    if (nullfd >= 0) {
      dup2(nullfd, 2);
      ::close(nullfd);
    }
    ::close(in[0]);
    ::close(in[1]);
    ::close(out[0]);
    ::close(out[1]);
    execvpe(argv[0], argv.data(), envp.data());
    _exit(127);
  }
  ::close(in[0]);
  ::close(out[1]);
  if (pid_ < 0) {
    ::close(in[1]);
    ::close(out[0]);
    throw Error("SPAWN_FAILED", "Cannot start Codex");
  }
  setpgid(pid_, pid_);
  try {
    input_.assign(in[1]);
    output_.assign(out[0]);
  } catch (...) {
    if (!input_.is_open())
      ::close(in[1]);
    if (!output_.is_open())
      ::close(out[0]);
    ::kill(-pid_, SIGKILL);
    while (waitpid(pid_, nullptr, 0) < 0 && errno == EINTR) {
    }
    throw;
  }
}
CodexProcess::~CodexProcess() {
  if (pid_ > 0 && !exited_) {
    ::kill(-pid_, SIGKILL);
    int status;
    while (waitpid(pid_, &status, 0) < 0 && errno == EINTR) {
    }
  }
}
#else
std::string verify_codex(const Json &c) {
  std::vector<std::string> args = {c.at("codexPath")};
  for (auto &a : c.at("codexArgs"))
    args.push_back(a);
  args.push_back("--version");
  const auto changes =
      c.contains("codexUseProxy") || c.contains("proxy") ? codex_environment(c) : Json::object();
  auto text = windows_capture(args, 4096, changes);
  while (!text.empty() && (text.back() == '\n' || text.back() == '\r'))
    text.pop_back();
  if (text.empty())
    throw Error("CODEX_VERSION", "Cannot read Codex version");
  return text;
}
CodexProcess::CodexProcess(asio::io_context &io, const Json &c, const std::string &cwd,
                           std::function<void(Json)> msg, std::function<void()> ex,
                           CodexProcessRole role)
    : resources_(std::make_shared<Resources>(role)), io_(io), input_(io), output_(io), poll_(io),
      kill_(io), message_(std::move(msg)), exit_(std::move(ex)) {
  std::vector<std::string> args = {c.at("codexPath")};
  for (auto &a : c.at("codexArgs"))
    args.push_back(a);
  args.insert(args.end(), {"app-server", "--listen", "stdio://", "-c",
                           "sandbox_mode=\"" + c.at("sandbox").get<std::string>() + "\"", "-c",
                           "approval_policy=\"on-request\""});
  child_ = std::make_unique<WindowsChild>(args, cwd, true, "", codex_environment(c));
  input_.assign(child_->input.release());
  output_.assign(child_->output.release());
}
CodexProcess::~CodexProcess() = default;
#endif
void CodexProcess::start() {
  read();
  reap();
}
void CodexProcess::read() {
  auto self = shared_from_this();
  asio::async_read_until(output_, buffer_, '\n', [self](auto ec, size_t n) {
    if (ec) {
      self->close();
      return;
    }
    try {
      if (n > max_queue - 4096)
        throw Error("MESSAGE_TOO_LARGE", "Single Codex RPC exceeds local buffer limit");
      std::istream input(&self->buffer_);
      std::string line;
      std::getline(input, line);
      auto m = Json::parse(line);
      if (!m.is_object())
        throw Error("INVALID_FRAME", "Expected RPC object");
      if (m.contains("id") && m["id"].is_number_integer() && !m.contains("method") &&
          m["id"] >= 1 && m["id"] <= 9007199254740991LL &&
          self->pending_.count(m["id"].get<int64_t>())) {
        auto p = self->pending_.extract(m["id"].get<int64_t>()).mapped();
        p.timer->cancel();
        p.reservation.reset();
        if (m.contains("error"))
          p.done(nullptr, {{"code", "CODEX_ERROR"},
                           {"message", m["error"].value("message", "Codex error")},
                           {"rpc", m["error"]}});
        else
          p.done(m.value("result", Json::object()), nullptr);
      } else if (m.contains("method"))
        self->message_(m); // Late replies carry internal IDs and must never reach the client.
      self->read();
    } catch (...) {
      self->close();
    }
  });
}
std::shared_ptr<CodexProcess::Write> CodexProcess::prepare(const Json &message) {
  if (exited_ || closing_)
    throw Error("CODEX_EXITED", "Codex exited");
  auto body = message.dump() + "\n";
  if (body.size() > max_frame)
    throw Error("BACKPRESSURE", "Codex input frame limit reached");
  const bool priority = priority_message(message);
  auto reservation = resources_->take(priority ? 3 : 2, body.size() + 1024);
  return std::make_shared<Write>(Write{std::move(body), std::move(reservation), priority});
}
void CodexProcess::enqueue(std::shared_ptr<Write> frame) {
  (frame->priority ? priority_writes_ : writes_).push_back(std::move(frame));
  write();
}
void CodexProcess::send(const Json &message) { enqueue(prepare(message)); }
void CodexProcess::write() {
  if (writing_ || exited_ || closing_)
    return;
  auto &queue = priority_writes_.empty() ? writes_ : priority_writes_;
  if (queue.empty())
    return;
  auto frame = queue.front();
  queue.pop_front();
  writing_ = frame;
  try {
    asio::async_write(input_, asio::buffer(frame->body),
                      [self = shared_from_this(), frame](auto ec, size_t) {
                        self->writing_.reset();
                        frame->reservation.reset();
                        if (ec) {
                          self->close();
                          return;
                        }
                        self->write();
                      });
  } catch (...) {
    writing_.reset();
    close();
    throw;
  }
}
void CodexProcess::request(const std::string &method, const Json &params, Completion done,
                           const std::function<void()> &before_send) {
  int64_t id = 0;
  std::shared_ptr<asio::steady_timer> timer;
  bool admitted = false;
  try {
    const auto bytes = params.dump().size();
    if (bytes > max_frame || next_ >= 9007199254740991LL)
      throw Error("BACKPRESSURE", "Codex request budget or sequence exhausted");
    auto reservation = resources_->take(method == "turn/interrupt" ? 1 : 0, 4 * bytes + 16384);
    id = ++next_;
    auto frame = prepare({{"id", id}, {"method", method}, {"params", params}});
    timer = std::make_shared<asio::steady_timer>(io_, std::chrono::seconds(20));
    pending_[id] = {done, timer, std::move(reservation)};
    timer->async_wait([self = shared_from_this(), id](auto ec) {
      if (!ec && self->pending_.count(id)) {
        auto pending = self->pending_.extract(id).mapped();
        pending.reservation.reset();
        pending.done(nullptr,
                     {{"code", "RESULT_UNKNOWN"}, {"message", "Codex response timed out"}});
      }
    });
    if (before_send)
      before_send();
    admitted = true;
    enqueue(std::move(frame));
  } catch (const std::exception &error) {
    pending_.erase(id);
    if (timer)
      timer->cancel();
    done(nullptr, admitted ? Json{{"code", "RESULT_UNKNOWN"},
                                  {"message", "Codex input failed after request admission"}}
                           : error_data(error));
  }
}
void CodexProcess::initialize(Completion done) {
  auto self = shared_from_this();
  request("initialize",
          {{"clientInfo", {{"name", "coc-web"}, {"version", "0.5.2"}}},
           {"capabilities", {{"experimentalApi", true}}}},
          [self, done](Json r, Json e) {
            if (e.is_null())
              self->send({{"method", "initialized"}});
            done(r, e);
          });
}
void CodexProcess::reap() {
  auto self = shared_from_this();
  poll_.expires_after(std::chrono::milliseconds(100));
  poll_.async_wait([self](auto ec) {
    if (ec)
      return;
#ifdef _WIN32
    DWORD code = 0;
    if (self->child_->poll(code)) {
      std::cerr << Json{{"event", "codex_exit"},
                        {"time", now()},
                        {"expected", self->closing_},
                        {"exitCode", code}}
                       .dump()
                << '\n';
      self->child_->terminate();
      self->exit();
    } else
      self->reap();
#else
    int status;
    int r = waitpid(self->pid_, &status, WNOHANG);
    if (r == self->pid_ || (r < 0 && errno == ECHILD)) {
      Json metadata = {{"event", "codex_exit"}, {"time", now()}, {"expected", self->closing_}};
      if (r == self->pid_) {
        metadata["exitCode"] = WIFEXITED(status) ? Json(WEXITSTATUS(status)) : Json();
        metadata["signal"] = WIFSIGNALED(status) ? Json(WTERMSIG(status)) : Json();
      }
      std::cerr << metadata.dump() << '\n';
      self->exit();
    } else
      self->reap();
#endif
  });
}
void CodexProcess::exit() {
  if (exited_)
    return;
  exited_ = true;
  kill_.cancel();
  boost::system::error_code ec;
  input_.close(ec);
  output_.close(ec);
  writes_.clear();
  priority_writes_.clear();
  auto pending = std::move(pending_);
  pending_.clear();
  for (auto &[id, p] : pending) {
    p.timer->cancel();
    p.reservation.reset();
    p.done(nullptr,
           {{"code", "RESULT_UNKNOWN"}, {"message", "Codex exited before confirming the result"}});
  }
  exit_();
}
void CodexProcess::close() {
  if (exited_ || closing_)
    return;
  closing_ = true;
  writes_.clear();
  priority_writes_.clear();
#ifdef _WIN32
  child_->terminate();
#else
  ::kill(-pid_, SIGTERM);
  auto self = shared_from_this();
  kill_.expires_after(std::chrono::seconds(3));
  kill_.async_wait([self](auto ec) {
    if (!ec && !self->exited_)
      ::kill(-self->pid_, SIGKILL);
  });
#endif
}
} // namespace coc
