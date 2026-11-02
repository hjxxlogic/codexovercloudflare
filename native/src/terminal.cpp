#include "coc/terminal.hpp"
#include "coc/delivery.hpp"
#include <array>
#include <map>
#include <openssl/evp.h>
#ifdef __linux__
#include <climits>
#include <fcntl.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#endif
namespace coc {
namespace {
std::string encode(const std::string &bytes) {
  std::string result(4 * ((bytes.size() + 2) / 3), '\0');
  if (!bytes.empty())
    EVP_EncodeBlock(reinterpret_cast<unsigned char *>(&result[0]),
                    reinterpret_cast<const unsigned char *>(bytes.data()), int(bytes.size()));
  return result;
}
std::string decode(const std::string &text) {
  if (text.empty() || text.size() > 5464 || text.size() % 4)
    throw Error("INVALID_REQUEST", "Invalid terminal input encoding");
  std::string bytes(text.size(), '\0');
  auto count =
      EVP_DecodeBlock(reinterpret_cast<unsigned char *>(&bytes[0]),
                      reinterpret_cast<const unsigned char *>(text.data()), int(text.size()));
  if (count < 0)
    throw Error("INVALID_REQUEST", "Invalid terminal input encoding");
  if (text.back() == '=')
    --count;
  if (text.size() > 1 && text[text.size() - 2] == '=')
    --count;
  bytes.resize(size_t(count));
  if (bytes.size() > 4096 || encode(bytes) != text)
    throw Error("INVALID_REQUEST", "Noncanonical terminal input encoding");
  return bytes;
}
int dimension(const Json &d, const char *key, int fallback) {
  if (d.contains(key) && !d.at(key).is_number_integer())
    throw Error("INVALID_REQUEST", "Terminal dimensions must be integers");
  const auto value = d.value(key, fallback);
  if (value < 2 || value > 500)
    throw Error("INVALID_REQUEST", "Terminal dimensions out of range");
  return value;
}
} // namespace
struct Terminals::Impl : std::enable_shared_from_this<Terminals::Impl> {
  boost::asio::io_context &io;
  bool enabled = false;
  explicit Impl(boost::asio::io_context &context, const Json &config) : io(context) {
    const auto settings = config.value("terminal", Json::object());
    if (!settings.is_object() ||
        (settings.contains("enabled") && !settings["enabled"].is_boolean()))
      throw Error("CONFIG_ERROR", "terminal.enabled must be a boolean");
    for (const auto &entry : settings.items())
      if (entry.key() != "enabled")
        throw Error("CONFIG_ERROR", "Unknown terminal option");
#ifdef __linux__
    struct stat st {};
    enabled = settings.value("enabled", false) &&
              config.value("sandbox", "read-only") == "workspace-write" &&
              stat("/usr/bin/bwrap", &st) == 0 && st.st_uid == 0 && !(st.st_mode & 0022) &&
              access("/usr/bin/bwrap", X_OK) == 0;
#endif
  }
#ifdef __linux__
  struct Process : std::enable_shared_from_this<Process> {
    boost::asio::posix::stream_descriptor pty;
    boost::asio::steady_timer timer;
    std::string id, project, session, owner, control, output, last_digest;
    int pid = -1, status = -1;
    int64_t start = 0, end = 0, next = 1, touched = now();
    bool exited = false, closing = false;
    std::array<char, 16384> buffer{};
    Process(boost::asio::io_context &io) : pty(io), timer(io) {}
    void stop() {
      if (closing)
        return;
      closing = true;
      if (pid > 0) {
        ::kill(-pid, SIGKILL);
        ::kill(pid, SIGKILL);
      }
    }
    ~Process() {
      stop();
      if (pid > 0) {
        int value = 0;
        while (::waitpid(pid, &value, 0) < 0 && errno == EINTR) {
        }
      }
    }
    void read() {
      auto self = shared_from_this();
      pty.async_read_some(boost::asio::buffer(buffer), [self](auto ec, size_t count) {
        if (count) {
          self->output.append(self->buffer.data(), count);
          self->end += int64_t(count);
          if (self->output.size() > 256 * 1024) {
            const auto remove = self->output.size() - 256 * 1024;
            self->output.erase(0, remove);
            self->start += int64_t(remove);
          }
        }
        if (!ec)
          self->read();
      });
    }
    void poll() {
      auto self = shared_from_this();
      timer.expires_after(std::chrono::milliseconds(200));
      timer.async_wait([self](auto ec) {
        if (ec)
          return;
        if (now() - self->touched > 60000)
          self->stop();
        int status = 0;
        const auto child = ::waitpid(self->pid, &status, WNOHANG);
        if (child == self->pid || (child < 0 && errno == ECHILD)) {
          self->exited = true;
          self->status = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
          // Kill background descendants as well; bwrap's PID namespace init
          // and die-with-parent prevent detached children surviving the shell.
          self->stop();
          self->pid = -1;
          boost::system::error_code ignored;
          self->pty.close(ignored);
        } else
          self->poll();
      });
    }
  };
  std::map<std::string, std::shared_ptr<Process>> processes;
  void prune() {
    for (auto it = processes.begin(); it != processes.end();) {
      if (it->second->exited && now() - it->second->touched > 60000)
        it = processes.erase(it);
      else
        ++it;
    }
  }
  std::shared_ptr<Process> spawn(const Json &d, const std::string &root) {
    prune();
    if (processes.size() >= 4)
      throw Error("BACKPRESSURE", "Terminal process slots are full");
    for (const auto &entry : processes)
      if (!entry.second->exited && entry.second->project == d.at("projectId"))
        throw Error("PROJECT_BUSY", "Project already has a terminal");
    // Resolve paths before fork. After fork use async-signal-safe syscalls only.
    const auto real = std::filesystem::canonical(root).u8string();
    if (real != root || root == "/" || root == "/usr" || root == "/etc")
      throw Error("INVALID_PATH", "Unsafe terminal project root");
    std::vector<std::string> args = {
        "/usr/bin/bwrap", "--die-with-parent", "--unshare-all", "--cap-drop", "ALL",
        "--clearenv",     "--ro-bind",         "/usr",          "/usr"};
    for (const auto *path : {"/bin", "/lib", "/lib64"}) {
      if (!std::filesystem::exists(path))
        continue;
      if (std::filesystem::is_symlink(path)) {
        args.push_back("--symlink");
        args.push_back(std::filesystem::read_symlink(path).u8string());
        args.push_back(path);
      } else {
        args.push_back("--ro-bind");
        args.push_back(path);
        args.push_back(path);
      }
    }
    const std::vector<std::string> tail = {"--proc",
                                           "/proc",
                                           "--dev",
                                           "/dev",
                                           "--tmpfs",
                                           "/tmp",
                                           "--dir",
                                           "/home/terminal",
                                           "--bind",
                                           root,
                                           "/workspace",
                                           "--chdir",
                                           "/workspace",
                                           "--setenv",
                                           "HOME",
                                           "/home/terminal",
                                           "--setenv",
                                           "PATH",
                                           "/usr/bin:/bin",
                                           "--setenv",
                                           "TERM",
                                           "xterm-256color",
                                           "--setenv",
                                           "LANG",
                                           "C.UTF-8",
                                           "--",
                                           "/usr/bin/prlimit",
                                           "--nproc=32:32",
                                           "--",
                                           "/bin/bash",
                                           "--noprofile",
                                           "--norc",
                                           "-i"};
    args.insert(args.end(), tail.begin(), tail.end());
    std::vector<char *> argv;
    for (auto &arg : args)
      argv.push_back(&arg[0]);
    argv.push_back(nullptr);
    char *env[] = {nullptr};
    const int master = ::posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC | O_NONBLOCK);
    if (master < 0)
      throw Error("SPAWN_FAILED", "Could not allocate PTY");
    int slave = -1;
    if (::grantpt(master) == 0 && ::unlockpt(master) == 0) {
      char path[256];
      if (::ptsname_r(master, path, sizeof(path)) == 0)
        slave = ::open(path, O_RDWR | O_NOCTTY | O_CLOEXEC);
    }
    if (slave < 0) {
      ::close(master);
      throw Error("SPAWN_FAILED", "Could not open PTY slave");
    }
    const int cols = dimension(d, "cols", 80), rows = dimension(d, "rows", 24);
    struct winsize ws {};
    ws.ws_col = static_cast<unsigned short>(cols);
    ws.ws_row = static_cast<unsigned short>(rows);
    if (::ioctl(slave, TIOCSWINSZ, &ws) != 0) {
      ::close(slave);
      ::close(master);
      throw Error("SPAWN_FAILED", "Could not size PTY");
    }
    struct rlimit descriptors {};
    if (::getrlimit(RLIMIT_NOFILE, &descriptors) != 0) {
      ::close(slave);
      ::close(master);
      throw Error("SPAWN_FAILED", "Could not inspect descriptor limit");
    }
    const auto parent = ::getpid();
    const auto pid = ::fork();
    if (pid == 0) {
      if (::prctl(PR_SET_PDEATHSIG, SIGKILL) != 0)
        _exit(127);
      if (::getppid() != parent)
        _exit(127);
      if (::setsid() < 0 || ::ioctl(slave, TIOCSCTTY, 0) != 0 || ::dup2(slave, 0) < 0 ||
          ::dup2(slave, 1) < 0 || ::dup2(slave, 2) < 0)
        _exit(127);
      struct rlimit memory {
        256 * 1024 * 1024, 256 * 1024 * 1024
      }, files{64, 64}, cpu{300, 300}, core{0, 0}, size{64 * 1024 * 1024, 64 * 1024 * 1024};
      if (::setrlimit(RLIMIT_AS, &memory) != 0 || ::setrlimit(RLIMIT_NOFILE, &files) != 0 ||
          ::setrlimit(RLIMIT_CPU, &cpu) != 0 || ::setrlimit(RLIMIT_CORE, &core) != 0 ||
          ::setrlimit(RLIMIT_FSIZE, &size) != 0)
        _exit(127);
        // No descriptors from the multithreaded Agent may enter the sandbox.
#ifdef SYS_close_range
      if (::syscall(SYS_close_range, 3U, UINT_MAX, 0) != 0)
#endif
        for (rlim_t fd = 3; fd < descriptors.rlim_cur; ++fd)
          ::close(int(fd));
      ::execve(argv[0], argv.data(), env);
      const char message[] = "Terminal sandbox failed to start\r\n";
      const auto ignored = ::write(2, message, sizeof(message) - 1);
      (void)ignored;
      _exit(127);
    }
    ::close(slave);
    if (pid < 0) {
      ::close(master);
      throw Error("SPAWN_FAILED", "Could not fork terminal");
    }
    auto process = std::make_shared<Process>(io);
    process->pid = pid;
    process->id = uuid();
    process->project = d.at("projectId");
    process->session = d.at("sessionId");
    process->owner = d.at("owner");
    process->control = d.at("control").dump();
    process->pty.assign(master);
    processes[process->id] = process;
    process->read();
    process->poll();
    return process;
  }
#endif
};
Terminals::Terminals(boost::asio::io_context &io, const Json &config)
    : impl_(std::make_shared<Impl>(io, config)) {}
