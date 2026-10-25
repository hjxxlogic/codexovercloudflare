#include "coc/build.hpp"
#include "coc/diagnostics.hpp"
#include "coc/login.hpp"
#include "coc/store.hpp"
#include "coc/update.hpp"
#include <algorithm>
#include <csignal>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <openssl/sha.h>
#include <sstream>
#include <sys/wait.h>
#include <unistd.h>
namespace coc {
class Cli {
  Options options_;
  std::filesystem::path credentials_;
  bool takeover_ = false;
  Json store() {
    if (!std::filesystem::exists(credentials_))
      return {{"version", 2}, {"entries", Json::array()}, {"selected", ""}, {"autoUpdate", true}};
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
    return http_json(relay_url(c.at("relay")), "/api/v1" + p, body, c.at("token"),
                     option("request-id"));
  }
  Json host() { return api("/hosts").at(0); }
  std::unique_ptr<Store> history_cache(const Json &credential) {
    auto identity = credential.at("relay").get<std::string>() + "\n" +
                    credential.at("hostId").get<std::string>() + "\n" +
                    credential.at("token").get<std::string>();
    unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char *>(identity.data()), identity.size(), digest);
    std::ostringstream scope;
    for (auto byte : digest)
      scope << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(byte);
    auto root = option("cache-dir", config_path("COC_HISTORY_DIR", "coc-client/history").string());
    return std::make_unique<Store>((std::filesystem::path(root) / scope.str()).string(), false);
  }
  int64_t cursor_option(const std::string &name) {
    auto text = option(name, "0");
    if (text.empty() ||
        text.find_first_not_of(name == "before" || name == "seq" ? "-0123456789" : "0123456789") !=
            std::string::npos ||
        text.size() > 17)
      throw Error("USAGE", "Invalid --" + name);
    size_t used = 0;
    auto n = std::stoll(text, &used);
    if (used != text.size())
      throw Error("USAGE", "Invalid --" + name);
    if (n > 9007199254740991LL || n < -9007199254740991LL)
      throw Error("USAGE", "Cursor exceeds safe integer range");
    return n;
  }
  void history(const std::string &id, bool clear = false) {
    if (id.empty() || id.find('~') == std::string::npos)
      throw Error("USAGE", "history <session-id> [--before SEQ] [--offline true]");
    auto c = load();
    if (id.substr(0, id.find('~')) != c.at("hostId"))
      throw Error("FORBIDDEN", "Session belongs to another host");
    auto cache = history_cache(c);
    if (clear) {
      cache->cache_clear();
      std::cout << "Local history cache cleared for selected credential and host\n";
      return;
    }
    Json request = {
        {"operation", "page"}, {"before", cursor_option("before")}, {"requestId", uuid()}};
    auto key = id + ":page:" + std::to_string(cursor_option("before"));
    if (!option("seq").empty()) {
      request = {{"operation", "content"},
                 {"seq", cursor_option("seq")},
                 {"offset", cursor_option("offset")},
                 {"requestId", uuid()}};
      auto versionKey = id + ":revision:" + option("seq");
      auto version = option("revision").empty() ? cache->cache_get(versionKey)
                                                : Json(cursor_option("revision"));
      if (version.is_null() && cursor_option("offset") != 0)
        throw Error("REVISION_REQUIRED", "Read offset zero first or specify --revision");
      if (!version.is_null())
        request["revision"] = version;
      key = id + ":content:" + option("seq") + ":" +
            (version.is_null() ? "initial" : version.dump()) + ":" +
            std::to_string(cursor_option("offset"));
    }
    if (option("offline") == "true") {
      auto value = cache->cache_get(key);
      if (value.is_null())
        throw Error("CACHE_MISS", "This page has not been cached on this computer");
      std::cout << value.dump(2) << '\n';
      return;
    }
    asio::io_context io;
    asio::steady_timer timeout(io);
    std::shared_ptr<Socket> socket;
    Json result, error;
    timeout.expires_after(std::chrono::seconds(20));
    timeout.async_wait([&](auto ec) {
      if (!ec) {
        error = {{"code", "TIMEOUT"}, {"message", "History request timed out"}};
        socket->close();
      }
    });
    socket = connect_socket(
        io, relay_url(c.at("relay")), c.at("token"),
        [&](Json d) {
          if (d.contains("receiptId"))
            socket->send({{"type", "receipt"}, {"receiptId", d["receiptId"]}});
          if (d.value("type", "") == "history-ready")
            socket->send(request);
          if (d.value("type", "") == "error") {
            error = d.at("error");
            timeout.cancel();
            socket->close();
          }
          if (d.value("type", "") == "history" &&
              d.value("requestId", "") == request["requestId"]) {
            result = d;
            if (request["operation"] == "content") {
              cache->cache_put(id + ":revision:" + option("seq"), d.at("revision"));
              key = id + ":content:" + option("seq") + ":" + d.at("revision").dump() + ":" +
                    std::to_string(cursor_option("offset"));
            }
            cache->cache_put(key, result);
            timeout.cancel();
            socket->close();
          }
        },
        [&](unsigned) { timeout.cancel(); }, "/ws/v1/history/" + id);
    socket->start();
    io.run();
    if (!error.is_null())
      throw Error(error.value("code", "HISTORY_ERROR"), error.value("message", "History failed"));
    if (result.is_null())
      throw Error("HOST_OFFLINE", "History unavailable; use --offline true for cached pages");
    std::cout << result.dump(2) << '\n';
  }
  void attach(const std::string &id) {
    if (id.empty())
      throw Error("USAGE", "attach <session-id>");
    auto c = load();
    verify_codex({{"codexPath", "codex"}, {"codexArgs", Json::array()}});
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
    asio::io_context history_io;
    std::unique_ptr<Store> cache;
    try {
      cache = history_cache(c);
    } catch (const std::exception &e) {
      std::cerr << "Local history cache unavailable: " << e.what() << '\n';
    }
    auto pageKey = id + ":page:0";
    auto tail = cache ? cache->cache_get(pageKey) : Json();
    if (tail.is_null())
      tail = {{"events", Json::array()}, {"more", false}, {"cursor", 0}};
    const auto persist_tail = [&] {
      auto &events = tail["events"];
      std::sort(events.begin(), events.end(),
                [](const Json &a, const Json &b) { return a["seq"] < b["seq"]; });
      size_t bytes = events.dump().size();
      while (events.size() > 1 && (events.size() > 200 || bytes > 96 * 1024)) {
        bytes -= events.front().dump().size();
        events.erase(events.begin());
        tail["more"] = true;
      }
      tail["cursor"] = events.empty() ? Json(0) : events.front()["seq"];
      if (cache) {
        try {
          cache->cache_put(pageKey, tail);
        } catch (const std::exception &error) {
          std::cerr << "History cache: " << error_data(error).dump() << '\n';
          cache.reset();
        }
      }
    };
    std::shared_ptr<Socket> reader;
    asio::steady_timer retry(history_io);
    bool finished = false;
    std::function<void()> reconnect = [&] {
      reader = connect_socket(
          history_io, u, c.at("token"),
          [&](Json d) {
            if (d.contains("receiptId"))
              reader->send({{"type", "receipt"}, {"receiptId", d["receiptId"]}});
            if (d.value("type", "") == "history-ready")
              reader->send({{"operation", "page"}, {"before", 0}, {"requestId", "initial"}});
            if (d.value("type", "") == "history" && d.contains("events")) {
              auto current = tail["events"];
              tail = d;
              for (auto &event : current) {
                bool found = false;
                for (auto &existing : tail["events"])
                  if (existing["seq"] == event["seq"]) {
                    if (event.value("revision", event["seq"].get<int64_t>()) >
                        existing.value("revision", existing["seq"].get<int64_t>()))
                      existing = event;
                    found = true;
                  }
                if (!found)
                  tail["events"].push_back(event);
              }
              persist_tail();
            }
            if (d.value("type", "") == "event") {
              auto &events = tail["events"];
              auto event = d.at("event");
              bool found = false;
              for (auto &e : events)
                if (e["seq"] == event["seq"]) {
                  if (event.value("revision", event["seq"].get<int64_t>()) >=
                      e.value("revision", e["seq"].get<int64_t>()))
                    e = event;
                  found = true;
                }
              if (!found)
                events.push_back(event);
              persist_tail();
            }
          },
          [&](unsigned code) {
            if (finished || code == 4001)
              return;
            retry.expires_after(std::chrono::seconds(3));
            retry.async_wait([&](auto error) {
              if (!error && !finished)
                reconnect();
            });
          },
          "/ws/v1/history/" + id);
      reader->start();
    };
    reconnect();
    int status;
    while (true) {
      auto done = waitpid(pid, &status, WNOHANG);
      if (done == pid)
        break;
      if (done < 0 && errno != EINTR)
        throw Error("SPAWN_FAILED", "Cannot wait for Codex TUI");
      history_io.restart();
      history_io.run_for(std::chrono::milliseconds(100));
      if (history_io.stopped())
        usleep(10000);
    }
    finished = true;
    retry.cancel();
    reader->close();
    history_io.restart();
    history_io.poll();
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
    if (options_.api_key && command != "login")
      throw Error("USAGE", "--api-key is only valid for login");
    if (options_.values.count("message") && (command != "login" || options_.api_key))
      throw Error("USAGE", "--message is only valid for paired login");
    auto settings = command != "help" && std::filesystem::exists(credentials_)
                        ? read_json(credentials_)
                        : Json::object();
    update_settings(settings);
    auto release_relay = [&] {
      if (!option("relay").empty())
        return option("relay");
      for (const auto &entry : settings.value("entries", Json::array()))
        if (key(entry) == settings.value("selected", ""))
          return entry.at("relay").get<std::string>();
      return std::string("https://r.xlogic.cc");
    };
    if (command == "update") {
      auto update = prepare_update(settings, release_relay(), true);
      if (update) {
        update->install();
        std::cout << update->release.dump(2) << '\n';
      } else
        std::cout << "Already up to date\n";
      return;
    }
    auto id = options_.args.size() > 1 ? options_.args[1] : "";
    std::unique_ptr<PrivateLock> config_lock;
    if (command == "login" || command == "logout" || command == "use")
      config_lock = std::make_unique<PrivateLock>(credentials_);
    if (command == "login") {
      if (options_.args.size() != 1)
        throw Error("USAGE", "Unexpected login argument");
      if (options_.api_key && !valid_id(option("host")))
        throw Error("USAGE", "API key login requires --host <A-ID>");
      store();
      auto result =
          device_login(option("relay", "https://r.xlogic.cc"), "cli", option("name", "CLI client"),
                       option("host"), options_.api_key, option("message"));
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
    } else if (command == "doctor") {
      auto result = doctor(load(), false);
      std::cout << result.dump(2) << '\n';
      if (result["ok"] != true)
        throw Error("DOCTOR_FAILED", "One or more diagnostic checks failed");
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
      std::cout << api("/sessions?paged=true&hostId=" + host().at("id").get<std::string>() +
                       "&cursor=" + option("cursor"))
                       .dump(2)
                << '\n';
    else if (command == "request") {
      if (!valid_id(id))
        throw Error("USAGE", "request <request-id> [--session SESSION]");
      std::cout << api("/hosts/" + load().at("hostId").get<std::string>() + "/requests/" + id +
                       (option("session").empty() ? "" : "?sessionId=" + option("session")))
                       .dump(2)
                << '\n';
    } else if (command == "connect") {
      auto h = host();
      if (option("project").empty())
        throw Error("USAGE", "Select --project <project-id>");
      auto request_id = option("request-id", uuid());
      if (!valid_id(request_id))
        throw Error("USAGE", "Invalid --request-id");
      auto credential = load();
      auto journal = history_cache(credential);
      journal->cache_put("create:" + request_id,
                         {{"projectId", option("project")}, {"requestId", request_id}});
      std::cerr << "Create request ID: " << request_id << "; query with coc-client request "
                << request_id << " if unconfirmed\n";
      auto s =
          http_json(relay_url(credential.at("relay")), "/api/v1/sessions",
                    {{"hostId", h.at("id")}, {"projectId", option("project")}, {"mode", "cli"}},
                    credential.at("token"), request_id);
      attach(s.at("id"));
    } else if (command == "history" || command == "cache-clear")
      history(id, command == "cache-clear");
    else if (command == "attach")
      attach(id);
    else if (command == "stop") {
      if (id.empty())
        throw Error("USAGE", "stop <session-id>");
      std::cout << api("/sessions/" + id + "/stop", Json::object()).dump(2) << '\n';
    } else {
      std::cout
          << "Usage: coc-client "
             "<login|logout|status|use|hosts|projects|sessions|connect|attach|stop|history|cache-"
             "clear|doctor|update> [options]\n"
             "Options: --relay URL --host ID --name NAME --message TEXT --project ID --config PATH "
             "--takeover "
             "--api-key --before SEQ --seq SEQ --offset N --revision N --cursor ID --request-id ID "
             "--session ID --offline true --cache-dir PATH\n"
             "login: send optional --message TEXT; --host ID explicitly targets that Agent "
             "for approval. Without --host the administrator selects the server. "
             "login --api-key: requires --host ID; read COC_API_KEY or prompt securely. "
             "logout only removes "
             "local credentials.\n";
      if (command != "help")
        throw Error("USAGE", "Unknown command");
    }
    if (command != "help" && command != "logout" && command != "doctor" &&
        option("offline") != "true") {
      try {
        if (std::filesystem::exists(credentials_))
          settings = read_json(credentials_);
        automatic_update(settings, release_relay());
      } catch (const std::exception &error) {
        std::cerr << Json{{"event", "auto_update_failed"}, {"error", error_data(error)}}.dump()
                  << '\n';
      }
    }
  }
};
} // namespace coc
int main(int argc, char **argv) {
  try {
    signal(SIGPIPE, SIG_IGN);
    if (argc == 2 && std::string(argv[1]) == "--version") {
      std::cout << COC_BUILD_JSON << '\n';
      return 0;
    }
    coc::Cli(argc, argv).run();
    return 0;
  } catch (const std::exception &e) {
    std::cerr << coc::error_data(e).dump() << '\n';
    return 1;
  }
}
