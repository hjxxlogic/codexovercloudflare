#include "coc/login.hpp"
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <sys/wait.h>
#include <unistd.h>
namespace coc {
class Cli {
  Options options_;
  std::filesystem::path credentials_;
  bool takeover_ = false;
  Json store() {
    if (!std::filesystem::exists(credentials_))
      return {{"version", 2}, {"entries", Json::array()}, {"selected", ""}};
    auto data = read_json(credentials_);
    if (data.value("version", 0) != 2)
      throw Error("LOGIN_REQUIRED",
                  "Old credentials unsupported; use a new credential file and coc-client login");
    return data;
  }
  std::string key(const Json &entry) {
    return entry.at("relay").get<std::string>() + "~" + entry.at("hostId").get<std::string>();
  }
  Json load() {
    auto data = store();
    Json matches = Json::array();
    for (const auto &entry : data.at("entries")) {
      if (!option("relay").empty() && entry.at("relay") != relay_url(option("relay")).origin)
        continue;
      if (!option("host").empty()) {
        if (entry.at("hostId") == option("host") || entry.at("name") == option("host"))
          matches.push_back(entry);
      } else if (key(entry) == data.value("selected", ""))
        matches.push_back(entry);
    }
    if (matches.size() != 1)
      throw Error("HOST_REQUIRED",
                  "Select one authorized host using --host (and --relay if ambiguous)");
    return matches[0];
  }
  std::string option(const std::string &k, const std::string &fallback = "") {
    return options_.get(k, fallback);
  }
  Json api(const std::string &p, const Json &body = nullptr) {
    const auto c = load();
    return http_json(relay_url(c.at("relay")), "/api/v1" + p, body, c.at("token"));
  }
  Json host() { return api("/hosts").at(0); }
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
  Cli(int argc, char **argv)
      : options_(argc, argv),
        credentials_(option(
            "config", config_path("COC_CREDENTIALS", "coc-client/credentials.json").string())),
        takeover_(options_.takeover) {}
  void run() {
    auto command = options_.args.empty() ? "help" : options_.args[0];
    auto id = options_.args.size() > 1 ? options_.args[1] : "";
    if (command == "login") {
      if (!valid_id(option("host")))
        throw Error("USAGE", "login requires --host <A-ID>");
      store();
      auto result = device_login(option("relay", "https://r.xlogic.cc"), "cli",
                                 option("name", "CLI client"), option("host"));
      auto hosts = credential_status(result);
      result["name"] = hosts.at(0).at("name");
      auto data = store();
      auto &entries = data["entries"];
      for (auto it = entries.begin(); it != entries.end();) {
        if (key(*it) == key(result))
          it = entries.erase(it);
        else
          ++it;
      }
      entries.push_back(result);
      data["selected"] = key(result);
      save_private(credentials_, data);
      std::cout << "Logged in to host " << result.at("hostId") << '\n';
    } else if (command == "logout") {
      auto entry = load(), data = store();
      auto &entries = data["entries"];
      for (auto it = entries.begin(); it != entries.end();) {
        if (key(*it) == key(entry))
          it = entries.erase(it);
        else
          ++it;
      }
      if (data["selected"] == key(entry))
        data["selected"] = entries.empty() ? "" : key(entries[0]);
      save_private(credentials_, data);
      std::cout << "Local credential removed; relay authorization is unchanged\n";
    } else if (command == "use") {
      if (option("host").empty())
        throw Error("USAGE", "use --host <A-ID>");
      auto entry = load(), data = store();
      data["selected"] = key(entry);
      save_private(credentials_, data);
      std::cout << "Selected " << entry.at("hostId") << '\n';
    } else if (command == "status")
      std::cout << credential_status(load()).dump(2) << '\n';
    else if (command == "hosts") {
      Json hosts = Json::array();
      const auto data = store();
      for (const auto &entry : data.at("entries")) {
        try {
          for (const auto &host : credential_status(entry)) {
            auto h = host;
            h["relay"] = entry.at("relay");
            hosts.push_back(h);
          }
        } catch (const std::exception &e) {
          hosts.push_back(
              {{"id", entry.at("hostId")}, {"relay", entry.at("relay")}, {"error", error_data(e)}});
        }
      }
      std::cout << hosts.dump(2) << '\n';
    } else if (command == "projects")
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
    } else {
      std::cout
          << "Usage: coc-client "
             "<login|logout|status|use|hosts|projects|sessions|connect|attach|stop> [options]\n"
             "Options: --relay URL --host ID --name NAME --project ID --config PATH --takeover\n"
             "login: approve the displayed request in the management website. logout only removes "
             "local credentials.\n";
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
