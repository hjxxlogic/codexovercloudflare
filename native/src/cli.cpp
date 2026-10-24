#include "coc/network.hpp"
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <map>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
namespace coc {
namespace {
termios saved_terminal{};
volatile sig_atomic_t restore_terminal = 0;
void input_signal(int signum) {
  if (restore_terminal)
    tcsetattr(STDIN_FILENO, TCSAFLUSH, &saved_terminal);
  _exit(128 + signum);
}
struct HiddenInput {
  bool active = false;
  struct sigaction old_int {
  }, old_term{};
  HiddenInput() {
    if (!isatty(STDIN_FILENO))
      return;
    if (tcgetattr(STDIN_FILENO, &saved_terminal) != 0)
      throw Error("INPUT_ERROR", "Cannot read terminal settings");
    auto hidden = saved_terminal;
    hidden.c_lflag &= ~ECHO;
    struct sigaction action {};
    action.sa_handler = input_signal;
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, &old_int);
    sigaction(SIGTERM, &action, &old_term);
    restore_terminal = 1;
    if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &hidden) != 0) {
      restore_terminal = 0;
      sigaction(SIGINT, &old_int, nullptr);
      sigaction(SIGTERM, &old_term, nullptr);
      throw Error("INPUT_ERROR", "Cannot hide input");
    }
    active = true;
  }
  ~HiddenInput() {
    if (active) {
      tcsetattr(STDIN_FILENO, TCSAFLUSH, &saved_terminal);
      restore_terminal = 0;
      sigaction(SIGINT, &old_int, nullptr);
      sigaction(SIGTERM, &old_term, nullptr);
    }
  }
};
} // namespace

