#include "coc/process.hpp"
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
namespace coc {
void verify_codex(const Json &c) {
  std::vector<std::string> args = {c.at("codexPath")};
  for (auto &a : c.at("codexArgs"))
    args.push_back(a);
  args.push_back("--version");
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
    execvp(argv[0], argv.data());
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
  if (!ended || !WIFEXITED(status) || WEXITSTATUS(status) != 0 || output != "codex-cli 0.164.0")
    throw Error("CODEX_VERSION", "Unsupported Codex version; expected codex-cli 0.164.0");
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
    execvp(argv[0], argv.data());
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
      if (n > max_frame - 4096)
        throw Error("MESSAGE_TOO_LARGE", "Codex output exceeds frame limit");
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
          {{"clientInfo", {{"name", "coc-web"}, {"version", "0.2.0"}}},
           {"capabilities", {{"experimentalApi", false}}}},
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
    int status;
    int r = waitpid(self->pid_, &status, WNOHANG);
    if (r == self->pid_ || (r < 0 && errno == ECHILD))
      self->exit();
    else
      self->reap();
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
  ::kill(-pid_, SIGTERM);
  auto self = shared_from_this();
  kill_.expires_after(std::chrono::seconds(3));
  kill_.async_wait([self](auto ec) {
    if (!ec && !self->exited_)
      ::kill(-self->pid_, SIGKILL);
  });
}
} // namespace coc
