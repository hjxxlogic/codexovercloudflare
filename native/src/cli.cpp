#include "coc/access.hpp"
#include "coc/build.hpp"
#include "coc/diagnostics.hpp"
#include "coc/history_subscription.hpp"
#include "coc/login.hpp"
#include "coc/projects.hpp"
#include "coc/proxy.hpp"
#include "coc/recovery.hpp"
#include "coc/remote_config.hpp"
#include "coc/startup_repair.hpp"
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
  std::unique_ptr<ClientManagement> management_;
  void start_management(const Json &credential) {
    if (!management_ && option("offline") != "true")
      management_ = std::make_unique<ClientManagement>(credentials_, credential);
  }
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
    start_management(c);
    const auto id = request_id.empty() ? body.is_object() && body.contains("requestId")
                                             ? body.at("requestId").get<std::string>()
                                             : option("request-id", uuid())
                                       : request_id;
    const bool original_write =
        !body.is_null() &&
        (p == "/sessions" ||
         (p.rfind("/sessions/", 0) == 0 &&
          ((p.size() >= 5 && p.substr(p.size() - 5) == "/stop") ||
           (p.size() >= 6 && p.substr(p.size() - 6) == "/queue") ||
           (p.size() >= 9 && p.substr(p.size() - 9) == "/approval"))) ||
         (p.find("/project-management") != std::string::npos &&
          body.value("operation", "list") != "list" && body.value("operation", "") != "browse"));
    if (original_write)
      return original_api(c, p, body, id);
    bool woke = false;
    for (unsigned attempt = 0;;) {
      try {
        return http_json(relay_url(c.at("relay")), "/api/v1" + p, body, c.at("token"), id);
      } catch (const Error &e) {
        if (e.code == "HOST_OFFLINE" && !woke) {
          wait_for_host(c);
          woke = true;
          continue;
        }
        if ((body.is_null() || p.find("/probe") != std::string::npos) &&
            e.code == "RESULT_UNKNOWN" && attempt < 2) {
          std::this_thread::sleep_for(std::chrono::milliseconds(500 << attempt++));
          continue;
        }
        throw;
      }
    }
  }
  Json original_api(const Json &credential, const std::string &path, const Json &body,
                    const std::string &request) {
    auto journal = history_cache(credential);
    auto record = journal->local_operation(request);
    if (record.is_null()) {
      const auto probe =
          api("/hosts/" + credential.at("hostId").get<std::string>() + "/probe", Json::object());
      if (!probe.contains("operationInstance") || !probe.at("operationInstance").is_string())
        throw Error("UPGRADE_REQUIRED",
                    "Agent must provide its persistent original-operation instance");
      record = journal->local_operation_prepare(request, path, body, probe.at("operationInstance"));
    } else
      record = journal->local_operation_prepare(request, path, body, record.at("instance"));
    const auto url = relay_url(credential.at("relay"));
    const auto token = credential.at("token").get<std::string>();
    const auto instance = record.at("instance").get<std::string>();
    bool woke = false;
    std::cerr << "Original operation: " << request << "; recover with coc-client request "
              << request << '\n';
    for (unsigned attempt = 0; record.at("state") == "pending";
         attempt = std::min(3U, attempt + 1)) {
      HttpIntent intent{instance, false, [&](const Json &envelope, const Json &receipt) {
                          journal->local_operation_finish(request, envelope, receipt);
                        }};
      try {
        http_json(url, "/api/v1" + path, body, token, request, std::chrono::seconds(30), &intent);
      } catch (const Error &error) {
        if (error.code == "REQUEST_EXPIRED") {
          journal->local_operation_expire(request);
          throw;
        }
        record = journal->local_operation(request);
        if (record.at("state") != "pending")
          break;
        if (!retry_original_operation(error.code))
          throw;
        if (error.code == "HOST_OFFLINE" && !woke) {
          woke = true;
          wait_for_host(credential);
          continue;
        }
        const auto delay = recovery_delay(attempt);
        std::cerr << "Waiting to recover original operation " << request << " (" << error.code
                  << "); retry in " << delay << " ms\n";
        std::this_thread::sleep_for(std::chrono::milliseconds(delay));
        continue;
      }
      record = journal->local_operation(request);
      if (record.at("state") == "pending")
        throw Error("RESULT_UNKNOWN", "Original response did not commit a durable result");
    }
    if (!record.contains("result"))
      throw Error("RESULT_UNAVAILABLE", "Confirmed original result was retired locally");
    const auto terminal = record.at("result");
    if (record.at("state") == "completed") {
      HttpIntent confirmation{
          instance, true, [&](const Json &envelope, const Json &receipt) {
            if (!envelope.contains("data") || !envelope.at("data").value("confirmed", false) ||
                receipt.at("owner") != record.at("receipt").at("owner"))
              throw Error("DELIVERY_STATE_MISMATCH", "Invalid original result confirmation");
            journal->local_operation_confirm(request);
          }};
      for (unsigned attempt = 0;; attempt = std::min(3U, attempt + 1)) {
        try {
          http_json(url, "/api/v1" + path, body, token, request, std::chrono::seconds(30),
                    &confirmation);
          break;
        } catch (const Error &error) {
          if (error.code == "REQUEST_EXPIRED") {
            journal->local_operation_expire(request);
            std::cerr << "Agent confirmation expired; the original result remains saved locally\n";
            break;
          }
          if (journal->local_operation(request).at("state") == "confirmed")
            break;
          if (!retry_original_operation(error.code))
            throw;
          if (error.code == "HOST_OFFLINE" && !woke) {
            woke = true;
            wait_for_host(credential);
            continue;
          }
          const auto delay = recovery_delay(attempt);
          std::cerr << "Original result saved locally; waiting to confirm " << request << " ("
                    << error.code << "); retry in " << delay << " ms\n";
          std::this_thread::sleep_for(std::chrono::milliseconds(delay));
        }
      }
    }
    if (terminal.contains("error"))
      throw Error(terminal.at("error").value("code", "RESULT_UNKNOWN"),
                  terminal.at("error").value("message", "Original operation failed"));
    return terminal.at("data");
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
    return std::make_unique<Store>((std::filesystem::u8path(root) / "transport-v3").u8string(),
                                   false, scope.str() + ":");
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
    Json request = {{"operation", "page"},
                    {"historyVersion", 2},
                    {"before", cursor_option("before")},
                    {"requestId", uuid()}};
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
      const auto reference = cache->cache_get(id + ":reference:" + option("seq"));
      if (!reference.is_null() && (version.is_null() || reference.at("revision") == version))
        request["reference"] = reference;
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
    start_management(c);
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
            } else {
              for (const auto &event : d.value("events", Json::array()))
                if (event.contains("contentReference"))
                  cache->cache_put(id + ":reference:" + event.at("seq").dump(),
                                   event.at("contentReference"));
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
  void attach(const std::string &id, bool &starting) {
    if (id.empty())
      throw Error("USAGE", "attach <session-id>");
    starting = true;
    auto c = load();
    verify_codex({{"codexPath", "codex"}, {"codexArgs", Json::array()}});
    auto u = relay_url(c.at("relay"));
    auto t = api("/sessions/" + id + (takeover_ ? "/takeover" : "/attach"), {{"delivery", 2}});
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
    if (t.value("delivery", 0) != 2)
      throw Error("UPGRADE_REQUIRED",
                  "Business transport delivery:2 required; upgrade Relay and Agent");
    auto cache = history_cache(c);
    std::unique_ptr<HistorySubscription> history_subscription;
    auto command_store = history_cache(c);
    const auto resume_connection = [this, id](Json resume) {
      return api("/sessions/" + id + "/attach", {{"delivery", 2}, {"resume", resume}});
    };
    auto bridge = std::make_unique<TuiBridge>(history_io, u, t.at("ticket"), "/ws/v1/cli/" + id,
                                              *command_store, resume_connection);
    auto url = bridge->url();
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
    struct TuiChildGuard {
      pid_t pid;
      bool reaped = false;
      ~TuiChildGuard() {
        if (!reaped) {
          kill(pid, SIGKILL);
          while (waitpid(pid, nullptr, 0) < 0 && errno == EINTR) {
          }
        }
      }
    } child_guard{pid};
#else
    WindowsChild child(args, "", false, t.at("ticket").get<std::string>());
#endif
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
          history_subscription.reset();
          cache.reset();
        }
      }
    };
    std::shared_ptr<Socket> reader;
    bool finished = false, reconnect_reader = false, history_pending = false, history_ready = false;
    bool history_frozen = false;
    int history_generation = 0, reader_attempts = 0;
    int64_t reader_retry_at = 0, history_connected_at = 0;
    std::string history_request;
    int64_t history_requested = 0;
    int64_t received_revision = tail.value("receivedRevision", int64_t(-1)), maximum_revision = 0;
    std::function<void()> read_history = [&] {
      if (!history_ready || history_pending || finished)
        return;
      history_pending = true;
      history_requested = now();
      history_request = uuid();
      Json command = {{"operation", "page"}, {"historyVersion", 2}, {"requestId", history_request}};
      command[received_revision < 0 ? "before" : "after"] =
          received_revision < 0 ? 0 : received_revision;
      reader->send(command);
    };
    const auto history_failed = [&](const Json &error) {
      std::cerr << "History subscription paused: " << error.dump() << '\n';
      history_frozen = true;
      history_ready = false;
      if (history_subscription)
        history_subscription->stop();
      if (reader)
        reader->close();
    };
    if (cache) {
      try {
        history_subscription = std::make_unique<HistorySubscription>(
            history_io, *cache, id + ":history-subscription",
            [&] {
              const auto saved = cache->cache_get(pageKey);
              return saved.is_null() ? int64_t(-1) : saved.value("receivedRevision", int64_t(-1));
            },
            [&](int64_t maximum) {
              maximum_revision = std::max(maximum_revision, maximum);
              if (received_revision < 0 || maximum_revision > received_revision)
                read_history();
            },
            [&] {
              history_ready = true;
              reader_attempts = 0;
              read_history();
            },
            history_failed);
      } catch (const std::exception &error) {
        std::cerr << "History subscription unavailable; read-only observation: "
                  << error_data(error).dump() << '\n';
      }
    }
    std::function<void()> reconnect = [&] {
      const auto connection = ++history_generation;
      history_connected_at = now();
      reader = connect_socket(
          history_io, u, c.at("token"),
          [&, connection](Json d) {
            if (connection != history_generation || history_frozen || finished)
              return;
            if (d.contains("receiptId"))
              reader->send({{"type", "receipt"}, {"receiptId", d["receiptId"]}});
            if (d.value("type", "") == "history-ready") {
              if (history_subscription)
                history_subscription->connect([&, connection](Json frame) {
                  if (!finished && !history_frozen && connection == history_generation)
                    reader->send(frame);
                });
              else {
                history_ready = true;
                reader_attempts = 0;
                read_history();
              }
              return;
            }
            try {
              if (history_subscription && history_subscription->receive(d))
                return;
            } catch (const std::exception &error) {
              history_failed(error_data(error));
              return;
            }
            if (d.value("type", "") == "history" && d.value("requestId", "") != history_request)
              return;
            if (d.value("type", "") == "history" || d.value("type", "") == "error")
              history_pending = false;
            if (d.value("type", "") == "history" && d.contains("events")) {
              auto current = tail["events"];
              if (d.value("gap", false)) {
                Json newer = Json::array();
                for (const auto &event : current)
                  if (event.value("revision", event.at("seq").get<int64_t>()) >
                      d.value("snapshotSeq", int64_t(0)))
                    newer.push_back(event);
                current = std::move(newer);
              }
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
              if (history_subscription)
                history_subscription->commit();
              if (more || maximum_revision > received_revision)
                read_history();
            }
            if (d.value("type", "") == "event") {
              if (!history_ready)
                return;
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
              if (history_subscription)
                history_subscription->commit();
              if (received_revision >= 0 && maximum_revision > received_revision)
                read_history();
            }
          },
          [&, connection](unsigned code) {
            if (connection != history_generation)
              return;
            if (history_subscription)
              history_subscription->disconnect();
            if (code == 4001) {
              finished = true;
              refresh_enabled = false;
              demand_refresh.cancel();
              return;
            }
            if (finished || history_frozen)
              return;
            history_ready = false;
            history_pending = false;
            reconnect_reader = true;
            reader_retry_at = now() + recovery_delay(reader_attempts);
            reader_attempts = std::min(reader_attempts + 1, 3);
          },
          "/ws/v1/history/" + id);
      reader->start();
    };
    recover_reader = [&] {
      if (finished || history_frozen)
        return;
      if (!history_ready && !reconnect_reader && now() - history_connected_at >= 15000) {
        reader->close();
        return;
      }
      if (history_pending && now() - history_requested >= 20000) {
        std::cerr
            << "RESULT_UNKNOWN: history refresh unconfirmed; reconnecting read-only transport\n";
        reader->close();
        return;
      }
      if (reconnect_reader && now() >= reader_retry_at) {
        reconnect_reader = false;
        reconnect();
      } else if (history_ready && !history_pending &&
                 (received_revision < 0 || maximum_revision > received_revision)) {
        read_history();
      }
    };
    reconnect();