std::string secret(const char *prompt) {
  std::cerr << prompt;
  std::string s;
  {
    HiddenInput input;
    std::getline(std::cin, s);
  }
  std::cerr << '\n';
  if (!std::cin)
    throw Error("INPUT_ERROR", "No input received");
  auto a = s.find_first_not_of(" \r\n\t");
  return a == std::string::npos ? "" : s.substr(a, s.find_last_not_of(" \r\n\t") - a + 1);
}
class Cli {
  std::map<std::string, std::string> options_;
  std::vector<std::string> args_;
  std::filesystem::path credentials_;
  bool takeover_ = false;
  Json load() {
    if (!std::filesystem::exists(credentials_))
      throw Error("LOGIN_REQUIRED", "Login first: coc login");
    return read_json(credentials_);
  }
  std::string option(const std::string &k, const std::string &fallback = "") {
    auto i = options_.find(k);
    return i == options_.end() ? fallback : i->second;
  }
  Json api(const std::string &p, const Json &body = nullptr, bool anonymous = false) {
    auto c =
        anonymous ? Json{{"relay", option("relay", "https://r.xlogic.cc")}, {"token", ""}} : load();
    return http_json(relay_url(c.at("relay")), "/api/v1" + p, body, c.at("token"));
  }
  Json host() {
    for (auto &h : api("/hosts"))
      if (h["id"] == option("host") || h["name"] == option("host"))
        return h;
    throw Error("HOST_REQUIRED", "Select a known host with --host");
  }
  void attach(const std::string &id) {
    if (id.empty())
      throw Error("USAGE", "attach <session-id>");
    auto c = load();
    auto u = relay_url(c.at("relay"));
    auto t = api("/sessions/" + id + (takeover_ ? "/takeover" : "/attach"), Json::object());
    if (t["mode"] != "cli")
      throw Error("WRONG_MODE", "Use the browser for a web session");
    std::cout << "Remote session: " << id << '\n' << std::flush;
    auto url = std::string(u.tls ? "wss://" : "ws://") + u.authority + "/ws/v1/cli/" + id;
    std::vector<std::string> args = {"codex",
                                     "--remote",
                                     url,
                                     "--remote-auth-token-env",
                                     "COC_REMOTE_TICKET",
                                     "--sandbox",
                                     t.value("sandbox", "workspace-write"),
                                     "--ask-for-approval",
                                     "on-request"};
    std::vector<char *> argv;
    for (auto &a : args)
      argv.push_back(a.data());
    argv.push_back(nullptr);
    auto token = t.at("ticket").get<std::string>();
    pid_t pid = fork();
    if (pid < 0)
      throw Error("SPAWN_FAILED", "Cannot start Codex TUI");
    if (pid == 0) {
      setenv("COC_REMOTE_TICKET", token.c_str(), 1);
      execvp(argv[0], argv.data());
      _exit(127);
    }
    int status;
    while (waitpid(pid, &status, 0) < 0) {
      if (errno != EINTR)
        throw Error("SPAWN_FAILED", "Cannot wait for Codex TUI");
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
      throw Error("CODEX_EXITED", "Codex TUI exited unsuccessfully");
  }

public:
  Cli(int argc, char **argv) {
    for (int i = 1; i < argc; ++i) {
      std::string a = argv[i];
      if (a == "--takeover")
        takeover_ = true;
      else if (a.rfind("--", 0) == 0) {
        auto k = a.substr(2);
        if (k == "help") {
          args_ = {"help"};
          break;
        }
        if (k != "relay" && k != "host" && k != "project" && k != "project-id" && k != "config")
          throw Error("USAGE", "Unknown option: " + a);
        if (++i >= argc)
          throw Error("USAGE", "Missing option value: " + a);
        options_[k] = argv[i];
      } else
        args_.push_back(a);
    }
    auto env = getenv("COC_CREDENTIALS");
    if (env)
      credentials_ = env;
    else {
      auto home = getenv("HOME");
      if (!home)
        throw Error("CONFIG_ERROR", "HOME or COC_CREDENTIALS must be set");
      credentials_ = std::filesystem::path(home) / ".config/coc/credentials.json";
    }
  }
  void run() {
    auto command = args_.empty() ? "help" : args_[0];
    auto id = args_.size() > 1 ? args_[1] : "";
    if (command == "login") {
      auto relay = relay_url(option("relay", "https://r.xlogic.cc")).origin;
      auto r = api("/auth/login", {{"secret", secret("Owner secret: ")}, {"kind", "cli"}}, true);
      r["relay"] = relay;
      save_private(credentials_, r);
      std::cout << "Logged in to " << relay << '\n';
    } else if (command == "logout") {
      api("/auth/logout", Json::object());
      std::filesystem::remove(credentials_);
      std::cout << "Logged out\n";
    } else if (command == "agent-enroll") {
      if (option("config").empty() || option("project").empty())
        throw Error(
            "USAGE",
            "agent-enroll --config <path> --project <remote-directory> [--project-id name]");
      auto file = std::filesystem::absolute(option("config"));
      if (std::filesystem::exists(file))
        throw Error("CONFIG_ERROR", "Config already exists; refusing to overwrite");
      auto path = std::filesystem::canonical(option("project"));
      if (!std::filesystem::is_directory(path))
        throw Error("CONFIG_ERROR", "Project must be a directory");
      auto project_id = option("project-id", "my-project");
      if (!valid_id(project_id))
        throw Error("CONFIG_ERROR", "Invalid project ID");
      auto relay = relay_url(option("relay", "https://r.xlogic.cc")).origin;
      auto d = api("/agent/enroll", {{"code", secret("Enrollment code: ")}}, true);
      Json c = {
          {"relayUrl", relay},
          {"hostId", d.at("hostId")},
          {"token", d.at("token")},
          {"codexPath", "codex"},
          {"codexArgs", Json::array()},
          {"sandbox", "workspace-write"},
          {"dataDir", (file.parent_path() / "data").string()},
          {"projects",
           Json::array({{{"id", project_id}, {"name", project_id}, {"path", path.string()}}})}};
      save_private(file, c, true);
      std::cout << "Agent config written to " << file.string() << '\n';
    } else if (command == "enroll") {
      if (id.empty())
        throw Error("USAGE", "enroll <host-name>");
      std::cout << api("/hosts/enrollments", {{"name", id}}).dump(2) << '\n';
    } else if (command == "hosts")
      std::cout << api("/hosts").dump(2) << '\n';
    else if (command == "projects")
      std::cout << api("/hosts/" + host().at("id").get<std::string>() + "/projects").dump(2)
                << '\n';
    else if (command == "sessions")
      std::cout << api("/sessions?hostId=" + host().at("id").get<std::string>()).dump(2) << '\n';
    else if (command == "connect") {
      auto h = host();
      if (option("project").empty())
        throw Error("USAGE", "Select --project <project-id>");
      auto s = api("/sessions",
                   {{"hostId", h.at("id")}, {"projectId", option("project")}, {"mode", "cli"}});
      attach(s.at("id"));
    } else if (command == "attach")
      attach(id);
    else if (command == "stop") {
      if (id.empty())
        throw Error("USAGE", "stop <session-id>");
      std::cout << api("/sessions/" + id + "/stop", Json::object()).dump(2) << '\n';
    } else if (command == "revoke")
      std::cout
          << api("/hosts/" + host().at("id").get<std::string>() + "/revoke", Json::object()).dump(2)
          << '\n';
    else {
      std::cout << "Usage: coc "
                   "<login|logout|hosts|enroll|agent-enroll|projects|sessions|connect|attach|stop|"
                   "revoke> [options]\nOptions: --relay URL --host ID --project ID --config PATH "
                   "--project-id ID --takeover\nDefault relay: https://r.xlogic.cc\n";
      if (command != "help")
        throw Error("USAGE", "Unknown command");
    }
  }
};
} // namespace coc
int main(int argc, char **argv) {
  try {
    signal(SIGPIPE, SIG_IGN);
    coc::Cli(argc, argv).run();
    return 0;
  } catch (const std::exception &e) {
    std::cerr << coc::error_data(e).dump() << '\n';
    return 1;
  }
}
