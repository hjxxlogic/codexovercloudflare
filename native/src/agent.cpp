#include "coc/build.hpp"
#include "coc/diagnostics.hpp"
#include "coc/files.hpp"
#include "coc/login.hpp"
#include "coc/store.hpp"
#include "coc/update.hpp"
#include <atomic>
#include <boost/asio/thread_pool.hpp>
#include <csignal>
#include <iostream>
#include <map>
#include <openssl/rand.h>
#include <set>
#include <thread>
namespace coc {
struct Approval {
  Json rpc;
  int64_t time;
};
struct Runtime {
  std::shared_ptr<CodexProcess> process;
  int64_t epoch = 0, detached = now(), pending_epoch = 0, pending_expires = 0;
  bool submitted = false, busy = false, interrupt_pending = false;
  size_t priority = 0;
  std::map<std::string, Approval> approvals;
  std::map<std::string, std::string> requests;
  std::deque<Json> commands;
};
class Agent {
  // The business executor owns runtimes and the journal; a bounded file worker
  // owns project files. The relay executor never waits for disk.
  asio::io_context io_;
  asio::io_context &relay_io_;
  asio::executor_work_guard<asio::io_context::executor_type> relay_work_;
  std::thread worker_;
  std::atomic<size_t> inbound_{0}, outbound_{0};
  Json config_;
  std::filesystem::path config_file_;
  AgentUpdater &updater_;
  std::atomic<bool> update_restart_{false};
  Store store_;
  Store file_store_;
  WorkspaceFiles files_;
  asio::thread_pool file_pool_{1};
  asio::thread_pool approval_pool_{1};
  bool approval_check_pending_ = false, approval_check_failed_ = false;
  std::set<std::string> notified_requests_;
  size_t file_requests_ = 0, file_bytes_ = 0;
  bool file_cleanup_pending_ = false;
  Json buffered_events_ = Json::array();
  size_t buffered_bytes_ = 0;
  size_t event_batches_ = 0, event_count_ = 0;
  int64_t event_batch_max_us_ = 0;
  std::map<std::string, std::shared_ptr<Runtime>> runtimes_;
  std::shared_ptr<Socket> socket_;
  asio::steady_timer retry_, maintenance_, heartbeat_, event_timer_;
  asio::signal_set signals_;
  std::atomic<bool> stopped_{false};
  bool listing_threads_ = false;
  std::set<std::string> archive_loading_;
  int attempts_ = 0;
  std::atomic<int64_t> pong_{now()};

public:
  Agent(asio::io_context &io, Json c, std::filesystem::path config_file, AgentUpdater &updater)
      : relay_io_(io), relay_work_(asio::make_work_guard(io)), config_(std::move(c)),
        config_file_(std::move(config_file)), updater_(updater), store_(config_["dataDir"]),
        file_store_(config_["dataDir"], false), files_(&file_store_), retry_(io_),
        maintenance_(io_), heartbeat_(io), event_timer_(io_), signals_(io_, SIGINT, SIGTERM) {}
  bool update_restart() const { return update_restart_; }
  ~Agent() {
    if (worker_.joinable()) {
      asio::post(io_, [this] { close(); });
      worker_.join();
    }
    file_pool_.join();
    approval_pool_.join();
  }
  void start() {
    store_.on_failure([this] {
      // Stop side effects after a journal fault; close outside the failed SQL stack.
      asio::post(io_, [this] {
        std::cerr << Json{{"event", "storage_fault"}, {"time", now()}}.dump() << '\n';
        close();
      });
    });
    file_store_.on_failure([this] { asio::post(io_, [this] { close(); }); });
    asio::post(io_, [this] {
      signals_.async_wait([this](auto ec, int) {
        if (!ec)
          close();
      });
      check_client_requests();
      connect();
      check_update();
      maintain();
    });
    worker_ = std::thread([this] {
      for (;;) {
        try {
          io_.run();
          break;
        } catch (const std::exception &error) {
          std::cerr << Json{{"event", "executor_failure"}, {"error", error_data(error)}}.dump()
                    << '\n';
          close();
        }
      }
      if (update_restart_)
        asio::post(relay_io_, [this] { relay_io_.stop(); });
      relay_work_.reset();
    });
    heartbeat();
  }
  void heartbeat() {
    heartbeat_.expires_after(std::chrono::seconds(30));
    heartbeat_.async_wait([this](auto ec) {
      if (ec || stopped_)
        return;
      if (socket_) {
        if (now() - pong_.load() > 90000)
          socket_->close();
        else
          socket_->send({{"v", 1}, {"type", "ping"}});
      }
      heartbeat();
    });
  }
  void disconnected(unsigned code) {
    for (auto &[id, r] : runtimes_)
      if (!r->detached)
        r->detached = now();
    if (code == 4001) {
      std::cerr << "Device authorization revoked; stopping Agent\n";
      close();
      return;
    }
    if (stopped_)
      return;
    auto delay = std::min(30000, 1000 * (1 << std::min(5, attempts_++)));
    unsigned char random = 0;
    RAND_bytes(&random, 1);
    delay = delay * (0.8 + random / 255.0 * 0.4);
    retry_.expires_after(std::chrono::milliseconds(delay));
    retry_.async_wait([this](auto ec) {
      if (!ec)
        connect();
    });
  }
  void connect() {
    if (stopped_)
      return;
    asio::post(relay_io_, [this] {
      if (stopped_)
        return;
      pong_ = now();
      socket_ = connect_socket(
          relay_io_, relay_url(config_["relayUrl"]), config_["token"],
          [this](Json d) {
            if (d.value("type", "") == "pong") {
              pong_ = now();
              return;
            }
            const auto bytes = d.dump().size();
            if (inbound_.fetch_add(bytes) + bytes > max_queue) {
              inbound_.fetch_sub(bytes);
              socket_->close();
              return;
            }
            asio::post(io_, [this, d = std::move(d), bytes] {
              inbound_.fetch_sub(bytes);
              if (stopped_)
                return;
              try {
                receive(d);
              } catch (const std::exception &error) {
                std::cerr
                    << Json{{"event", "relay_message_failure"}, {"error", error_data(error)}}.dump()
                    << '\n';
                asio::post(relay_io_, [this] {
                  if (socket_)
                    socket_->close();
                });
              }
            });
          },
          [this](unsigned code) { asio::post(io_, [this, code] { disconnected(code); }); });
      socket_->start();
    });
  }
  void send(const Json &d) {
    auto envelope = d;
    envelope["v"] = 1;
    auto encoded = envelope.dump();
    const auto bytes = encoded.size();
    if (bytes > max_frame)
      throw Error("MESSAGE_TOO_LARGE", "Outgoing frame exceeds transport budget");
    if (outbound_.fetch_add(bytes) + bytes > max_queue) {
      outbound_.fetch_sub(bytes);
      asio::post(relay_io_, [this] {
        if (socket_)
          socket_->close();
      });
      return;
    }
    asio::post(relay_io_, [this, encoded = std::move(encoded), bytes]() mutable {
      outbound_.fetch_sub(bytes);
      if (socket_ && !stopped_)
        socket_->send_text(std::move(encoded));
    });
  }
  void notice(const std::string &id, const Json &p) {
    auto r = runtimes_.find(id);
    if (r != runtimes_.end())
      send({{"type", "notice"}, {"sessionId", id}, {"epoch", r->second->epoch}, {"payload", p}});
  }
  void publish(const std::string &id, const Json &event) {
    auto r = runtimes_.find(id);
    if (r != runtimes_.end())
      send({{"type", "event"},
            {"sessionId", id},
            {"epoch", r->second->epoch},
            {"payload", {{"type", "event"}, {"event", event}}}});
  }
  void flush_events() {
    if (buffered_events_.empty())
      return;
    event_timer_.cancel();
    auto entries = std::move(buffered_events_);
    buffered_events_ = Json::array();
    buffered_bytes_ = 0;
    const auto began = std::chrono::steady_clock::now();
    const auto results = store_.event_batch(entries);
    ++event_batches_;
    event_count_ += entries.size();
    event_batch_max_us_ =
        std::max(event_batch_max_us_, int64_t(std::chrono::duration_cast<std::chrono::microseconds>(
                                                  std::chrono::steady_clock::now() - began)
                                                  .count()));
    // Projections are cumulative. Publish only the latest committed revision of
    // each stream, in revision order; every original delta remains in the journal.
    std::map<int64_t, size_t> latest;
    for (size_t i = 0; i < results.size(); ++i)
      latest[results[i]["seq"].get<int64_t>()] = i;
    for (size_t i = 0; i < results.size(); ++i)
      if (latest.at(results[i]["seq"].get<int64_t>()) == i)
        publish(entries[i]["session"], results[i]);
  }
  void emit(const std::string &id, const std::string &type, const Json &data) {
    const bool delta = type == "item/agentMessage/delta" ||
                       type == "item/commandExecution/outputDelta" ||
                       type == "item/fileChange/outputDelta";
    auto safe = redact(data);
    if (!delta) {
      flush_events();
      publish(id, store_.event(id, type, safe));
      return;
    }
    const auto bytes = safe.dump().size();
    if (buffered_bytes_ + bytes > 128 * 1024)
      flush_events();
    if (buffered_events_.empty()) {
      event_timer_.expires_after(std::chrono::milliseconds(10));
      event_timer_.async_wait([this](auto ec) {
        if (!ec)
          flush_events();
      });
    }
    buffered_events_.push_back(
        {{"session", id}, {"type", type}, {"data", std::move(safe)}, {"time", now()}});
    buffered_bytes_ += bytes;
    if (buffered_events_.size() >= 128 || buffered_bytes_ >= 128 * 1024)
      flush_events();
  }
  Json project(const std::string &id) {
    for (auto &p : config_["projects"])
      if (p["id"] == id) {
        auto path = p["path"].get<std::string>();
        if (std::filesystem::canonical(path).string() != path)
          throw Error("PATH_CHANGED", "Project real path changed");
        return p;
      }
    throw Error("PROJECT_NOT_FOUND", "Project not registered");
  }
  void receive(const Json &d) {
    flush_events();
    if (d.value("v", 1) != 1)
      throw Error("PROTOCOL_MISMATCH", "Unsupported relay protocol");
    auto type = d.value("type", "");
    if (type == "hello") {
      if (d.value("minProtocol", 1) > 1) {
        close();
        return;
      }
      Json capabilities = {
          {"type", "capabilities"}, {"build", Json::parse(COC_BUILD_JSON)}, {"protocol", 1}};
      if (config_.contains("wakeUrl"))
        capabilities["wakeUrl"] = config_["wakeUrl"];
      send(capabilities);
      attempts_ = 0;
      std::cout << "Agent connected\n" << std::flush;
      return;
    }
    if (type == "pong") {
      pong_ = now();
      return;
    }
    if (type == "control") {
      auto request = d.at("requestId");
      try {
        control(d.at("action"), d.value("data", Json::object()),
                [this, request, started = now(), action = d.value("action", "")](Json data,
                                                                                 Json error) {
                  std::cerr << Json{{"event", "control_result"},
                                    {"requestId", request},
                                    {"action", action},
                                    {"durationMs", now() - started},
                                    {"errorCode",
                                     error.is_null() ? Json() : error.value("code", Json())}}
                                   .dump()
                            << '\n';
                  Json result = {{"type", "result"}, {"requestId", request}};
                  if (error.is_null())
                    result["data"] = data;
                  else
                    result["error"] = error;
                  if (result.dump().size() > max_frame)
                    result = {{"type", "result"},
                              {"requestId", request},
                              {"error",
                               {{"code", "MESSAGE_TOO_LARGE"},
                                {"message", "Control result exceeds frame budget"}}}};
                  send(result);
                });
      } catch (const std::exception &e) {
        auto args = d.value("data", Json::object());
        if (d.value("action", "") == "create" && args.contains("key")) {
          auto error = error_data(e);
          if (error["code"] != "RESULT_UNKNOWN" && error["code"] != "IDEMPOTENCY_CONFLICT")
            store_.finish("create:" + args["key"].get<std::string>(), {{"requestError", error}});
        }
        send({{"type", "result"}, {"requestId", request}, {"error", error_data(e)}});
      }
      return;
    }
    auto id = d.value("sessionId", "");
    auto it = runtimes_.find(id);
    if (it == runtimes_.end())
      return;
    auto rt = it->second;
    const auto incoming_epoch = d.value("epoch", int64_t(-1));
    if (rt->pending_epoch == incoming_epoch && rt->pending_expires > now() && type != "detach") {
      rt->epoch = incoming_epoch;
      rt->pending_epoch = 0;
      rt->detached = 0;
    }
    if (rt->epoch != incoming_epoch)
      return;
    if (type == "detach")
      rt->detached = now();
    else if (type == "rpc")
      cli(id, d.at("payload"));
    else if (type == "web") {
      const auto payload = d.at("payload");
      const auto action = payload.value("action", "");
      if (action == "interrupt" || action == "approval") {
        if (rt->priority >= 8) {
          notice(id,
                 {{"type", "error"},
                  {"error",
                   {{"code", "BACKPRESSURE"}, {"message", "Priority control budget exhausted"}}}});
          return;
        }
        ++rt->priority;
        const auto complete = [this, id, rt, payload](Json, Json error) {
          --rt->priority;
          if (!error.is_null())
            notice(id, {{"type", "error"},
                        {"requestId", payload.value("requestId", Json())},
                        {"error", error}});
        };
        try {
          web(id, payload, complete);
        } catch (const std::exception &error) {
          complete(nullptr, error_data(error));
        }
        return;
      }
      if (rt->commands.size() >= 100) {
        notice(id, {{"type", "error"},
                    {"error", {{"code", "BACKPRESSURE"}, {"message", "Web command queue full"}}}});
        return;
      }
      rt->commands.push_back({{"epoch", rt->epoch}, {"payload", d.at("payload")}});
      drain(id, rt);
    }
  }
  void control(const std::string &action, const Json &d, Completion done) {
    if (action == "history") {
      auto id = d.at("sessionId").get<std::string>();
      auto s = store_.get(id);
      if (d.value("operation", "page") == "content") {
        done(store_.content(id, d.at("seq"), d.value("offset", int64_t(0)),
                            d.value("revision", int64_t(-1))),
             nullptr);
        return;
      }
      auto page = store_.history(id, d.value("before", int64_t(0)), d.value("after", int64_t(-1)));
      if (d.contains("after") || s.value("archiveDone", true)) {
        done(page, nullptr);
        return;
      }
      if (!page["events"].empty()) {
        page["more"] = true;
        done(page, nullptr);
        return;
      }
      load_archive(id, [this, id, d, done](Json, Json error) {
        if (!error.is_null()) {
          done(nullptr, error);
          return;
        }
        auto page = store_.history(id, d.value("before", int64_t(0)));
        if (!store_.get(id).value("archiveDone", true))
          page["more"] = true;
        done(page, nullptr);
      });
      return;
    }
    if (action == "files") {
      auto p = project(d.at("projectId"));
      const auto bytes = d.dump().size();
      if (file_requests_ >= 8 || file_bytes_ + bytes > 512 * 1024)
        throw Error("BACKPRESSURE", "File worker queue full");
      ++file_requests_;
      file_bytes_ += bytes;
      auto work = asio::make_work_guard(io_);
      asio::post(file_pool_, [this, p, sandbox = config_["sandbox"], d, done, bytes,
                              work = std::move(work)]() mutable {
        Json result, error;
        try {
          if (stopped_)
            throw Error("HOST_OFFLINE", "Agent is stopping");
          result = files_.request(p["path"], sandbox, d.at("owner"), d);
        } catch (const std::exception &failure) {
          error = error_data(failure);
        }
        asio::post(io_, [this, done, bytes, result = std::move(result), error = std::move(error),
                         work = std::move(work)]() mutable {
          --file_requests_;
          file_bytes_ -= bytes;
          done(std::move(result), std::move(error));
        });
      });
      return;
    }
    if (action == "projects") {
      done(config_["projects"], nullptr);
      return;
    }
    if (action == "threads") {
      auto p = project(d.at("projectId"));
      if (listing_threads_ || archive_loading_.size() + runtimes_.size() >= 6)
        throw Error("BACKPRESSURE", "History query already in progress");
      auto ignore_message = [](Json) {};
      auto process = std::make_shared<CodexProcess>(io_, config_, p["path"], ignore_message, [] {});
      listing_threads_ = true;
      process->start();
      process->initialize([this, process, p, d, done](Json, Json error) {
        if (!error.is_null()) {
          listing_threads_ = false;
          process->close();
          done(nullptr, error);
          return;
        }
        process->request(
            "thread/list",
            {{"cwd", p["path"]},
             {"limit", 50},
             {"sortKey", "updated_at"},
             {"cursor", d.value("cursor", Json())}},
            [this, process, p, done](Json result, Json error) {
              listing_threads_ = false;
              process->close();
              if (!error.is_null()) {
                done(nullptr, error);
                return;
              }
              Json data = Json::array();
              for (auto &t : result.value("data", Json::array()))
                if (t.value("cwd", "") == p["path"]) {
                  auto preview = t.value("preview", "");
                  if (preview.size() > 500) {
                    size_t end = 500;
                    while (end && (static_cast<unsigned char>(preview[end]) & 0xc0) == 0x80)
                      --end;
                    preview.resize(end);
                  }
                  data.push_back({{"id", t.at("id")},
                                  {"preview", preview},
                                  {"name", t.value("name", Json())},
                                  {"updatedAt", t.value("updatedAt", int64_t(0))}});
                }
              done({{"data", data}, {"nextCursor", result.value("nextCursor", Json())}}, nullptr);
            });
      });
      return;
    }
    if (action == "list") {
      auto page = store_.session_page(d);
      done(d.value("paged", false) ? page : page["data"], nullptr);
      return;
    }
    if (action == "request") {
      if (d.contains("sessionId") && store_.get(d.at("sessionId"))["mode"] != d.at("mode"))
        throw Error("FORBIDDEN", "Wrong credential for session mode");
      auto key = d.contains("sessionId") ? d.at("sessionId").get<std::string>() + ":" : "create:";
      done(store_.request_status(key + d.at("requestId").get<std::string>()), nullptr);
      return;
    }
    if (action == "get") {
      auto info = store_.get(d.at("sessionId"));
      auto it = runtimes_.find(info["id"]);
      info["canReattach"] = info["mode"] != "cli" || it == runtimes_.end() ||
                            (it->second->epoch == 0 && (it->second->pending_epoch == 0 ||
                                                        it->second->pending_expires <= now()));
      done(info, nullptr);
      return;
    }
    if (action == "stop") {
      stop(d.at("sessionId"));
      done(store_.get(d.at("sessionId")), nullptr);
      return;
    }
    if (action == "attach") {
      auto s = store_.get(d.at("sessionId"));
      auto it = runtimes_.find(s["id"]);
      if (it == runtimes_.end() || s["state"] != "ready")
        throw Error("SESSION_CLOSED", "Session is not running");
      auto r = it->second;
      if (d.value("expires", now() + 1) <= now())
        throw Error("ATTACH_EXPIRED", "Attach deadline expired");
      if (s["mode"] == "cli" &&
          (r->epoch > 0 || (r->pending_epoch > 0 && r->pending_expires > now())))
        throw Error("CLI_REATTACH_UNSUPPORTED", "End this CLI session and create a new one");
      // Reservation alone never invalidates the current controller. The first
      // authenticated frame from the confirmed new lease activates its epoch.
      r->pending_epoch = d.at("epoch");
      r->pending_expires = d.value("expires", now() + 15000);
      done({{"ok", true}}, nullptr);
      return;
    }
    if (action != "create")
      throw Error("UNSUPPORTED_ACTION", "Unknown control action");
    auto key = "create:" + d.at("key").get<std::string>();
    auto fingerprint =
        "{\"projectId\":" + d.at("projectId").dump() + ",\"mode\":" + d.at("mode").dump();
    if (d.contains("threadId"))
      fingerprint += ",\"threadId\":" + d.at("threadId").dump();
    auto original_done = done;
    done = [this, key, original_done](Json result, Json error) {
      if (!error.is_null() && error.value("code", "") != "RESULT_UNKNOWN")
        store_.finish(key, {{"requestError", error}});
      original_done(result, error);
    };
    auto cached = store_.begin(key, fingerprint + "}");
    if (cached["cached"] == true) {
      done(cached["value"], nullptr);
      return;
    }
    auto p = project(d.at("projectId"));
    if (d.at("mode") != "cli" && d.at("mode") != "web")
      throw Error("INVALID_REQUEST", "Invalid session mode");
    if (d.contains("threadId")) {
      if (d.at("mode") != "web" || !d.at("threadId").is_string() ||
          !valid_id(d.at("threadId").get<std::string>()))
        throw Error("INVALID_REQUEST", "Invalid history thread");
      for (auto &o : store_.sessions(true))
        if (o.value("threadId", Json()) == d.at("threadId") && o["state"] == "ready")
          throw Error("SESSION_BUSY", "Thread already has an active session");
    }
    if (runtimes_.size() >= 4)
      throw Error("CAPACITY", "At most four active sessions");
    Json s = {{"id", config_["hostId"].get<std::string>() + "~" + uuid()},
              {"projectId", d.at("projectId")},
              {"mode", d.at("mode")},
              {"sandbox", config_["sandbox"]},
              {"state", d.at("mode") == "cli" ? "ready" : "starting"},
              {"running", false},
              {"createdAt", now()}};
    if (d.contains("threadId"))
      s["threadId"] = d.at("threadId");
    auto id = s["id"].get<std::string>();
    store_.submitted(key);
    store_.save(s);
    auto rt = std::make_shared<Runtime>();
    try {
      rt->process = std::make_shared<CodexProcess>(
          io_, config_, p["path"], [this, id](Json m) { on_codex(id, m); },
          [this, id] { on_exit(id); });
    } catch (...) {
      s["state"] = "failed";
      store_.save(s);
      throw;
    }
    runtimes_[id] = rt;
    rt->process->start();
    if (s["mode"] == "cli") {
      store_.finish(key, s);
      done(s, nullptr);
      return;
    }
    rt->process->initialize([this, id, rt, key, d, done](Json, Json error) {
      if (!error.is_null()) {
        stop(id);
        done(nullptr, error);
        return;
      }
      auto s = store_.get(id);
      auto launch = [this, id, rt, key, d, done]() {
        auto s = store_.get(id);
        Json params = {{"cwd", project(s["projectId"])["path"]},
                       {"sandbox", config_["sandbox"]},
                       {"approvalPolicy", "on-request"},
                       {"approvalsReviewer", "user"}};
        if (d.contains("threadId")) {
          params["threadId"] = d.at("threadId");
          params["excludeTurns"] = true;
        }
        rt->process->request(d.contains("threadId") ? "thread/resume" : "thread/start", params,
                             [this, id, key, d, done](Json result, Json error) {
                               if (!error.is_null()) {
                                 stop(id);
                                 done(nullptr, error);
                                 return;
                               }
                               auto current = store_.get(id);
                               current["threadId"] = result.at("thread").at("id");
                               store_.save(current);
                               if (d.contains("threadId")) {
                                 current["archiveDone"] = false;
                                 current["archiveCursor"] = nullptr;
                                 store_.save(current);
                                 load_archive(id, [this, id, key, done](Json, Json error) {
                                   if (!error.is_null()) {
                                     stop(id);
                                     done(nullptr, error);
                                     return;
                                   }
                                   auto current = store_.get(id);
                                   current["state"] = "ready";
                                   store_.save(current);
                                   store_.finish(key, current);
                                   done(current, nullptr);
                                 });
                               } else {
                                 current["state"] = "ready";
                                 store_.save(current);
                                 store_.finish(key, current);
                                 done(current, nullptr);
                               }
                             });
      };
      if (!d.contains("threadId")) {
        launch();
        return;
      }
      rt->process->request(
          "thread/read", {{"threadId", d.at("threadId")}, {"includeTurns", false}},
          [this, id, s, launch, done](Json result, Json error) {
            if (!error.is_null()) {
              stop(id);
              done(nullptr, error);
              return;
            }
            if (result.at("thread").value("cwd", "") != project(s["projectId"])["path"]) {
              stop(id);
              done(nullptr,
                   {{"code", "FORBIDDEN"}, {"message", "Thread belongs to another project"}});
              return;
            }
            launch();
          });
    });
  }
  void read_archive(const std::string &id, std::shared_ptr<CodexProcess> process, bool temporary,
                    int remaining, Completion done) {
    auto s = store_.get(id);
    process->request("thread/items/list",
                     {{"threadId", s.at("threadId")},
                      {"cursor", s.value("archiveCursor", Json())},
                      {"sortDirection", "desc"},
                      {"limit", 1}},
                     [this, id, process, temporary, remaining, done](Json result, Json error) {
                       if (!error.is_null()) {
                         archive_loading_.erase(id);
                         if (temporary)
                           process->close();
                         done(nullptr, error);
                         return;
                       }
                       Json events = Json::array();
                       for (auto &entry : result.value("data", Json::array())) {
                         auto item = entry.at("item");
                         auto type = item.value("type", "");
                         auto turn = entry.value("turnId", "");
                         if (type == "userMessage") {
                           std::string text;
                           for (auto &content : item.value("content", Json::array()))
                             if (content.value("type", "") == "text")
                               text += content.value("text", "");
                           events.push_back({{"type", "user"}, {"data", {{"text", text}}}});
                         } else if (type == "agentMessage")
                           events.push_back({{"type", "item/agentMessage/delta"},
                                             {"data",
                                              {{"itemId", item.value("id", "")},
                                               {"turnId", turn},
                                               {"delta", item.value("text", "")}}}});
                         else
                           events.push_back({{"type", "item/completed"},
                                             {"data", {{"item", item}, {"turnId", turn}}}});
                       }
                       auto cursor = result.value("nextCursor", Json());
                       store_.archive_page(id, events, cursor);
                       if (!cursor.is_null() && remaining > 1) {
                         read_archive(id, process, temporary, remaining - 1, done);
                         return;
                       }
                       archive_loading_.erase(id);
                       if (temporary)
                         process->close();
                       done(nullptr, nullptr);
                     });
  }
  void load_archive(const std::string &id, Completion done) {
    auto s = store_.get(id);
    auto existing = runtimes_.find(id);
    // Closed sessions can still fetch uncached archive pages after Agent restart.
    const bool temporary = existing == runtimes_.end() || s.value("state", "") == "closing" ||
                           s.value("state", "") == "closed" || s.value("state", "") == "failed";
    auto process = temporary
                       ? std::make_shared<CodexProcess>(
                             io_, config_, project(s["projectId"])["path"], [](Json) {}, [] {})
                       : existing->second->process;
    if (archive_loading_.count(id) ||
        (temporary && archive_loading_.size() + runtimes_.size() >= 6))
      throw Error("BACKPRESSURE", "Archive page is already loading");
    archive_loading_.insert(id);
    auto read = [this, id, process, temporary, done]() {
      read_archive(id, process, temporary, 10, done);
    };
    if (temporary) {
      process->start();
      process->initialize([this, id, process, read, done](Json, Json error) {
        if (!error.is_null()) {
          archive_loading_.erase(id);
          process->close();
          done(nullptr, error);
        } else
          read();
      });
    } else
      read();
  }
  void check_busy(const Json &s) {
    for (auto &o : store_.sessions(true))
      if (o["id"] != s["id"] && o["projectId"] == s["projectId"] && o["state"] == "ready" &&
          o["running"] == true)
        throw Error("PROJECT_BUSY", "Another session is executing in this project");
  }
  void rpc(const std::string &id, const Json &raw) {
    auto m = redact(raw);
    if (m.dump().size() > max_frame - 4096) {
      emit(id, "largeRpc", m);
      if (m.contains("id") && !m.contains("method"))
        m = {{"id", m["id"]},
             {"error",
              {{"code", -32000},
               {"message", "Large result is available through coc-client history content reads"}}}};
      else
        return; // Full content remains in the Agent journal and read-only history stream.
    }
    auto it = runtimes_.find(id);
    if (it != runtimes_.end())
      send({{"type", "rpc"},
            {"sessionId", id},
            {"epoch", it->second->epoch},
            {"payload", redact(m)}});
  }
  void cli(const std::string &id, const Json &m) {
    auto s = store_.get(id);
    auto rt = runtimes_.at(id);
    try {
      if (s["mode"] != "cli")
        throw Error("FORBIDDEN", "Not a CLI session");
      if (!m.is_object())
        throw Error("INVALID_REQUEST", "Invalid RPC");
      if (!m.contains("method")) {
        auto key = id_key(m.at("id"));
        if (!rt->approvals.count(key))
          throw Error("UNKNOWN_APPROVAL", "No matching server request");
        rt->approvals.erase(key);
        rt->process->send(m);
        return;
      }
      auto guarded = guard_cli(m, project(s["projectId"])["path"], config_["sandbox"],
                               s.value("threadId", ""));
      auto method = m.at("method").get<std::string>();
      if (method == "thread/start" && rt->submitted)
        throw Error("UNSUPPORTED_ACTION", "One thread per CLI session");
      if (method == "thread/list" || method == "thread/loaded/list") {
        Json result = method == "thread/list"
                          ? Json{{"data", Json::array()}, {"nextCursor", nullptr}}
                          : Json{{"data", s.contains("threadId") ? Json::array({s["threadId"]})
                                                                 : Json::array()}};
        rpc(id, {{"id", m.at("id")}, {"result", result}});
        return;
      }
      if (method == "turn/start" || method == "turn/steer") {
        check_busy(s);
        rt->submitted = true;
        s["running"] = true;
        store_.save(s);
      }
      if (m.contains("id"))
        rt->requests[id_key(m["id"])] = method;
      if (method == "turn/start" || method == "turn/steer") {
        std::string text;
        for (auto &input : guarded["params"].value("input", Json::array()))
          text += input.value("text", "");
        emit(id, "user", {{"text", text}});
      }
      rt->process->send(guarded);
    } catch (const std::exception &e) {
      rpc(id, {{"id", m.is_object() ? m.value("id", Json()) : Json()},
               {"error", {{"code", -32001}, {"message", error_data(e)["message"]}}}});
    }
  }
  void on_codex(const std::string &id, const Json &m) {
    auto it = runtimes_.find(id);
    if (it == runtimes_.end())
      return;
    auto rt = it->second;
    auto s = store_.get(id);
    auto method = m.value("method", "");
    if (s["mode"] == "cli" && m.contains("id") && method.empty()) {
      auto key = id_key(m["id"]);
      auto req = rt->requests.find(key);
      if (req != rt->requests.end()) {
        if (req->second == "thread/start" && m.contains("result") && m["result"].contains("thread"))
          s["threadId"] = m["result"]["thread"]["id"];
        if (m.contains("error") && (req->second == "turn/start" || req->second == "turn/steer"))
          s["running"] = false;
        rt->requests.erase(req);
        store_.save(s);
      }
    }
    if (method == "turn/started") {
      s["running"] = true;
      s["turnId"] = m.at("params").at("turn").at("id");
      store_.save(s);
      if (rt->interrupt_pending) {
        rt->interrupt_pending = false;
        rt->process->request("turn/interrupt",
                             {{"threadId", s.at("threadId")}, {"turnId", s.at("turnId")}},
                             [this, id](Json, Json error) {
                               if (!error.is_null())
                                 notice(id, {{"type", "error"}, {"error", error}});
                             });
      }
    }
    if (method == "turn/completed") {
      s["running"] = false;
      s.erase("turnId");
      store_.save(s);
    }
    if (!method.empty() && m.contains("id")) {
      static const std::set<std::string> supported = {
          "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
          "item/permissions/requestApproval", "item/tool/requestUserInput",
          "mcpServer/elicitation/request"};
      auto key = id_key(m["id"]);
      bool basic = method == "item/commandExecution/requestApproval" ||
                   method == "item/fileChange/requestApproval";
      if (!supported.count(method) || (s["mode"] == "web" && !basic)) {
        rt->process->send(
            {{"id", m["id"]},
             {"error",
              {{"code", -32601}, {"message", "Remote client does not support this request"}}}});
        if (s["mode"] == "web")
          emit(id, "warning",
               {{"message", "Unsupported interactive request was rejected: " + method}});
        return;
      }
      rt->approvals[key] = {m, now()};
      if (s["mode"] == "web") {
        emit(id, "approval",
             {{"approvalId", key},
              {"method", method},
              {"params", m.value("params", Json::object())}});
        return;
      }
    }
    if (s["mode"] == "cli") {
      if (!method.empty() && !m.contains("id"))
        emit(id, method, m.value("params", Json::object()));
      rpc(id, m);
    } else if (!method.empty())
      emit(id, method, m.value("params", Json::object()));
  }
  void drain(const std::string &id, std::shared_ptr<Runtime> rt) {
    if (rt->busy || rt->commands.empty() || !runtimes_.count(id))
      return;
    auto d = rt->commands.front();
    rt->commands.pop_front();
    if (d["epoch"] != rt->epoch) {
      drain(id, rt);
      return;
    }
    rt->busy = true;
    auto raw = d["payload"];
    auto finish = [this, id, rt, raw](Json, Json error) {
      if (!error.is_null())
        notice(id, {{"type", "error"},
                    {"requestId", raw.is_object() ? raw.value("requestId", Json()) : Json()},
                    {"error", error}});
      rt->busy = false;
      drain(id, rt);
    };
    try {
      web(id, raw, finish);
    } catch (const std::exception &e) {
      finish(nullptr, error_data(e));
    }
  }
  void web(const std::string &id, const Json &raw, Completion done) {
    auto cmd = web_command(raw);
    auto s = store_.get(id);
    auto rt = runtimes_.at(id);
    if (s["mode"] != "web")
      throw Error("FORBIDDEN", "Not a web session");
    auto action = cmd.at("action").get<std::string>();
    if (action == "sync") {
      auto replay = store_.replay(id, cmd["after"]);
      replay["type"] = "sync";
      replay["session"] = s;
      replay["approvals"] = Json::array();
      for (auto &[key, a] : rt->approvals)
        replay["approvals"].push_back({{"approvalId", key},
                                       {"method", a.rpc["method"]},
                                       {"params", redact(a.rpc.value("params", Json::object()))}});
      notice(id, replay);
      done(nullptr, nullptr);
      return;
    }
    auto key = id + ":" + cmd["requestId"].get<std::string>();
    auto cached = store_.begin(key, web_fingerprint(cmd));
    if (cached["cached"] == true) {
      notice(id, {{"type", "ack"}, {"requestId", cmd["requestId"]}, {"result", cached["value"]}});
      done(nullptr, nullptr);
      return;
    }
    auto complete = [this, id, key, cmd, done](Json result, Json error) {
      if (!error.is_null() && error.value("code", "") != "RESULT_UNKNOWN")
        store_.finish(key, {{"requestError", error}});
      if (error.is_null()) {
        store_.finish(key, result);
        notice(id, {{"type", "ack"}, {"requestId", cmd["requestId"]}, {"result", result}});
      }
      done(result, error);
    };
    if (action == "prompt") {
      try {
        if (s["running"] == true)
          throw Error("TURN_BUSY", "A turn is already running");
        check_busy(s);
      } catch (const std::exception &error) {
        complete(nullptr, error_data(error));
        return;
      }
      store_.submitted(key);
      s["running"] = true;
      s.erase("turnId");
      store_.save(s);
      emit(id, "user", {{"text", cmd["text"]}, {"requestId", cmd["requestId"]}});
      rt->process->request("turn/start",
                           {{"threadId", s.at("threadId")},
                            {"input", Json::array({{{"type", "text"},
                                                    {"text", cmd["text"]},
                                                    {"text_elements", Json::array()}}})}},
                           [this, id, complete](Json result, Json error) {
                             auto current = store_.get(id);
                             if (error.is_null()) {
                               auto turn = result.at("turn").at("id");
                               if (current["running"] == true)
                                 current["turnId"] = turn;
                               store_.save(current);
                               complete({{"turnId", turn}}, nullptr);
                             } else {
                               if (error.value("code", "") != "RESULT_UNKNOWN") {
                                 current["running"] = false;
                                 store_.save(current);
                               }
                               complete(nullptr, error);
                             }
                           });
      return;
    }
    if (action == "interrupt" && s.contains("turnId")) {
      rt->process->request("turn/interrupt",
                           {{"threadId", s.at("threadId")}, {"turnId", s.at("turnId")}}, complete);
      return;
    }
    if (action == "interrupt" && s.value("running", false))
      rt->interrupt_pending = true;
    if (action == "approval") {
      try {
        answer(id, cmd["approvalId"], cmd["allow"]);
      } catch (const std::exception &error) {
        complete(nullptr, error_data(error));
        return;
      }
    }
    complete({{"ok", true}}, nullptr);
  }
  void answer(const std::string &id, const std::string &key, bool allow) {
    auto rt = runtimes_.at(id);
    auto it = rt->approvals.find(key);
    if (it == rt->approvals.end())
      throw Error("UNKNOWN_APPROVAL", "Approval expired or already answered");
    auto m = it->second.rpc;
    auto method = m.at("method");
    if (method == "item/commandExecution/requestApproval" ||
        method == "item/fileChange/requestApproval")
      rt->process->send(
          {{"id", m["id"]}, {"result", {{"decision", allow ? "accept" : "decline"}}}});
    else
      rt->process->send(
          {{"id", m["id"]}, {"error", {{"code", -32000}, {"message", "Approval timed out"}}}});
    rt->approvals.erase(it);
    emit(id, "approvalResolved", {{"approvalId", key}, {"allow", allow}});
  }
  void on_exit(const std::string &id) {
    if (!runtimes_.count(id))
      return;
    auto s = store_.get(id);
    if (s["state"] == "closing")
      s["state"] = "closed";
    else if (s["state"] != "closed")
      s["state"] = "failed";
    s["running"] = false;
    store_.save(s);
    emit(id, "sessionClosed", {{"state", s["state"]}});
    runtimes_.erase(id);
  }
  void stop(const std::string &id) {
    auto s = store_.get(id);
    auto it = runtimes_.find(id);
    s["state"] = it == runtimes_.end() ? "closed" : "closing";
    s["running"] = false;
    store_.save(s);
    if (it != runtimes_.end()) {
      auto p = it->second->process;
      if (s.contains("turnId"))
        p->request("turn/interrupt", {{"threadId", s.at("threadId")}, {"turnId", s.at("turnId")}},
                   [](Json, Json) {});
      p->close();
    }
  }
  void check_update() {
    try {
      // Only this setting is hot-reloaded; project/policy changes still need restart.
      config_["autoUpdate"] = read_json(config_file_).value("autoUpdate", Json(true));
      if (updater_.poll(config_, config_.at("relayUrl"),
                        runtimes_.empty() && archive_loading_.empty() && !listing_threads_ &&
                            file_requests_ == 0)) {
        std::cerr << Json{{"event", "auto_update_restarting"}, {"time", now()}}.dump() << '\n';
        update_restart_ = true;
        close();
      }
    } catch (const std::exception &error) {
      std::cerr << Json{{"event", "auto_update_failed"}, {"error", error_data(error)}}.dump()
                << '\n';
    }
  }
  void check_client_requests() {
    if (stopped_ || approval_check_pending_)
      return;
    approval_check_pending_ = true;
    auto work = asio::make_work_guard(io_);
    const auto relay = relay_url(config_.at("relayUrl"));
    const auto token = config_.at("token").get<std::string>();
    const auto host = config_.at("hostId");
    asio::post(approval_pool_, [this, relay, token, host, work = std::move(work)]() mutable {
      Json result, failure;
      try {
        result =
            http_json(relay, "/api/v1/agent/requests", nullptr, token, "", std::chrono::seconds(5));
        if (result.at("hostId") != host || !result.at("pending").is_array())
          throw Error("PROTOCOL_MISMATCH", "Invalid Agent approval list");
      } catch (const std::exception &error) {
        failure = error_data(error);
      }
      asio::post(io_, [this, result = std::move(result), failure = std::move(failure),
                       work = std::move(work)] {
        approval_check_pending_ = false;
        if (stopped_)
          return;
        if (!failure.is_null()) {
          if (!approval_check_failed_)
            std::cerr << Json{{"event", "client_approval_check_failed"},
                              {"error", failure},
                              {"message", "Will retry; Agent continues running"}}
                             .dump()
                      << '\n';
          approval_check_failed_ = true;
          return;
        }
        approval_check_failed_ = false;
        // Quote the config path for a POSIX shell, including spaces, quotes and '$'.
        std::string config_arg = "'";
        for (char c : std::filesystem::absolute(config_file_).string())
          config_arg += c == '\'' ? "'\\''" : std::string(1, c);
        config_arg += "'";
        std::set<std::string> pending;
        for (const auto &request : result.at("pending")) {
          if (!request.is_object() || !request.value("id", Json()).is_string() ||
              !valid_id(request.at("id").get<std::string>()) ||
              request.value("requestedHostId", Json()) != config_.at("hostId") ||
              (request.value("role", Json()) != "cli" && request.value("role", Json()) != "web"))
            continue;
          const auto id = request.at("id").get<std::string>();
          pending.insert(id);
          if (notified_requests_.count(id))
            continue;
          // JSON escapes untrusted names/messages so they cannot inject terminal commands.
          Json notice = {{"event", "client_approval_required"}};
          for (const auto *key :
               {"id", "role", "name", "requestedHostId", "message", "code", "expires"})
            notice[key] = request.value(key, Json());
          std::cerr
              << "Client login approval required. Verify the pairing code, role and message.\n"
              << notice.dump() << "\nApprove: coc-agent approve " << id << " --config "
              << config_arg << "\nReject:  coc-agent reject " << id << " --config " << config_arg
              << '\n'
              << std::flush;
        }
        notified_requests_ = std::move(pending);
      });
    });
  }
  void maintain() {
    maintenance_.expires_after(std::chrono::seconds(30));
    maintenance_.async_wait([this](auto ec) {
      if (ec || stopped_)
        return;
      check_client_requests();
      check_update();
      if (stopped_)
        return;
      try {
        for (auto &[id, r] : runtimes_) {
          std::vector<std::string> expired;
          for (auto &[key, a] : r->approvals)
            if (now() - a.time > 600000)
              expired.push_back(key);
          for (auto &key : expired)
            answer(id, key, false);
          if (r->detached && now() - r->detached > 1800000)
            stop(id);
        }
        size_t approvals = 0, commands = 0;
        for (const auto &[id, runtime] : runtimes_) {
          approvals += runtime->approvals.size();
          commands += runtime->commands.size();
        }
        std::cerr << Json{{"event", "agent_metrics"},
                          {"time", now()},
                          {"runtimes", runtimes_.size()},
                          {"archiveReaders", archive_loading_.size()},
                          {"approvals", approvals},
                          {"queuedCommands", commands},
                          {"fileRequests", file_requests_},
                          {"fileQueueBytes", file_bytes_},
                          {"bufferedEvents", buffered_events_.size()},
                          {"eventBatches", event_batches_},
                          {"batchedEvents", event_count_},
                          {"eventBatchMaxUs", event_batch_max_us_},
                          {"storageIngressBytes", inbound_.load()},
                          {"relayEgressBytes", outbound_.load()}}
                         .dump()
                  << '\n';
        event_batches_ = event_count_ = 0;
        event_batch_max_us_ = 0;
        store_.cleanup();
        if (!file_cleanup_pending_) {
          file_cleanup_pending_ = true;
          auto work = asio::make_work_guard(io_);
          asio::post(file_pool_, [this, work = std::move(work)]() mutable {
            Json failure;
            try {
              files_.cleanup();
            } catch (const std::exception &error) {
              failure = error_data(error);
            }
            asio::post(io_, [this, failure = std::move(failure), work = std::move(work)] {
              file_cleanup_pending_ = false;
              if (!failure.is_null()) {
                std::cerr << Json{{"event", "file_maintenance_failure"}, {"error", failure}}.dump()
                          << '\n';
                close();
              }
            });
          });
        }
      } catch (const std::exception &error) {
        std::cerr << Json{{"event", "maintenance_failure"},
                          {"error", error_data(error)},
                          {"time", now()}}
                         .dump()
                  << '\n';
        close();
        return;
      }
      maintain();
    });
  }
  void close() {
    if (stopped_)
      return;
    try {
      flush_events();
    } catch (const std::exception &error) {
      std::cerr << Json{{"event", "shutdown_flush_failure"}, {"error", error_data(error)}}.dump()
                << '\n';
    }
    stopped_ = true;
    event_timer_.cancel();
    asio::post(file_pool_, [this] { files_.clear(); });
    retry_.cancel();
    maintenance_.cancel();
    signals_.cancel();
    asio::post(relay_io_, [this] {
      heartbeat_.cancel();
      if (socket_)
        socket_->close();
    });
    auto running = runtimes_;
    for (auto &[id, runtime] : running) {
      try {
        stop(id);
      } catch (const std::exception &error) {
        std::cerr << Json{{"event", "shutdown_storage_failure"},
                          {"sessionId", id},
                          {"error", error_data(error)}}
                         .dump()
                  << '\n';
        runtime->process->close();
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
    coc::Options options(argc, argv);
    if (options.values.count("message"))
      throw coc::Error("USAGE", "--message is only supported by coc-client paired login");
    auto command = options.args.empty() ? "help" : options.args[0];
    auto file = std::filesystem::path(options.get(
        "config", coc::config_path("COC_AGENT_CONFIG", "coc-agent/agent.json").string()));
    if (command == "help") {
      std::cout
          << "Usage: coc-agent "
             "<login|logout|status|wake-url|requests|approve|reject|doctor|run|update|--version> "
             "[--config "
             "PATH] "
             "[--relay URL] "
             "[--name NAME] [--project PATH] [--project-id ID] [--api-key]\n"
             "login --api-key: read COC_API_KEY or prompt securely; otherwise approve the "
             "displayed request in the management website. logout only "
             "removes local credentials.\n"
             "requests: list CC/CW requests explicitly targeting this Agent.\n"
             "approve REQUEST_ID / reject REQUEST_ID: after checking the pairing code and role, "
             "handle one targeted request with this Agent credential.\n";
      std::cout << "wake-url URL: save and register wake URL; use an empty URL to clear it.\n";
      return 0;
    }
    if (options.api_key && command != "login")
      throw coc::Error("USAGE", "--api-key is only valid for login");
    if (command == "update") {
      auto config = std::filesystem::exists(file) ? coc::read_json(file) : coc::Json::object();
      auto update = coc::prepare_update(
          config, options.get("relay", config.value("relayUrl", "https://r.xlogic.cc")), true);
      if (update) {
        update->install();
        std::cout << update->release.dump(2) << '\n';
      } else
        std::cout << "Already up to date\n";
      return 0;
    }
    std::unique_ptr<coc::PrivateLock> config_lock;
    if (command == "login" || command == "logout" || command == "wake-url")
      config_lock = std::make_unique<coc::PrivateLock>(file);
    if (command == "login") {
      if (options.args.size() != 1)
        throw coc::Error("USAGE", "Unexpected login argument");
      coc::Json config;
      if (std::filesystem::exists(file)) {
        config = coc::read_json(file);
        if (!config.value("token", "").empty())
          throw coc::Error("ALREADY_LOGGED_IN",
                           "Local A credential exists; use status or logout first");
      } else {
        if (options.get("project").empty())
          throw coc::Error("USAGE", "First login requires --project <directory>");
        auto path = std::filesystem::canonical(options.get("project"));
        auto id = options.get("project-id", "my-project");
        if (!std::filesystem::is_directory(path) || !coc::valid_id(id))
          throw coc::Error("CONFIG_ERROR", "Invalid project");
        config = {
            {"autoUpdate", true},
            {"codexPath", "codex"},
            {"codexArgs", coc::Json::array()},
            {"sandbox", "workspace-write"},
            {"dataDir", (std::filesystem::absolute(file).parent_path() / "data").string()},
            {"projects", coc::Json::array({{{"id", id}, {"name", id}, {"path", path.string()}}})}};
      }
      auto grant = coc::device_login(options.get("relay", "https://r.xlogic.cc"), "agent",
                                     options.get("name", "Codex agent"), "", options.api_key);
      config["relayUrl"] = grant.at("relay");
      config["hostId"] = grant.at("hostId");
      config["token"] = grant.at("token");
      coc::save_private(file, config);
      std::cout << "Agent authorized: " << grant.at("hostId") << "\nConfig: " << file << '\n';
      return 0;
    }
    if (command == "logout") {
      auto config = coc::read_json(file);
      config["token"] = "";
      coc::save_private(file, config);
      std::cout << "Local credential removed; stop any running Agent separately. Relay "
                   "authorization is unchanged.\n";
      return 0;
    }
    if (command == "wake-url") {
      if (options.args.size() != 2)
        throw coc::Error("USAGE", "wake-url URL (empty URL clears configuration)");
      auto config = coc::read_json(file);
      const auto url = coc::wake_url(options.args[1]);
      coc::http_json(coc::relay_url(config.at("relayUrl")), "/api/v1/agent/wake-url",
                     {{"wakeUrl", url}}, config.at("token"));
      config["wakeUrl"] = url;
      coc::save_private(file, config);
      std::cout << "Wake URL saved; administrator override takes priority. Restart a running "
                   "Agent to reload its local configuration.\n";
      return 0;
    }
    if (command == "doctor") {
      auto result = coc::doctor(coc::read_json(file), true);
      std::cout << result.dump(2) << '\n';
      return result["ok"] == true ? 0 : 1;
    }
    if (command == "requests" || command == "approve" || command == "reject") {
      const bool decision = command != "requests";
      if (options.args.size() != (decision ? 2 : 1) ||
          (decision && !coc::valid_id(options.args[1])))
        throw coc::Error("USAGE", "Use requests, approve REQUEST_ID or reject REQUEST_ID");
      const auto config = coc::read_json(file);
      const auto token = config.value("token", "");
      if (token.empty())
        throw coc::Error("UNAUTHORIZED", "Agent login required");
      auto path = std::string("/api/v1/agent/requests");
      if (decision)
        path += "/" + options.args[1] + "/" + command;
      std::cout << coc::http_json(coc::relay_url(config.at("relayUrl")), path,
                                  decision ? coc::Json::object() : coc::Json(nullptr), token)
                       .dump(2)
                << '\n';
      return 0;
    }
    if (command == "status") {
      auto config = coc::read_json(file);
      std::cout << coc::credential_status({{"relay", config.at("relayUrl")},
                                           {"role", "agent"},
                                           {"token", config.at("token")}})
                       .dump(2)
                << '\n';
      return 0;
    }
    if (command != "run")
      throw coc::Error("USAGE", "Unknown command: " + command);
    auto config = coc::agent_config(coc::read_json(file));
    coc::update_settings(config);
    coc::verify_codex(config);
    boost::asio::io_context io;
    coc::AgentUpdater updater;
    bool restart = false;
    {
      coc::Agent agent(io, config, file, updater);
      agent.start();
      io.run();
      restart = agent.update_restart();
    }
    if (restart && updater.install())
      coc::restart_updated(argc, argv);
    return 0;
  } catch (const std::exception &e) {
    std::cerr << coc::error_data(e).dump() << '\n';
    return 1;
  }
}