#ifdef _WIN32
    DWORD status = 0;
#else
    int status;
#endif
    bool terminating = false;
    int64_t terminate_started = 0;
    while (true) {
      if (management_ && management_->restarting()) {
        if (!terminating) {
          terminating = true;
          terminate_started = now();
#ifdef _WIN32
          child.terminate();
#else
          kill(pid, SIGTERM);
#endif
        }
#ifndef _WIN32
        else if (now() - terminate_started > 2000)
          kill(pid, SIGKILL);
#endif
      }
#ifdef _WIN32
      if (child.poll(status))
        break;
#else
      auto done = waitpid(pid, &status, WNOHANG);
      if (done == pid) {
        child_guard.reaped = true;
        break;
      }
      if (done < 0 && errno != EINTR)
        throw Error("SPAWN_FAILED", "Cannot wait for Codex TUI");
#endif
      history_io.restart();
      history_io.run_for(std::chrono::milliseconds(100));
      if (bridge->started())
        starting = false;
      if (history_io.stopped())
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    finished = true;
    refresh_enabled = false;
    demand_refresh.cancel();
    if (history_subscription)
      history_subscription->stop();
    reader->close();
    if (bridge->started())
      starting = false;
    bridge.reset();
    history_io.restart();
    history_io.poll();
#ifdef _WIN32
    if (status != 0)
#else
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
#endif
      if (!terminating)
        throw Error("CODEX_EXITED", "Codex TUI exited unsuccessfully");
  }