Terminals::~Terminals() { clear(); }
Json Terminals::metadata() const {
  return {{"enabled", impl_->enabled},
          {"platform", "linux-bubblewrap"},
          {"graceMs", 60000},
          {"maxInputBytes", 4096},
          {"maxOutputBytes", 262144}};
}
bool Terminals::busy(const std::string &project) const {
#ifdef __linux__
  for (const auto &entry : impl_->processes)
    if (!entry.second->exited && entry.second->project == project)
      return true;
#else
  (void)project;
#endif
  return false;
}
void Terminals::close_session(const std::string &session) {
#ifdef __linux__
  for (auto &entry : impl_->processes)
    if (entry.second->session == session)
      entry.second->stop();
#else
  (void)session;
#endif
}
void Terminals::clear() {
#ifdef __linux__
  for (auto &entry : impl_->processes)
    entry.second->stop();
#endif
}
Json Terminals::request(const Json &d, const std::string &root) {
  if (d.at("operation") == "info")
    return metadata();
  if (!impl_->enabled)
    throw Error(
        "TERMINAL_DISABLED",
        "Enable terminal.enabled on a Linux workspace-write Agent with bubblewrap installed");
#ifdef __linux__
  if (d.at("operation") == "open") {
    const auto process = impl_->spawn(d, root);
    return {{"terminalId", process->id}, {"next", 1}, {"offset", 0}};
  }
  const auto found = impl_->processes.find(d.at("terminalId"));
  if (found == impl_->processes.end())
    throw Error("TERMINAL_GONE",
                "Terminal runtime no longer exists; old input must not be replayed");
  auto process = found->second;
  if (process->owner != d.at("owner") || process->project != d.at("projectId") ||
      process->session != d.at("sessionId") || process->control != d.at("control").dump())
    throw Error("FORBIDDEN", "Terminal belongs to another controller");
  process->touched = now();
  const auto operation = d.at("operation").get<std::string>();
  if (operation == "read") {
    const auto requested = d.value("offset", int64_t(0));
    if (requested < 0 || requested > process->end)
      throw Error("INVALID_REQUEST", "Invalid terminal output offset");
    const auto offset = std::max(requested, process->start);
    const auto data = process->output.substr(size_t(offset - process->start), 32768);
    return {{"data", encode(data)},
            {"offset", offset + int64_t(data.size())},
            {"gap", requested < process->start},
            {"more", offset + int64_t(data.size()) < process->end},
            {"exited", process->exited},
            {"exitCode", process->exited ? Json(process->status) : Json()},
            {"next", process->next}};
  }
  if (operation == "close") {
    process->stop();
    return {{"closing", true}};
  }
  if (process->exited || process->closing)
    throw Error("TERMINAL_GONE", "Terminal exited");
  if (!d.at("seq").is_number_integer() || d.at("seq") < 1 || d.at("seq") > 9007199254740991LL)
    throw Error("INVALID_REQUEST", "Invalid terminal input sequence");
  const auto seq = d.at("seq").get<int64_t>();
  const auto fingerprint = delivery_digest(d.dump());
  if (seq == process->next - 1 && fingerprint == process->last_digest)
    return {{"next", process->next}};
  if (seq != process->next)
    throw Error("TERMINAL_INPUT_ORDER",
                "Terminal input sequence mismatch; query runtime before continuing");
  if (operation == "input") {
    const auto bytes = decode(d.at("data"));
    const auto count = ::write(process->pty.native_handle(), bytes.data(), bytes.size());
    if (count != static_cast<ssize_t>(bytes.size())) {
      process->stop();
      throw Error("RESULT_UNKNOWN",
                  "PTY input was partially written; runtime terminated, do not replay input");
    }
  } else if (operation == "resize") {
    struct winsize ws {};
    ws.ws_col = static_cast<unsigned short>(dimension(d, "cols", 80));
    ws.ws_row = static_cast<unsigned short>(dimension(d, "rows", 24));
    if (::ioctl(process->pty.native_handle(), TIOCSWINSZ, &ws) != 0)
      throw Error("TERMINAL_GONE", "Could not resize PTY");
  } else
    throw Error("INVALID_REQUEST", "Unknown terminal operation");
  ++process->next;
  process->last_digest = fingerprint;
  return {{"next", process->next}};
#else
  (void)root;
  throw Error("TERMINAL_DISABLED", "Terminal isolation is not implemented on this platform");
#endif
}
} // namespace coc
