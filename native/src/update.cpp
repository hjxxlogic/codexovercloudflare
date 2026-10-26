#include "coc/update.hpp"
#include "coc/build.hpp"
#include "coc/network.hpp"
#ifndef _WIN32
#include <fcntl.h>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <openssl/sha.h>
#include <poll.h>
#include <regex>
#include <spawn.h>
#include <sstream>
#include <sys/stat.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
extern char **environ;
#else
#include "coc/windows.hpp"
#include <iostream>
#include <regex>
#endif
namespace coc {
namespace {
constexpr size_t archive_limit = 32 * 1024 * 1024, binary_limit = 64 * 1024 * 1024;
void require(bool ok, const std::string &message) {
  if (!ok)
    throw Error("UPDATE_FAILED", message);
}
#ifndef _WIN32
std::string digest(const std::string &bytes) {
  unsigned char hash[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char *>(bytes.data()), bytes.size(), hash);
  std::ostringstream out;
  for (auto byte : hash)
    out << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(byte);
  return out.str();
}
// No shell or inherited stdin. Both extraction and candidate startup have bounded
// output and wall time; archive paths never become filesystem extraction targets.
std::string capture(const std::vector<std::string> &args, size_t limit) {
  int descriptors[2];
  require(pipe2(descriptors, O_CLOEXEC) == 0, "Cannot create update process pipe");
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, descriptors[1], STDOUT_FILENO);
  posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
  posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
  posix_spawn_file_actions_addclose(&actions, descriptors[0]);
  posix_spawn_file_actions_addclose(&actions, descriptors[1]);
  std::vector<char *> argv;
  for (const auto &a : args)
    argv.push_back(const_cast<char *>(a.c_str()));
  argv.push_back(nullptr);
  pid_t pid = -1;
  int result = posix_spawn(&pid, argv[0], &actions, nullptr, argv.data(), environ);
  posix_spawn_file_actions_destroy(&actions);
  ::close(descriptors[1]);
  if (result != 0) {
    ::close(descriptors[0]);
    throw Error("UPDATE_FAILED", "Cannot execute update candidate or /bin/tar");
  }
  std::string output;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  try {
    int flags = fcntl(descriptors[0], F_GETFL);
    require(flags >= 0 && fcntl(descriptors[0], F_SETFL, flags | O_NONBLOCK) == 0,
            "Cannot monitor update process");
    int status = 0;
    bool exited = false, eof = false;
    while (!exited || !eof) {
      require(std::chrono::steady_clock::now() < deadline, "Update subprocess timed out");
      pollfd pfd{descriptors[0], POLLIN, 0};
      poll(&pfd, 1, 20);
      char buffer[16384];
      for (;;) {
        auto count = ::read(descriptors[0], buffer, sizeof(buffer));
        if (count == 0) {
          eof = true;
          break;
        }
        if (count < 0) {
          require(errno == EAGAIN || errno == EINTR, "Cannot read update subprocess");
          break;
        }
        require(output.size() + count <= limit, "Update subprocess output exceeds limit");
        output.append(buffer, count);
      }
      if (!exited) {
        auto reaped = waitpid(pid, &status, WNOHANG);
        require(reaped >= 0 || errno == EINTR, "Cannot wait for update subprocess");
        exited = reaped == pid;
        if (exited)
          pid = -1;
      }
    }
    pid = -1;
    require(WIFEXITED(status) && WEXITSTATUS(status) == 0,
            "Update subprocess failed; platform libraries may be incompatible");
    ::close(descriptors[0]);
    return output;
  } catch (...) {
    if (pid > 0) {
      kill(pid, SIGKILL);
      while (waitpid(pid, nullptr, 0) < 0 && errno == EINTR) {
      }
    }
    ::close(descriptors[0]);
    throw;
  }
}
void write_file(const std::filesystem::path &path, const std::string &bytes, mode_t mode) {
  int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  require(fd >= 0, "Cannot create staged update");
  try {
    size_t offset = 0;
    while (offset < bytes.size()) {
      auto count = ::write(fd, bytes.data() + offset, bytes.size() - offset);
      if (count < 0 && errno == EINTR)
        continue;
      require(count > 0, "Cannot write staged update");
      offset += count;
    }
    require(fchmod(fd, mode) == 0 && fsync(fd) == 0, "Cannot persist staged update");
    ::close(fd);
  } catch (...) {
    ::close(fd);
    throw;
  }
}
void sync_parent(const std::filesystem::path &path) {
  int fd = open(path.parent_path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(fd >= 0, "Cannot open executable directory");
  int result = fsync(fd);
  ::close(fd);
  require(result == 0, "Cannot persist executable directory");
}
std::string release_platform() {
#ifdef COC_STATIC_MUSL
  return "musl";
#else
  std::ifstream input("/etc/os-release");
  std::string line, id, version;
  while (std::getline(input, line)) {
    auto value = line.substr(line.find('=') + 1);
    if (value.size() >= 2 && value.front() == '"' && value.back() == '"')
      value = value.substr(1, value.size() - 2);
    if (line.rfind("ID=", 0) == 0)
      id = value;
    if (line.rfind("VERSION_ID=", 0) == 0)
      version = value;
  }
  if (id == "ubuntu" && version == "20.04")
    return "ubuntu20.04";
  if (id == "debian" && version == "12")
    return "debian12";
  throw Error("UPDATE_PLATFORM", "No matching release for this OS; configure autoUpdate.platform");
#endif
}
#endif
void log_error(const std::exception &error) {
  std::cerr << Json{{"event", "auto_update_failed"}, {"error", error_data(error)}}.dump() << '\n';
}
} // namespace
UpdateSettings update_settings(const Json &config) {
  UpdateSettings settings;
  auto value = config.value("autoUpdate", Json(settings.enabled));
  if (value.is_boolean()) {
    settings.enabled = value.get<bool>();
    return settings;
  }
  if (!value.is_object())
    throw Error("CONFIG_ERROR", "autoUpdate must be a boolean or object");
  auto enabled = value.value("enabled", Json(true));
  auto interval = value.value("intervalHours", Json(1));
  auto platform = value.value("platform", Json(""));
  if (!enabled.is_boolean() || !interval.is_number_integer() || interval < 1 || interval > 168 ||
      !platform.is_string() ||
      (platform != "" && platform != "ubuntu20.04" && platform != "debian12" &&
       platform != "windows-x64"))
    throw Error("CONFIG_ERROR", "Invalid autoUpdate enabled, intervalHours (1..168) or platform");
  settings.enabled = enabled.get<bool>();
  settings.interval_hours = interval.get<int>();
  settings.platform = platform.get<std::string>();
  return settings;
}
bool newer_release(const std::string &candidate, const std::string &current) {
  const std::regex pattern("(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})");
  std::smatch a, b;
  require(std::regex_match(candidate, a, pattern) && std::regex_match(current, b, pattern),
          "Release version must be stable major.minor.patch");
  for (int i = 1; i <= 3; ++i) {
    if (std::stoul(a[i]) != std::stoul(b[i]))
      return std::stoul(a[i]) > std::stoul(b[i]);
  }
  return false;
}
#ifndef _WIN32
std::filesystem::path executable_path() { return std::filesystem::read_symlink("/proc/self/exe"); }
PreparedUpdate::PreparedUpdate(std::filesystem::path executable, std::filesystem::path temporary,
                               std::unique_ptr<PrivateLock> lock, uint64_t device, uint64_t inode)
    : executable_(std::move(executable)), temporary_(std::move(temporary)), lock_(std::move(lock)),
      device_(device), inode_(inode) {}
PreparedUpdate::~PreparedUpdate() {
  std::error_code ignored;
  std::filesystem::remove_all(temporary_, ignored);
}
void PreparedUpdate::install() {
  struct stat current {};
  require(lstat(executable_.c_str(), &current) == 0 && S_ISREG(current.st_mode) &&
              static_cast<uint64_t>(current.st_dev) == device_ &&
              static_cast<uint64_t>(current.st_ino) == inode_,
          "Executable changed while update was downloading");
  const auto backup = executable_.string() + ".previous";
  require(link(executable_.c_str(), (temporary_ / "previous").c_str()) == 0,
          "Cannot preserve previous executable");
  require(rename((temporary_ / "previous").c_str(), backup.c_str()) == 0,
          "Cannot publish previous executable");
  sync_parent(executable_);
  require(rename((temporary_ / "candidate").c_str(), executable_.c_str()) == 0,
          "Cannot atomically replace executable");
  sync_parent(executable_);
  std::cerr << Json{{"event", "auto_update_installed"},
                    {"version", release.at("version")},
                    {"backup", backup}}
                   .dump()
            << '\n';
}
std::unique_ptr<PreparedUpdate> prepare_update(const Json &config, const std::string &relay,
                                               bool manual) {
  const auto settings = update_settings(config);
  if (!manual && !settings.enabled)
    return nullptr;
  const auto build = Json::parse(COC_BUILD_JSON);
  if (build.value("dirty", true) && !manual)
    return nullptr; // Never replace developer builds implicitly.
  require(build.at("target") == "linux-x86_64", "Automatic releases support Linux x86_64 only");
  const auto executable = executable_path();
  require(executable.filename() == "coc-agent" || executable.filename() == "coc-client",
          "Install using the official executable name before updating");
  struct stat before {
  }, directory{};
  require(lstat(executable.c_str(), &before) == 0 && S_ISREG(before.st_mode) &&
              before.st_uid == geteuid() && (before.st_mode & (S_ISUID | S_ISGID | 0022)) == 0 &&
              stat(executable.parent_path().c_str(), &directory) == 0 &&
              directory.st_uid == geteuid() && (directory.st_mode & 0022) == 0 &&
              access(executable.parent_path().c_str(), W_OK) == 0,
          "Executable and its directory must be owned and writable by this user, without "
          "group/world write or set-ID bits");
  auto lock = std::make_unique<PrivateLock>(executable.string() + ".update");
  auto state = executable.string() + ".update-state.json";
  if (!manual && std::filesystem::exists(state)) {
    auto checked = read_json(state).value("checkedAt", int64_t(0));
    if (checked > now() - int64_t(settings.interval_hours) * 3600000 && checked <= now())
      return nullptr;
  }
  save_private(state, {{"checkedAt", now()}});
  const auto url = relay_url(relay);
  const auto release =
      Json::parse(http_download(url, "/downloads/index.json", 65536, std::chrono::seconds(5)));
  if (!newer_release(release.at("version"), build.at("version")))
    return nullptr;
  require(release.at("protocol") == build.at("protocol"), "Release protocol is incompatible");
  require(
      release.at("commit").is_string() &&
          std::regex_match(release.at("commit").get<std::string>(), std::regex("[a-f0-9]{40}")) &&
          release.at("sourceDigest").is_string() &&
          std::regex_match(release.at("sourceDigest").get<std::string>(),
                           std::regex("[a-f0-9]{64}")),
      "Release manifest identity is invalid");
  const auto platform = settings.platform.empty() ? release_platform() : settings.platform;
  const auto root = "coc-" + release.at("version").get<std::string>() + "-linux-x86_64-" + platform;
  const auto filename = root + ".tar.gz";
  const auto files = release.at("files");
  require(files.is_array() && std::find(files.begin(), files.end(), Json(filename)) != files.end(),
          "Release does not include this platform");
  const auto checksums =
      http_download(url, "/downloads/SHA256SUMS", 65536, std::chrono::seconds(5));
  std::istringstream lines(checksums);
  std::string line, expected;
  while (std::getline(lines, line)) {
    if (line.size() == 66 + filename.size() && line.substr(64, 2) == "  " &&
        line.substr(66) == filename) {
      require(expected.empty(), "Duplicate archive checksum");
      expected = line.substr(0, 64);
    }
  }
  require(std::regex_match(expected, std::regex("[a-f0-9]{64}")), "Archive checksum is missing");
  auto bytes = http_download(url, "/downloads/" + filename, archive_limit);
  require(digest(bytes) == expected, "Archive SHA256 mismatch");
  auto temporary = executable.parent_path() / (".coc-update-" + uuid());
  require(mkdir(temporary.c_str(), 0700) == 0, "Cannot create staging directory");
  auto prepared = std::make_unique<PreparedUpdate>(executable, temporary, std::move(lock),
                                                   before.st_dev, before.st_ino);
  prepared->release = release;
  write_file(temporary / "archive", bytes, 0600);
  auto binary = capture({"/bin/tar", "-xOzf", (temporary / "archive").string(), "--",
                         root + "/" + executable.filename().string()},
                        binary_limit);
  require(binary.size() >= 4 && binary.substr(0, 4) == std::string("\177ELF", 4),
          "Update must be a native ELF executable");
  write_file(temporary / "candidate", binary, before.st_mode & 0777);
  auto candidate = Json::parse(capture({(temporary / "candidate").string(), "--version"}, 16384));
  for (auto key : {"version", "commit", "sourceDigest", "protocol"})
    require(candidate.at(key) == release.at(key), "Candidate identity does not match release");
  require(candidate.at("target") == build.at("target") && candidate.at("dirty") == false,
          "Candidate target or clean-source identity is invalid");
  return prepared;
}
#else
std::filesystem::path executable_path() {
  std::wstring path(32768, L'\0');
  auto size = GetModuleFileNameW(nullptr, path.data(), DWORD(path.size()));
  require(size > 0 && size < path.size(), "Cannot locate Windows executable");
  path.resize(size);
  return std::filesystem::path(path);
}
PreparedUpdate::PreparedUpdate(std::filesystem::path executable, std::filesystem::path temporary,
                               std::unique_ptr<PrivateLock> lock, uint64_t device, uint64_t inode)
    : executable_(std::move(executable)), temporary_(std::move(temporary)), lock_(std::move(lock)),
      device_(device), inode_(inode) {}
PreparedUpdate::~PreparedUpdate() = default;
void PreparedUpdate::install() {
  throw Error("UPDATE_PLATFORM",
              "On Windows stop the Agent and replace the complete official ZIP distribution");
}
std::unique_ptr<PreparedUpdate> prepare_update(const Json &config, const std::string &,
                                               bool manual) {
  update_settings(config);
  if (manual)
    throw Error("UPDATE_PLATFORM", "Windows uses manual ZIP upgrades; stop the Agent, verify "
                                   "SHA256SUMS and replace the complete distribution");
  return nullptr;
}
void restart_updated(int, char **) {
  throw Error("UPDATE_PLATFORM", "Restart the Windows Agent manually after upgrading");
}
#endif
void automatic_update(const Json &config, const std::string &relay) {
  try {
    if (auto update = prepare_update(config, relay))
      update->install();
  } catch (const std::exception &error) {
    log_error(error);
  }
}
#ifndef _WIN32
void restart_updated(int, char **argv) {
  auto path = executable_path();
  // /proc/self/exe still refers to the old unlinked inode after rename.
  auto text = path.string();
  const std::string deleted = " (deleted)";
  if (text.size() > deleted.size() &&
      text.compare(text.size() - deleted.size(), deleted.size(), deleted) == 0)
    text.resize(text.size() - deleted.size());
  execv(text.c_str(), argv);
  const auto backup = text + ".previous";
  if (rename(backup.c_str(), text.c_str()) == 0)
    execv(text.c_str(), argv);
  throw Error("UPDATE_RESTART",
              "Cannot restart updated Agent; previous executable was retained when possible");
}
#endif
bool AgentUpdater::poll(const Json &config, const std::string &relay, bool idle) {
  const auto settings = update_settings(config);
  if (pending_.valid() && pending_.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
    try {
      ready_ = pending_.get();
      if (ready_)
        std::cerr << Json{{"event", "auto_update_ready"},
                          {"version", ready_->release.at("version")}}
                         .dump()
                  << '\n';
    } catch (const std::exception &error) {
      log_error(error);
    }
  }
  if (!settings.enabled) {
    ready_.reset();
    return false;
  }
  if (ready_)
    return idle;
  if (!pending_.valid() && now() >= next_) {
    next_ = now() + int64_t(settings.interval_hours) * 3600000;
    pending_ =
        std::async(std::launch::async, [config, relay] { return prepare_update(config, relay); });
  }
  return false;
}
bool AgentUpdater::install() {
  if (!ready_)
    return false;
  ready_->install();
  ready_.reset();
  return true;
}
} // namespace coc