public:
  Cli(int argc, char **argv)
      : options_(argc, argv),
        credentials_(std::filesystem::u8path(option(
            "config", config_path("COC_CREDENTIALS", "coc-client/credentials.json").u8string()))),
        takeover_(options_.takeover) {}
  std::string management_instance() const { return management_ ? management_->instance() : ""; }
  bool restarting() const { return management_ && management_->restarting(); }
  void run(bool &starting) {
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
    starting = false;
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
      auto result =
          device_login(option("relay", "https://r.xlogic.cc"), "cli", name, option("host"),
                       options_.api_key, option("message"), option("manager") == "true");
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
    } else if (command == "project") {
      auto d = project_arguments(options_, true);
      const auto path = "/hosts/" + host().at("id").get<std::string>() + "/project-management";
      if (d.contains("requestId") && !d.contains("revision"))
        d["revision"] = api(path).at("revision");
      if (d.contains("requestId"))
        std::cerr << "Project request " << d["requestId"] << " revision " << d["revision"] << '\n';
      std::cout << api(path, d).dump(2) << '\n';
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
      if (id.empty() || option("approval-id").empty() || !valid_id(option("runtime-id")) ||
          !valid_id(option("approval-version")))
        throw Error("USAGE", "approve|reject SESSION_ID --approval-id ID --runtime-id ID "
                             "--approval-version ID [--request-id ID]");
      const auto request_id = option("request-id", uuid());
      if (!valid_id(request_id))
        throw Error("USAGE", "Invalid --request-id");
      std::cerr << "Approval request ID: " << request_id << "; query its status before retrying\n";
      std::cout << api("/sessions/" + id + "/approval",
                       {{"approvalId", option("approval-id")},
                        {"runtimeId", option("runtime-id")},
                        {"approvalVersion", option("approval-version")},
                        {"allow", command == "approve"}},
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
      const auto credential = load();
      auto journal = history_cache(credential);
      auto original = journal->local_operation(id);
      if (!original.is_null()) {
        Json terminal = original.value("result", Json());
        if (original.contains("body")) {
          try {
            terminal = {
                {"data", original_api(credential, original.at("path"), original.at("body"), id)}};
          } catch (const Error &) {
            original = journal->local_operation(id);
            if (!original.contains("result"))
              throw;
            terminal = original.at("result");
          }
        }
        if (terminal.is_null())
          throw Error("RESULT_UNAVAILABLE", "Confirmed original result was retired locally");
        Json result = {{"state", "completed"}};
        if (terminal.contains("error"))
          result["error"] = terminal.at("error");
        else
          result["result"] = terminal.at("data");
        std::cout << result.dump(2) << '\n';
        return;
      }
      throw Error("NOT_FOUND", "Original intention is absent from this credential's local journal");
    } else if (command == "connect") {
      if (option("project").empty())
        throw Error("USAGE", "Select --project <project-id>");
      auto request_id = option("request-id", uuid());
      if (!valid_id(request_id))
        throw Error("USAGE", "Invalid --request-id");
      starting = true;
      verify_codex({{"codexPath", "codex"}, {"codexArgs", Json::array()}});
      auto h = host();
      std::cerr << "Create request ID: " << request_id << "; query with coc-client request "
                << request_id << " if unconfirmed\n";
      auto s = api("/sessions",
                   {{"hostId", h.at("id")}, {"projectId", option("project")}, {"mode", "cli"}},
                   request_id);
      attach(s.at("id"), starting);
    } else if (command == "history" || command == "cache-clear")
      history(id, command == "cache-clear");
    else if (command == "attach")
      attach(id, starting);
    else if (command == "stop") {
      if (id.empty())
        throw Error("USAGE", "stop <session-id>");
      std::cout << api("/sessions/" + id + "/stop", Json::object()).dump(2) << '\n';
    } else {
      std::cout
          << "Manager identity: login --manager --host ID; verify the pairing code in the "
             "browser.\n"
          << "Usage: coc-client (project list|browse PATH|add PATH [--mkdir]|rename ID NAME|remove "
             "ID) or "
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
             "--session ID --approval-id ID --runtime-id ID --approval-version ID "
             "--offline true --cache-dir PATH\n"
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
    if (!restarting() && command != "help" && command != "logout" && command != "doctor" &&
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
  bool starting = true;
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
    bool restart = false;
    std::string management_instance;
    {
      coc::Cli cli(argc, argv);
      try {
        cli.run(starting);
      } catch (...) {
        if (!cli.restarting())
          throw;
      }
      restart = cli.restarting();
      management_instance = cli.management_instance();
      if (restart)
        std::this_thread::sleep_for(std::chrono::seconds(2));
    }
    if (restart)
      coc::restart_process(argc, argv, management_instance);
    return 0;
  } catch (const std::exception &e) {
    std::cerr << coc::error_data(e).dump() << '\n';
    const auto *typed = dynamic_cast<const coc::Error *>(&e);
    if (starting && (!typed || (typed->code != "USAGE" && typed->code != "HOST_REQUIRED" &&
                                typed->code != "WRONG_MODE"))) {
      try {
        coc::Options options(argc, argv);
        coc::repair_startup(
            std::filesystem::u8path(options.get(
                "config",
                coc::config_path("COC_CREDENTIALS", "coc-client/credentials.json").u8string())),
            false, e);
      } catch (...) {
      }
    }
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
