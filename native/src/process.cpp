#include "coc/process.hpp"
#include <algorithm>
#include <cctype>
#include <iostream>
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
                           std::function<void(Json)> msg, std::function<void()> ex)
    : io_(io), input_(io), output_(io), poll_(io), kill_(io), message_(std::move(msg)),
      exit_(std::move(ex)) {
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
  input_.assign(in[1]);
  output_.assign(out[0]);
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
                           std::function<void(Json)> msg, std::function<void()> ex)
    : io_(io), input_(io), output_(io), poll_(io), kill_(io), message_(std::move(msg)),
      exit_(std::move(ex)) {
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
          self->pending_.count(m["id"].get<int>())) {
        auto p = self->pending_.extract(m["id"].get<int>()).mapped();
        p.timer->cancel();
        if (m.contains("error"))
          p.done(nullptr, {{"code", "CODEX_ERROR"},
                           {"message", m["error"].value("message", "Codex error")}});
        else
          p.done(m.value("result", Json::object()), nullptr);
      } else
        self->message_(m);
      self->read();
    } catch (...) {
      self->close();
    }
  });
}
void CodexProcess::send(const Json &m) {
  auto s = m.dump() + "\n";
  if (exited_ || closing_)
    throw Error("CODEX_EXITED", "Codex exited");
  if (s.size() > max_frame || queued_ + s.size() > max_queue)
    throw Error("BACKPRESSURE", "Codex input limit reached");
  bool idle = writes_.empty();
  queued_ += s.size();
  writes_.push_back(std::move(s));
  if (idle)
    write();
}
void CodexProcess::write() {
  auto self = shared_from_this();
  asio::async_write(input_, asio::buffer(writes_.front()), [self](auto ec, size_t) {
    if (ec) {
      self->close();
      return;
    }
    self->queued_ -= self->writes_.front().size();
    self->writes_.pop_front();
    if (!self->writes_.empty())
      self->write();
  });
}
void CodexProcess::request(const std::string &m, const Json &p, Completion done) {
  int id = ++next_;
  auto t = std::make_shared<asio::steady_timer>(io_, std::chrono::seconds(20));
  pending_[id] = {done, t};
  auto self = shared_from_this();
  t->async_wait([self, id](auto ec) {
    if (!ec && self->pending_.count(id)) {
      auto p = self->pending_.extract(id).mapped();
      p.done(nullptr, {{"code", "RESULT_UNKNOWN"}, {"message", "Codex response timed out"}});
    }
  });
  try {
    send({{"id", id}, {"method", m}, {"params", p}});
  } catch (const std::exception &e) {
    pending_.erase(id);
    t->cancel();
    done(nullptr, error_data(e));
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
  auto pending = std::move(pending_);
  pending_.clear();
  for (auto &[id, p] : pending) {
    p.timer->cancel();
    p.done(nullptr, {{"code", "CODEX_EXITED"}, {"message", "Codex process exited"}});
  }
  exit_();
}
void CodexProcess::close() {
  if (exited_ || closing_)
    return;
  closing_ = true;
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
