#include "coc/access.hpp"
#include "coc/build.hpp"
#include "coc/diagnostics.hpp"
#include "coc/login.hpp"
#include "coc/proxy.hpp"
#include "coc/store.hpp"
#include "coc/tui_bridge.hpp"
#include "coc/update.hpp"
#include <algorithm>
#include <csignal>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <openssl/sha.h>
#include <sstream>
#ifndef _WIN32
#include <sys/wait.h>
#include <unistd.h>
#else
#include "coc/windows.hpp"
#endif
#include <thread>
namespace coc {
class Cli {
  Options options_;
  std::filesystem::path credentials_;
  bool takeover_ = false;
  Json store() {
    if (!std::filesystem::exists(credentials_))
      return {{"version", 2},
              {"entries", Json::array()},
              {"selected", ""},
              {"autoUpdate", coc::UpdateSettings{}.enabled}};
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
  Json api(const std::string &p, const Json &body = nullptr, const std::string &request_id = "") {
    const auto c = load();
    const auto id = request_id.empty() ? option("request-id", uuid()) : request_id;
    try {
      return http_json(relay_url(c.at("relay")), "/api/v1" + p, body, c.at("token"), id);
    } catch (const Error &e) {
      if (e.code != "HOST_OFFLINE")
        throw;
      wait_for_host(c);
      return http_json(relay_url(c.at("relay")), "/api/v1" + p, body, c.at("token"), id);
    }
  }
  Json wake(const Json &c) {
    return http_json(relay_url(c.at("relay")),
                     "/api/v1/hosts/" + c.at("hostId").get<std::string>() + "/wake", Json::object(),
                     c.at("token"));
  }
  Json wait_for_host(const Json &c) {
    auto status = [&] {
      return http_json(relay_url(c.at("relay")), "/api/v1/hosts", nullptr, c.at("token")).at(0);
    };
    auto h = status();
    if (h.value("online", false))
      return h;
    if (!h.value("wakeConfigured", false) || wake(c).value("state", "") == "unconfigured")
      throw Error("HOST_OFFLINE", "Host offline; no wake URL configured");
    std::cerr << "Host offline; wake requested, waiting up to 60 seconds...\n";
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
    while (std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::seconds(10));
      h = status();
      if (h.value("online", false))
        return h;
    }
    throw Error("HOST_OFFLINE", "Wake requested but host is still offline; retry later");
  }
  Json host() { return wait_for_host(load()); }
  std::unique_ptr<Store> history_cache(const Json &credential) {
    auto identity = credential.at("relay").get<std::string>() + "\n" +
                    credential.at("hostId").get<std::string>() + "\n" +
                    credential.at("token").get<std::string>();
    unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char *>(identity.data()), identity.size(), digest);
    std::ostringstream scope;
    for (auto byte : digest)
      scope << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(byte);
    auto root =
        option("cache-dir", config_path("COC_HISTORY_DIR", "coc-client/history").u8string());
    return std::make_unique<Store>((std::filesystem::u8path(root) / scope.str()).u8string(), false);
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
    wait_for_host(c);
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
    asio::io_context history_io;
    asio::steady_timer demand_refresh(history_io);
    bool refresh_enabled = true;
    std::function<void()> recover_reader = [] {};
    std::function<void()> refresh_state;
    refresh_state = [&] {
      if (!refresh_enabled)
        return;
      demand_refresh.expires_after(std::chrono::seconds(10));
      demand_refresh.async_wait([&](auto ec) {
        if (ec || !refresh_enabled)
          return;
        recover_reader();
        refresh_state();
      });
    };
    refresh_state();
    std::unique_ptr<TuiBridge> bridge;
    auto url = remote_address(u, "/ws/v1/cli/" + id);
    if (proxy_enabled() || access_enabled(u)) {
      bridge = std::make_unique<TuiBridge>(history_io, u, t.at("ticket"), "/ws/v1/cli/" + id);
      url = bridge->url();
    }
    std::vector<std::string> args = {"codex",
                                     "--remote",
                                     url,
                                     "--remote-auth-token-env",
                                     "COC_REMOTE_TICKET",
                                     "--sandbox",
                                     t.value("sandbox", "workspace-write"),
                                     "--ask-for-approval",
                                     "on-request"};
#ifndef _WIN32
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
#else
    WindowsChild child(args, "", false, t.at("ticket").get<std::string>());
#endif
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
    bool finished = false, reconnect_reader = false, history_pending = false, history_ready = false;
    int64_t history_requested = 0;
    int64_t received_revision = tail.value("receivedRevision", int64_t(-1)), maximum_revision = 0;
    std::function<void()> read_history = [&] {
      if (!history_ready || history_pending || finished)
        return;
      history_pending = true;
      history_requested = now();
      Json command = {{"operation", "page"}, {"requestId", uuid()}};
      command[received_revision < 0 ? "before" : "after"] =
          received_revision < 0 ? 0 : received_revision;
      reader->send(command);
    };
    std::function<void()> reconnect = [&] {
      reader = connect_socket(
          history_io, u, c.at("token"),
          [&](Json d) {
            if (d.contains("receiptId"))
              reader->send({{"type", "receipt"}, {"receiptId", d["receiptId"]}});
            if (d.value("type", "") == "history-ready") {
              history_ready = true;
              read_history();
            }
            if (d.value("type", "") == "history" || d.value("type", "") == "error")
              history_pending = false;
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
              maximum_revision = std::max(maximum_revision, d.value("snapshotSeq", int64_t(0)));
              const bool more = d.value("direction", "before") == "after" && d.value("more", false);
              received_revision =
                  std::max(received_revision, more ? d.value("cursor", int64_t(0))
                                                   : d.value("snapshotSeq", int64_t(0)));
              tail["receivedRevision"] = received_revision;
              persist_tail();
              if (more || maximum_revision > received_revision)
                read_history();
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
              if (d.contains("maxRevision") && d["maxRevision"].is_number_integer()) {
                const auto maximum = d["maxRevision"].get<int64_t>();
                maximum_revision = std::max(maximum_revision, maximum);
                if (received_revision >= 0 &&
                    d.value("previousRevision", int64_t(-1)) == received_revision)
                  received_revision = std::max(received_revision, maximum);
              }
              tail["receivedRevision"] = received_revision;
              persist_tail();
              if (received_revision >= 0 && maximum_revision > received_revision)
                read_history();
            }
          },
          [&](unsigned code) {
            if (code == 4001) {
              finished = true;
              refresh_enabled = false;
              demand_refresh.cancel();
              return;
            }
            if (finished)
              return;
            history_ready = false;
            history_pending = false;
            reconnect_reader = true;
          },
          "/ws/v1/history/" + id);
      reader->start();
    };
    recover_reader = [&] {
      if (finished)
        return;
      if (history_pending && now() - history_requested >= 20000) {
        std::cerr
            << "RESULT_UNKNOWN: history refresh unconfirmed; reconnecting read-only transport\n";
        reader->close();
        return;
      }
      if (reconnect_reader) {
        reconnect_reader = false;
        reconnect();
      } else if (history_ready && !history_pending) {
        read_history();
      }
    };
    reconnect();
#ifdef _WIN32
    DWORD status = 0;
#else
    int status;
#endif
    while (true) {
#ifdef _WIN32
      if (child.poll(status))
        break;
#else
      auto done = waitpid(pid, &status, WNOHANG);
      if (done == pid)
        break;
      if (done < 0 && errno != EINTR)
        throw Error("SPAWN_FAILED", "Cannot wait for Codex TUI");
#endif
      history_io.restart();
      history_io.run_for(std::chrono::milliseconds(100));
      if (history_io.stopped())
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    finished = true;
    refresh_enabled = false;
    demand_refresh.cancel();
    reader->close();
    bridge.reset();
    history_io.restart();
    history_io.poll();
#ifdef _WIN32
    if (status != 0)
#else
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
#endif
      throw Error("CODEX_EXITED", "Codex TUI exited unsuccessfully");
  }

public:
  Cli(int argc, char **argv)
      : options_(argc, argv),
        credentials_(std::filesystem::u8path(option(
            "config", config_path("COC_CREDENTIALS", "coc-client/credentials.json").u8string()))),
        takeover_(options_.takeover) {}
  void run() {
    auto command = options_.args.empty() ? "help" : options_.args[0];
    if (options_.api_key && command != "login")
      throw Error("USAGE", "--api-key is only valid for login");
    if (options_.values.count("message") &&
        ((command != "login" && command != "queue") || options_.api_key))
      throw Error("USAGE", "--message is only valid for paired login or queue");
    auto settings = command != "help" && std::filesystem::exists(credentials_)
                        ? read_json(credentials_)
                        : Json::object();
    configure_proxy(command == "proxy" ? "" : option("proxy", settings.value("proxy", "")));
    const auto access_file =
        configure_access(option("access-config", settings.value("cloudflareAccessFile", "")));
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
    if (command == "login" || command == "logout" || command == "use" || command == "name" ||
        command == "proxy")
      config_lock = std::make_unique<PrivateLock>(credentials_);
    if (command == "proxy") {
      if (options_.args.size() != 2)
        throw Error("USAGE", "proxy URL (empty URL disables proxy)");
      configure_proxy(id);
      auto data = store();
      data["proxy"] = id;
      save_private(credentials_, data);
      std::cout << "Proxy configuration saved\n";
      return;
    }
    if (command == "name") {
      if (options_.args.size() != 2)
        throw Error("USAGE", "name DISPLAY_NAME");
      auto name = display_name(id);
      auto data = store();
      // Update every authorization belonging to this client instance.
      for (auto &entry : data["entries"]) {
        http_json(relay_url(entry.at("relay")), "/api/v1/instance/name", {{"displayName", name}},
                  entry.at("token"));
        entry["displayName"] = name;
      }
      data["displayName"] = name;
      save_private(credentials_, data);
      std::cout << "Client name: " << name << '\n';
      return;
    }
    if (command == "login") {
      if (options_.args.size() != 1)
        throw Error("USAGE", "Unexpected login argument");
      if (options_.api_key && !valid_id(option("host")))
        throw Error("USAGE", "API key login requires --host <A-ID>");
      store();
      const auto name =
          display_name(option("name", settings.value("displayName", asio::ip::host_name())));
      auto result = device_login(option("relay", "https://r.xlogic.cc"), "cli", name,
                                 option("host"), options_.api_key, option("message"));
      auto hosts = credential_status(result);
      result["name"] = hosts.at(0).at("name");
      result["displayName"] = name;
      auto data = store();
      data["displayName"] = name;
      data["proxy"] = option("proxy", settings.value("proxy", ""));
      if (!access_file.empty())
        data["cloudflareAccessFile"] = access_file;
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
    } else if (command == "status") {
      auto c = load();
      auto hosts = credential_status(c);
      for (auto &h : hosts) {
        h["clientDisplayName"] =
            settings.value("displayName", c.value("displayName", "CLI client"));
        if (!h.value("online", false) && h.value("wakeConfigured", false))
          h["wake"] = wake(c);
      }
      std::cout << hosts.dump(2) << '\n';
    } else if (command == "hosts") {
      Json hosts = Json::array();
      const auto data = store();
      for (const auto &entry : data.at("entries")) {
        try {
          for (const auto &host : credential_status(entry)) {
            auto h = host;
            if (!h.value("online", false) && h.value("wakeConfigured", false))
              h["wake"] = wake(entry);
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
    else if (command == "threads") {
      if (!valid_id(option("project")))
        throw Error("USAGE", "threads --project ID");
      std::cout << api("/hosts/" + host().at("id").get<std::string>() +
                       "/threads?projectId=" + option("project"))
                       .dump(2)
                << '\n';
    } else if (command == "observe") {
      if (!valid_id(id) || !valid_id(option("project")))
        throw Error("USAGE", "observe THREAD_ID --project ID");
      std::cout << api("/sessions", {{"hostId", host().at("id")},
                                     {"projectId", option("project")},
                                     {"mode", "cli"},
                                     {"threadId", id},
                                     {"external", true}})
                       .dump(2)
                << '\n';
    } else if (command == "approvals") {
      std::cout << api("/sessions/" + id + "/approvals").dump(2) << '\n';
    } else if (command == "approve" || command == "reject") {
      if (id.empty() || option("approval-id").empty())
        throw Error("USAGE", "approve|reject SESSION_ID --approval-id ID [--request-id ID]");
      const auto request_id = option("request-id", uuid());
      if (!valid_id(request_id))
        throw Error("USAGE", "Invalid --request-id");
      std::cerr << "Approval request ID: " << request_id << "; query its status before retrying\n";
      std::cout << api("/sessions/" + id + "/approval",
                       {{"approvalId", option("approval-id")}, {"allow", command == "approve"}},
                       request_id)
                       .dump(2)
                << '\n';
    } else if (command == "queue") {
      if (id.empty() || option("message").empty())
        throw Error("USAGE", "queue SESSION_ID --message TEXT [--request-id ID]");
      const auto request_id = option("request-id", uuid());
      if (!valid_id(request_id))
        throw Error("USAGE", "Invalid --request-id");
      std::cerr << "Queue request ID: " << request_id << "; query with coc-client request "
                << request_id << " --session " << id << " if unconfirmed\n";
      std::cout
          << api("/sessions/" + id + "/queue", {{"text", option("message")}}, request_id).dump(2)
          << '\n';
    } else if (command == "sessions")
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
      auto s = api("/sessions",
                   {{"hostId", h.at("id")}, {"projectId", option("project")}, {"mode", "cli"}},
                   request_id);
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
             "<login|logout|name|proxy|status|use|hosts|projects|threads|observe|queue|approvals|"
             "approve|"
             "reject|sessions|connect|"
             "attach|stop|history|cache-"
             "clear|doctor|update> [options]\n"
             "Options: --proxy URL --access-config FILE --relay URL --host ID --name NAME "
             "--message TEXT --project ID "
             "--config PATH "
             "--takeover "
             "--api-key --before SEQ --seq SEQ --offset N --revision N --cursor ID --request-id ID "
             "--session ID --offline true --cache-dir PATH\n"
             "login: send optional --message TEXT; --host ID explicitly targets that Agent "
             "for approval. Without --host the administrator selects the server. "
             "login --api-key: requires --host ID; read COC_API_KEY or prompt securely. "
             "External sessions: observe THREAD_ID --project ID; history SESSION_ID; queue "
             "SESSION_ID --message TEXT. "
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
int coc_main(int argc, char **argv) {
  try {
#ifdef _WIN32
    coc::windows_console();
#else
    signal(SIGPIPE, SIG_IGN);
#endif
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

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
  std::vector<std::string> values;
  for (int i = 0; i < argc; ++i)
    values.push_back(coc::utf8(argv[i]));
  std::vector<char *> arguments;
  for (auto &value : values)
    arguments.push_back(value.data());
  arguments.push_back(nullptr);
  return coc_main(argc, arguments.data());
}
#else
int main(int argc, char **argv) { return coc_main(argc, argv); }
#endif
