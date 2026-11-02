#include "coc/access.hpp"
#include "coc/approvals.hpp"
#include "coc/build.hpp"
#include "coc/credit.hpp"
#include "coc/delivery.hpp"
#include "coc/diagnostics.hpp"
#include "coc/external.hpp"
#include "coc/files.hpp"
#include "coc/login.hpp"
#include "coc/projects.hpp"
#include "coc/proxy.hpp"
#include "coc/recovery.hpp"
#include "coc/remote_config.hpp"
#include "coc/store.hpp"
#include "coc/update.hpp"
#include <atomic>
#include <boost/asio/thread_pool.hpp>
#include <csignal>
#include <iostream>
#include <map>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <set>
#include <thread>
namespace coc {
struct Approval {
  Json rpc;
  int64_t time;
  bool submitted = false, unsupported = false;
  std::string version = uuid();
  bool auto_attempted = false;
  std::shared_ptr<void> reservation{};
};
struct QueuedCommand {
  Json frame;
  std::shared_ptr<void> reservation;
};
struct Runtime {
  std::string runtime_id = uuid();
  std::shared_ptr<CodexProcess> process;
  std::shared_ptr<ExternalThread> reader;
  std::shared_ptr<ExternalApprovals> external_approvals;
  std::string observer_error;
  int64_t epoch = 0, detached = now(), pending_epoch = 0, pending_expires = 0;
  int64_t published_revision = 0;
  bool submitted = false, busy = false;
  std::shared_ptr<RuntimeResources> resources = std::make_shared<RuntimeResources>();
  std::map<std::string, Approval> approvals;
  std::map<std::string, std::string> requests;
  std::deque<QueuedCommand> commands;
  std::map<std::string, Json> deliveries, result_routes;
  Json immediate_delivery, interrupt_target;
  std::string cli_delivery_stream;
  bool rpc_delivery = false;
  int64_t rpc_sent = 0, rpc_credit = 0, rpc_byte_credit = 0;
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
  RemoteConfiguration remote_config_;
  asio::steady_timer remote_restart_timer_;
  std::atomic<bool> remote_restart_{false};
  AgentUpdater &updater_;
  std::atomic<bool> update_restart_{false};
  Store store_;
  Projects projects_;
  std::unique_ptr<ProjectControl> project_control_;
  Store file_store_;
  WorkspaceFiles files_;
  asio::thread_pool file_pool_{1};
  asio::thread_pool approval_pool_{1};
  bool approval_check_pending_ = false, approval_check_failed_ = false,
       approval_check_again_ = false;
  std::set<std::string> notified_requests_;
  size_t file_requests_ = 0, file_bytes_ = 0;
  bool file_cleanup_pending_ = false;
  Json buffered_events_ = Json::array();
  size_t buffered_bytes_ = 0;
  size_t event_batches_ = 0, event_count_ = 0;
  int64_t event_batch_max_us_ = 0;
  std::map<std::string, std::shared_ptr<Runtime>> runtimes_;
  std::map<std::string, Json> history_routes_;
  std::shared_ptr<Socket> socket_;
  asio::steady_timer retry_, maintenance_, event_timer_, history_retry_;
  asio::signal_set signals_;
  std::atomic<bool> stopped_{false};
  bool listing_threads_ = false, negotiated_ = false;
  std::set<std::string> archive_loading_;
  size_t history_readers_ = 0;
  uint64_t history_prepared_ = 0, history_prepare_skipped_ = 0;
  int attempts_ = 0;

public:
  Agent(asio::io_context &io, Json c, std::filesystem::path config_file, AgentUpdater &updater)
      : relay_io_(io), relay_work_(asio::make_work_guard(io)), config_(std::move(c)),
        config_file_(std::move(config_file)), remote_config_(config_file_, true),
        remote_restart_timer_(io_), updater_(updater),
        store_(config_["dataDir"], true, "", config_.at("historyStorage")), projects_(config_),
        file_store_(config_["dataDir"], false), files_(file_store_), retry_(io_), maintenance_(io_),
        event_timer_(io_), history_retry_(io_), signals_(io_, SIGINT, SIGTERM) {}
  bool remote_restart() const { return remote_restart_; }
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
      config_["projects"] = projects_.list().at("projects");
      project_control_ = std::make_unique<ProjectControl>(io_, config_, [this](Json d) {
        if (d.contains("requestId") && !d.contains("revision"))
          d["revision"] = projects_.list().at("revision");
        return manage_projects(d);
      });
      wait_signal();
      updater_.request();
      check_update();
      connect();
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
      if (update_restart_ || remote_restart_)
        asio::post(relay_io_, [this] { relay_io_.stop(); });
      relay_work_.reset();
    });
  }
  void wait_signal() {
#ifndef _WIN32
    signals_.add(SIGUSR1);
#endif
    signals_.async_wait([this](auto ec, int signal) {
      if (ec)
        return;
#ifndef _WIN32
      if (signal == SIGUSR1) {
        attempts_ = 0;
        retry_.cancel();
        asio::post(relay_io_, [this] {
          if (socket_)
            socket_->close();
          asio::post(io_, [this] {
            retry_.cancel();
            attempts_ = 0;
            connect();
          });
        });
        wait_signal();
        return;
      }
#endif
      close();
    });
  }
  void disconnected(unsigned code) {
    history_routes_.clear();
    history_retry_.cancel();
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
    int delay = 180000;
    if (attempts_ < 5) {
      delay = std::min(30000, 1000 * (1 << std::min(5, attempts_++)));
      unsigned char random = 0;
      RAND_bytes(&random, 1);
      delay = delay * (0.8 + random / 255.0 * 0.4);
    } else {
      std::cerr << "Reconnect budget exhausted; next attempt in 180 seconds\n";
    }
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
      socket_ = connect_socket(
          relay_io_, relay_url(config_["relayUrl"]), config_["token"],
          [this](Json d) {
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
      socket_->keepalive();
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
  void delivery_reply(const std::string &id, const Json &context, const Json &payload) {
    const auto stream = context.at("stream").get<std::string>();
    const auto seq = context.at("seq").get<int64_t>();
    store_.delivery_finish(stream, seq, payload);
    const auto record = store_.delivery_record(stream, seq);
    if (record.at("resultBody").is_null())
      return;
    auto rt = runtimes_.find(id);
    if (rt == runtimes_.end())
      return;
    send({{"type", "notice"},
          {"sessionId", id},
          {"epoch", context.at("epoch")},
          {"payload",
           {{"type", "delivery-result"},
            {"stream", stream},
            {"lane", context.at("lane")},
            {"seq", seq},
            {"resultStream", record.at("resultStream")},
            {"resultSeq", record.at("resultSeq")},
            {"resultEnd", record.at("resultEnd")},
            {"resultBody", record.at("resultBody")},
            {"resultDigest", record.at("resultDigest")},
            {"heads", store_.delivery_heads(id)},
            {"window", store_.delivery_window(stream)}}}});
  }
  bool remember_approval(const std::shared_ptr<Runtime> &rt, const std::string &key,
                         const Json &rpc, bool unsupported = false,
                         std::shared_ptr<void> reservation = {}) {
    if (key.size() > 521)
      throw Error("INVALID_REQUEST", "Approval identity exceeds its budget");
    const auto found = rt->approvals.find(key);
    if (found != rt->approvals.end()) {
      if (found->second.rpc != rpc)
        throw Error("IDEMPOTENCY_CONFLICT", "Server reused an unresolved approval ID");
      return false;
    }
    if (!reservation)
      reservation = reserve_approval(rt->resources, rpc);
    Approval approval{rpc, now(), false, unsupported};
    approval.reservation = std::move(reservation);
    rt->approvals.emplace(key, std::move(approval));
    return true;
  }
  void discard_finished_commands(const std::string &id, const std::shared_ptr<Runtime> &rt) {
    for (auto queued = rt->commands.begin(); queued != rt->commands.end();) {
      const auto &context = queued->frame.at("delivery");
      if (context.is_null()) {
        ++queued;
        continue;
      }
      const auto record = store_.delivery_record(context.at("stream"), context.at("seq"));
      if (record.is_null() || record.at("phase") != "finished") {
        ++queued;
        continue;
      }
      rt->deliveries.erase(queued->frame.at("payload").value("requestId", ""));
      delivery_reply(id, context, record.at("result"));
      queued = rt->commands.erase(queued);
    }
  }
  void prune_result_routes() {
    for (const auto &[id, rt] : runtimes_) {
      std::set<std::string> executing;
      for (const auto &[key, context] : rt->deliveries)
        executing.insert(context.at("stream").get<std::string>());
      for (auto route = rt->result_routes.begin(); route != rt->result_routes.end();) {
        if (route->second.at("epoch") != rt->epoch ||
            (!executing.count(route->first) && !store_.delivery_result_pending(route->first)))
          route = rt->result_routes.erase(route);
        else
          ++route;
      }
    }
  }
  Json runtime_usage() {
    auto result = RuntimeResources::usage();
    size_t routes = 0, route_bytes = 0;
    for (const auto &[id, rt] : runtimes_)
      for (const auto &[stream, context] : rt->result_routes) {
        ++routes;
        route_bytes += stream.size() + context.dump().size() + 1024;
      }
    result["resultRoutes"] = {{"records", routes}, {"bytes", route_bytes}};
    return result;
  }
  void notice(const std::string &id, const Json &p) {
    auto r = runtimes_.find(id);
    if (r != runtimes_.end() && p.contains("requestId") && p["requestId"].is_string() &&
        (p.value("type", "") == "ack" || p.value("type", "") == "error")) {
      auto found = r->second->deliveries.find(p["requestId"].get<std::string>());
      if (found != r->second->deliveries.end()) {
        auto context = found->second;
        r->second->deliveries.erase(found);
        delivery_reply(id, context, p);
        return;
      }
    }
    if (r != runtimes_.end())
      send({{"type", "notice"},
            {"sessionId", id},
            {"epoch", r->second->epoch},
            {"heads", store_.delivery_heads(id)},
            {"payload", p}});
  }
  void history_schedule() {
    history_retry_.cancel();
    int64_t earliest = 0;
    for (const auto &[key, route] : history_routes_) {
      const auto due = route.value("retryAt", int64_t(0));
      if (due && (!earliest || due < earliest))
        earliest = due;
    }
    if (!earliest || stopped_)
      return;
    history_retry_.expires_after(std::chrono::milliseconds(std::max(int64_t(1), earliest - now())));
    history_retry_.async_wait([this](auto ec) {
      if (ec || stopped_)
        return;
      try {
        for (auto &[key, route] : history_routes_) {
          const auto due = route.value("retryAt", int64_t(0));
          if (due && due <= now())
            history_notify(route);
        }
        history_schedule();
      } catch (const std::exception &error) {
        std::cerr << Json{{"event", "history_retry_failure"}, {"error", error_data(error)}}.dump()
                  << '\n';
        close();
      }
    });
  }
  void history_notify(Json &route) {
    if (route.value("retryAt", int64_t(0)) > now())
      return;
    auto state = store_.history_hint(route);
    if (state.at("maxRevision") <= state.at("receivedRevision")) {
      route.erase("retryAt");
      route["attempts"] = 0;
      return;
    }
    state["type"] = "history-dirty";
    send({{"type", "history-notice"},
          {"sessionId", route.at("sessionId")},
          {"route", route.at("route")},
          {"payload", state}});
    const auto attempt = route.value("attempts", 0);
    route["retryAt"] = now() + recovery_delay(attempt);
    route["attempts"] = std::min(attempt + 1, 3);
  }
  void publish(const std::string &id, const Json &event) {
    auto r = runtimes_.find(id);
    if (r != runtimes_.end()) {
      const auto previous = r->second->published_revision;
      const auto maximum = std::max(previous, event.value("revision", event["seq"].get<int64_t>()));
      r->second->published_revision = maximum;
      send({{"type", "event"},
            {"sessionId", id},
            {"epoch", r->second->epoch},
            {"payload",
             {{"type", "event"},
              {"event", event},
              {"previousRevision", previous},
              {"maxRevision", maximum}}}});
    }
    for (auto &[route, subscription] : history_routes_)
      if (subscription.at("sessionId") == id)
        history_notify(subscription);
    history_schedule();
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
  Json emit(const std::string &id, const std::string &type, const Json &data) {
    const bool delta = type == "item/agentMessage/delta" ||
                       type == "item/commandExecution/outputDelta" ||
                       type == "item/fileChange/outputDelta";
    auto safe = redact(data);
    if (!delta) {
      flush_events();
      auto event = store_.event(id, type, safe);
      publish(id, event);
      return event;
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
    return nullptr;
  }
  Json manage_projects(const Json &d, const std::string &owner = "local") {
    if (stopped_)
      throw Error("HOST_OFFLINE", "Agent is stopping");
    auto result = projects_.request(
        d,
        [this](const std::string &id) {
          if (file_requests_ || listing_threads_ || history_readers_ || !archive_loading_.empty())
            return true;
          for (const auto &s : store_.sessions(true))
            if (s.at("projectId") == id && runtimes_.count(s.at("id").get<std::string>()))
              return true;
          return false;
        },
        owner);
    config_["projects"] = projects_.list().at("projects");
    if (d.contains("requestId"))
      send({{"type", "projects-changed"}});
    return result;
  }
  Json project(const std::string &id) {
    for (auto &p : config_["projects"])
      if (p["id"] == id) {
        auto path = p["path"].get<std::string>();
        std::error_code ec;
        const auto real = std::filesystem::canonical(std::filesystem::u8path(path), ec);
        if (ec || !std::filesystem::is_directory(real, ec) || ec)
          throw Error("PROJECT_UNAVAILABLE", "Project directory is unavailable");
        if (real.u8string() != path)
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
    if (type == "history-detached") {
      history_routes_.erase(d.value("route", ""));
      history_schedule();
      return;
    }
    if (type == "management-request") {
      Json reply = {{"type", "management-result"}, {"wire", d.value("wire", "")}};
      bool restart = false;
      try {
        reply["result"] = remote_config_.request(
            d.at("data"), !runtimes_.empty() || file_requests_ || listing_threads_, restart);
      } catch (const std::exception &error) {
        reply["error"] = error_data(error);
      }
      send(reply);
      if (restart) {
        remote_restart_ = true;
        remote_restart_timer_.expires_after(std::chrono::seconds(2));
        remote_restart_timer_.async_wait([this](auto ec) {
          if (!ec)
            close();
        });
      }
      return;
    }
    if (type == "hello") {
      if (d.value("minProtocol", 1) > 1 || d.value("demand", 0) != 1 ||
          d.value("delivery", 0) != 2) {
        std::cerr << "Relay does not support demand-v1; upgrade the Relay before this Agent\n";
        close();
        return;
      }
      Json capabilities = {{"type", "capabilities"},
                           {"build", Json::parse(COC_BUILD_JSON)},
                           {"protocol", 1},
                           {"delivery", 2},
                           {"deliveryInstance", store_.delivery_instance()},
                           {"management", remote_config_.metadata()}};
      if (config_.contains("wakeUrl"))
        capabilities["wakeUrl"] = config_["wakeUrl"];
      const auto latest = read_json(config_file_);
      if (latest.contains("adminEmail"))
        capabilities["adminEmail"] = latest["adminEmail"];
      if (latest.contains("accessEmails"))
        capabilities["accessEmails"] = access_emails(latest["accessEmails"]);
      if (config_.contains("displayName"))
        capabilities["displayName"] = config_["displayName"];
      send(capabilities);
      attempts_ = 0;
      check_client_requests();
      if (negotiated_)
        updater_.request();
      negotiated_ = true;
      check_update();
      std::cout << "Agent connected: "
                << config_.value("displayName", config_.at("hostId").get<std::string>()) << "\n"
                << std::flush;
      return;
    }
    if (type == "change") {
      if (d.value("scope", "") == "requests")
        check_client_requests();
      if (d.value("scope", "") == "release") {
        const auto version = d.value("version", "");
        if (!version.empty() && store_.cache_get("announced-release") != version) {
          store_.cache_put("announced-release", version);
          updater_.request();
          check_update();
        }
      }
      return;
    }
    if (type == "control") {
      const auto request = d.at("requestId");
      const auto action = d.value("action", "");
      const auto args = d.value("data", Json::object());
      auto respond = [this, request, action, started = now(),
                      session_id = args.value("sessionId", "")](Json envelope, Json receipt) {
        const auto error = envelope.value("error", Json());
        std::cerr << Json{{"event", "control_result"},
                          {"requestId", request},
                          {"action", action},
                          {"durationMs", now() - started},
                          {"errorCode", error.is_null() ? Json() : error.value("code", Json())}}
                         .dump()
                  << '\n';
        Json result = {{"type", "result"}, {"requestId", request}};
        result.update(envelope);
        if (!receipt.is_null())
          result["intent"] = receipt;
        if (!session_id.empty() && action != "history")
          result["heads"] = store_.delivery_heads(session_id);
        if (result.dump().size() > max_frame)
          result = {{"type", "result"},
                    {"requestId", request},
                    {"error",
                     {{"code", "MESSAGE_TOO_LARGE"},
                      {"message", "Control result exceeds frame budget"}}}};
        send(result);
      };
      std::string operation_key;
      Json intent;
      try {
        const bool write = operation_write(action, args);
        if (write && !d.contains("intent"))
          throw Error("UPGRADE_REQUIRED", "Write commands require a persisted original operation");
        if (d.contains("intent")) {
          intent = operation_intent(d.at("intent"));
          if (!write)
            throw Error("INVALID_REQUEST", "Original operation identity requires a write command");
          if (intent.value("ack", false)) {
            respond({{"data", store_.operation_ack(intent, action, args)}}, intent);
            return;
          }
          const auto original = store_.operation_begin(intent, action, args);
          if (original.contains("result")) {
            respond(original.at("result"), intent);
            return;
          }
          if (original.at("state") != "new")
            throw Error("RESULT_PENDING", "Original operation is still executing");
          operation_key = original.at("key");
        }
        control(
            action, args,
            [this, operation_key, intent, respond](Json data, Json error) {
              Json envelope = error.is_null() ? Json{{"data", data}} : Json{{"error", error}};
              if (!operation_key.empty()) {
                try {
                  envelope = store_.operation_finish(operation_key, envelope);
                } catch (const std::exception &failure) {
                  // A response without the receipt is not a durable terminal result.
                  respond({{"error", error_data(failure)}}, nullptr);
                  return;
                }
              }
              respond(envelope, intent);
            },
            intent.is_null() ? "" : intent.at("owner").get<std::string>(), operation_key);
      } catch (const std::exception &e) {
        auto error = error_data(e);
        Json envelope = {{"error", error}};
        if (!operation_key.empty()) {
          try {
            envelope = store_.operation_finish(operation_key, envelope);
          } catch (const std::exception &failure) {
            respond({{"error", error_data(failure)}}, nullptr);
            return;
          }
          respond(envelope, intent);
        } else
          respond(envelope, nullptr);
      }
      return;
    }
    auto id = d.value("sessionId", "");
    if (type == "delivery-receipt") {
      const auto stream = d.at("stream").get<std::string>();
      store_.delivery_scope(stream, id);
      store_.delivery_verify(stream, d);
      if (d.at("instance") != store_.delivery_instance() ||
          store_.get(id).at("mode") != d.at("mode"))
        throw Error("FORBIDDEN", "Wrong result receipt scope");
      store_.delivery_result_ack(stream, d.at("received"), d.at("receivedBytes"));
      prune_result_routes();
      return;
    }
    auto it = runtimes_.find(id);
    if (it == runtimes_.end())
      return;
    auto rt = it->second;
    const auto incoming_epoch = d.value("epoch", int64_t(-1));
    if (rt->epoch != incoming_epoch)
      return;
    if (type == "delivery-output") {
      try {
        const auto received = d.at("received").get<int64_t>();
        const auto credit = d.at("credit").get<int64_t>();
        const auto byte_credit = d.at("byteCredit").get<int64_t>();
        const auto stream = "rpc-output:" + id;
        auto state = store_.output_state(stream);
        if (credit < received || credit - received > 100 || credit > 9007199254740991LL)
          throw Error("INVALID_REQUEST", "Invalid output credit");
        if (d.value("replay", false) && received < state.at("acked").get<int64_t>())
          throw Error("DELIVERY_STATE_MISMATCH", "Receiver lost acknowledged output state");
        store_.output_ack(stream, received, byte_credit);
        state = store_.output_state(stream);
        rt->rpc_delivery = true;
        rt->rpc_credit = std::max(rt->rpc_credit, credit);
        rt->rpc_byte_credit = std::max(rt->rpc_byte_credit, byte_credit);
        if (d.value("replay", false))
          rt->rpc_sent = state.at("acked");
        flush_rpc_output(id, rt);
      } catch (const std::exception &error) {
        notice(id, {{"type", "delivery-rejected"}, {"error", error_data(error)}});
      }
      return;
    }
    if (type == "web" || type == "rpc") {
      const auto payload = type == "web" ? web_command(d.at("payload")) : d.at("payload");
      const auto action = payload.value("action", "");
      const auto lane = type == "rpc" ? rpc_delivery_lane(payload)
                                      : (action == "sync" || action == "models" ? ""
                                         : action == "approval" || action == "interrupt" ||
                                                 action == "autoApproval"
                                             ? "priority"
                                             : "normal");
      if (!lane.empty() && !d.contains("delivery")) {
        notice(id, {{"type", "error"},
                    {"requestId", payload.value("requestId", Json())},
                    {"error",
                     {{"code", "UPGRADE_REQUIRED"},
                      {"message", "Writes require the delivery:2 command window"}}}});
        return;
      }
      if (d.contains("delivery") && d.at("delivery").at("lane") != lane)
        throw Error("INVALID_REQUEST", "Command must use its original delivery lane");
    }
    Json delivery;
    if (d.contains("delivery")) {
      delivery = d.at("delivery");
      const auto stream = delivery.at("stream").get<std::string>();
      const auto body = delivery.at("body").get<std::string>();
      if (Json::parse(body) != d.at("payload"))
        throw Error("IDEMPOTENCY_CONFLICT", "Delivery body does not match forwarded command");
      Json accepted;
      try {
        store_.delivery_scope(stream, id);
        store_.delivery_verify(stream, delivery);
        accepted = store_.delivery_receive(stream, delivery.at("seq"), delivery.at("end"), body);
      } catch (const std::exception &error) {
        const auto info = error_data(error);
        if (info["code"] == "DELIVERY_GAP" || info["code"] == "BACKPRESSURE") {
          notice(id, {{"type", "delivery-window"},
                      {"lane", delivery.at("lane")},
                      {"window", store_.delivery_window(stream)}});
        } else {
          notice(id, {{"type", "delivery-rejected"},
                      {"lane", delivery.at("lane")},
                      {"seq", delivery.at("seq")},
                      {"error", info}});
        }
        return;
      }
      delivery.erase("body"); // The durable command owns the body, not its retry routes.
      delivery["epoch"] = incoming_epoch;
      if (!rt->result_routes.count(stream))
        prune_result_routes();
      rt->result_routes[stream] = delivery;
      notice(id, {{"type", "delivery-window"},
                  {"lane", delivery.at("lane")},
                  {"window", accepted.at("window")}});
      if (accepted.at("accepted") == false ||
          (accepted.contains("record") && !accepted.at("record").is_null() &&
           accepted.at("record").at("phase") == "finished")) {
        const auto record = accepted.at("record");
        if (record.at("phase") == "finished")
          delivery_reply(id, delivery, record.at("result"));
        return;
      }
      const auto payload = d.at("payload");
      const auto key = type == "web" ? payload.at("requestId").get<std::string>()
                                     : (payload.contains("id") && payload.contains("method")
                                            ? "rpc:" + payload.at("id").dump()
                                            : "");
      if (!key.empty()) {
        if (rt->deliveries.count(key)) {
          delivery_reply(
              id, delivery,
              {{"error",
                {{"code", "IDEMPOTENCY_CONFLICT"},
                 {"message", "Request identity is already executing in another delivery slot"}}}});
          return;
        }
        rt->deliveries[key] = delivery;
      }
    }
    if (type == "detach")
      rt->detached = now();
    else if (type == "rpc") {
      if (!delivery.is_null() && delivery.at("lane") == "normal" && rt->cli_delivery_stream.empty())
        rt->cli_delivery_stream = delivery.at("stream").get<std::string>();
      if (!delivery.is_null() && !store_.delivery_start(delivery.at("stream"), delivery.at("seq")))
        return;
      const bool one_way = !d.at("payload").contains("id") || !d.at("payload").contains("method");
      if (one_way)
        rt->immediate_delivery = delivery;
      if (!delivery.is_null())
        rt->rpc_delivery = true;
      cli(id, d.at("payload"));
      rt->immediate_delivery = nullptr;
      if (!delivery.is_null() &&
          (!d.at("payload").contains("id") || !d.at("payload").contains("method"))) {
        delivery_reply(id, delivery, nullptr);
      }
    } else if (type == "web") {
      const auto payload = d.at("payload");
      const auto action = payload.value("action", "");
      if (action == "interrupt" || action == "approval" || action == "autoApproval") {
        std::shared_ptr<void> reservation;
        try {
          reservation =
              rt->resources->reserve(RuntimeResource::priority, 8 * payload.dump().size() + 16384);
        } catch (const std::exception &error) {
          notice(id, {{"type", "error"},
                      {"requestId", payload.value("requestId", Json())},
                      {"error", error_data(error)}});
          return;
        }
        if (!delivery.is_null() &&
            !store_.delivery_start(delivery.at("stream"), delivery.at("seq")))
          return;
        const auto complete = [this, id, payload, reservation](Json, Json error) {
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
      try {
        auto reservation =
            rt->resources->reserve(RuntimeResource::command, 8 * payload.dump().size() + 16384);
        rt->commands.push_back(
            {{{"epoch", rt->epoch}, {"payload", payload}, {"delivery", delivery}},
             std::move(reservation)});
      } catch (const std::exception &error) {
        notice(id, {{"type", "error"},
                    {"requestId", payload.value("requestId", Json())},
                    {"error", error_data(error)}});
        return;
      }
      drain(id, rt);
    }
  }
  void control(const std::string &action, const Json &d, Completion done,
               const std::string &owner = "", const std::string &operation_key = "") {
    if (action == "delivery") {
      const auto id = d.at("sessionId").get<std::string>();
      const auto session = store_.get(id);
      if (session.at("mode") != d.at("mode"))
        throw Error("FORBIDDEN", "Wrong delivery session mode");
      const auto stream = d.at("stream").get<std::string>();
      const bool priority = d.at("lane") == "priority";
      if (d.contains("instance") && d.at("instance") != store_.delivery_instance())
        throw Error("DELIVERY_STATE_MISMATCH", "Agent result storage instance changed");
      if (!d.contains("exchangeId") || d.contains("seq") || d.contains("contentSeq") ||
          d.contains("streamSerial") || d.contains("creditGeneration"))
        store_.delivery_verify(stream, d);
      else if (d.value("resultReceived", int64_t(0)) != 0 ||
               d.value("resultBytes", int64_t(0)) != 0)
        throw Error("INVALID_REQUEST",
                    "Result acknowledgement requires the original credit allocation");
      Json control_ready;
      if (d.contains("exchangeId") && d.contains("control")) {
        const auto &proof = d.at("control");
        control_ready = store_.control_apply(id, proof.at("controlEpoch"), proof.at("controlId"),
                                             proof.at("owner"));
        control_ready["connectionGeneration"] = proof.at("connectionGeneration");
        control_ready["exchangeId"] = d.at("exchangeId");
        auto runtime = runtimes_.find(id);
        if (runtime != runtimes_.end()) {
          auto rt = runtime->second;
          const auto generation = proof.at("connectionGeneration").get<int64_t>();
          if (generation < rt->epoch)
            throw Error("STALE_CONTROLLER", "Connection generation has already advanced");
          for (auto queued = rt->commands.begin(); queued != rt->commands.end();) {
            const auto context = queued->frame.value("delivery", Json());
            const bool retired =
                context.is_null()
                    ? queued->frame.at("epoch") != generation
                    : store_.delivery_record(context.at("stream"), context.at("seq")).at("phase") ==
                          "finished";
            if (retired)
              queued = rt->commands.erase(queued);
            else
              ++queued;
          }
          for (auto entry = rt->deliveries.begin(); entry != rt->deliveries.end();) {
            const auto &context = entry->second;
            if (store_.delivery_record(context.at("stream"), context.at("seq")).at("phase") ==
                "finished")
              entry = rt->deliveries.erase(entry);
            else
              ++entry;
          }
          if (generation != rt->epoch) {
            rt->epoch = generation;
            rt->pending_epoch = 0;
            rt->detached = 0;
            rt->rpc_credit = 0;
            rt->rpc_byte_credit = 0;
            rt->rpc_sent = store_.output_state("rpc-output:" + id).at("acked");
          }
        }
      }
      auto window = store_.delivery_open(stream, id, priority ? 4 : 16,
                                         priority ? 512 * 1024 : 2 * 1024 * 1024,
                                         priority ? "priority" : "normal");
      if (!control_ready.is_null()) {
        store_.delivery_bind(stream, control_ready.at("controlEpoch"),
                             control_ready.at("controlId"));
        auto runtime = runtimes_.find(id);
        if (!priority && session.at("mode") == "cli" && runtime != runtimes_.end() &&
            runtime->second->cli_delivery_stream.empty())
          runtime->second->cli_delivery_stream = stream;
      }
      Json results;
      if (d.contains("resultReceived")) {
        // Read once: this also rejects a recovery snapshot behind the durable ACK.
        // The ACK below only reclaims the prefix, never this suffix page.
        results = store_.delivery_results(stream, d.at("resultReceived"));
        store_.delivery_result_ack(stream, d.at("resultReceived"), d.at("resultBytes"));
        window = store_.delivery_window(stream);
      }
      Json result = {{"window", window}, {"heads", store_.delivery_heads(id)}};
      if (!control_ready.is_null())
        result["controlReady"] = control_ready;
      if (d.contains("contentSeq")) {
        result["content"] =
            store_.delivery_content(stream, d.at("contentSeq"), d.value("offset", int64_t(0)));
        done(result, nullptr);
        return;
      }
      if (d.contains("resultReceived"))
        result["results"] = std::move(results);
      if (d.contains("exchangeId"))
        result["exchangeId"] = d.at("exchangeId");
      if (d.contains("seq")) {
        auto record = store_.delivery_record(stream, d.at("seq"));
        if (record.is_object()) {
          record.erase("body");
          record.erase("result");
          // One body per frame; the completion page already carries this terminal record.
          if (!result.value("results", Json::array()).empty())
            record = nullptr;
        }
        result["record"] = record;
      }
      prune_result_routes();
      done(result, nullptr);
      return;
    }
    if (action == "probe") {
      done({{"online", true},
            {"confirmedAt", now()},
            {"deliveryInstance", store_.delivery_instance()},
            {"runtimeResources", runtime_usage()}},
           nullptr);
      return;
    }
    if (action == "snapshot") {
      const auto id = d.at("sessionId").get<std::string>();
      auto session = store_.get(id);
      if (session.at("mode") != d.at("mode"))
        throw Error("FORBIDDEN", "Wrong snapshot session mode");
      Json approvals = Json::array();
      const auto runtime = runtimes_.find(id);
      if (runtime != runtimes_.end())
        for (const auto &[key, approval] : runtime->second->approvals)
          approvals.push_back({{"approvalId", key},
                               {"runtimeId", runtime->second->runtime_id},
                               {"approvalVersion", approval.version},
                               {"method", approval.rpc.at("method")},
                               {"params", redact(approval.rpc.value("params", Json::object()))},
                               {"submitted", approval.submitted},
                               {"unsupported", approval.unsupported}});
      Json history = {{"sessionId", id}, {"operation", "page"}};
      if (d.contains("after"))
        history["after"] = d.at("after");
      control("history", history, [session, approvals, done](Json page, Json error) {
        done({{"session", session}, {"approvals", approvals}, {"history", page}}, error);
      });
      return;
    }
    if (action == "history") {
      auto id = d.at("sessionId").get<std::string>();
      auto s = store_.get(id);
      const auto operation = d.value("operation", "page");
      if (operation == "subscribe" || operation == "ack" || operation == "retire") {
        const auto route = d.value("route", "");
        if (!valid_id(route))
          throw Error("INVALID_REQUEST", "History route is required");
        if (operation == "subscribe" && !history_routes_.count(route) &&
            history_routes_.size() >= 128)
          throw Error("BACKPRESSURE", "Online history subscription budget exhausted");
        if (operation != "subscribe") {
          const auto current = history_routes_.find(route);
          if (current == history_routes_.end() ||
              current->second.at("exchangeId") != d.at("exchangeId") ||
              current->second.at("stream") != d.at("stream") ||
              current->second.at("owner") != d.at("owner"))
            throw Error("DELIVERY_STATE_MISMATCH", "History acknowledgement route has retired");
        }
        auto state = store_.history_subscription(d);
        if (operation == "retire") {
          for (auto current = history_routes_.begin(); current != history_routes_.end();) {
            const auto &saved = current->second;
            if (saved.at("sessionId") == d.at("sessionId") && saved.at("owner") == d.at("owner") &&
                saved.at("stream") == d.at("stream") && saved.at("instance") == d.at("instance"))
              current = history_routes_.erase(current);
            else
              ++current;
          }
        } else
          history_routes_[route] = d;
        done(state, nullptr);
        if (operation != "retire")
          history_notify(history_routes_.at(route));
        history_schedule();
        return;
      }
      if (d.value("operation", "page") == "content") {
        if (d.contains("reference")) {
          const auto reference = history_reference_descriptor(d.at("reference"));
          if (d.at("seq") != reference.at("seq") ||
              (d.contains("revision") && d.at("revision") != reference.at("revision")))
            throw Error("INVALID_REQUEST", "History query must match its immutable reference");
          read_history_content(id, d, done);
        } else {
          read_history_content(id, d, done);
        }
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
      validate_workspace_upload(d, store_.delivery_instance());
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
    if (action == "projectManage") {
      done(manage_projects(d, owner), nullptr);
      return;
    }
    if (action == "projects") {
      done(projects_.list().at("projects"), nullptr);
      return;
    }
    if (action == "threads") {
      auto p = project(d.at("projectId"));
      if (listing_threads_)
        throw Error("BACKPRESSURE", "History query already in progress");
      auto ignore_message = [](Json) {};
      auto process = std::make_shared<CodexProcess>(
          io_, config_, p["path"], ignore_message, [] {}, CodexProcessRole::reader);
      listing_threads_ = true;
      try {
        process->start();
      } catch (...) {
        listing_threads_ = false;
        process->close();
        throw;
      }
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
      for (auto &session : page["data"])
        session["heads"] = store_.delivery_heads(session.at("id"));
      done(d.value("paged", false) ? page : page["data"], nullptr);
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
    if (action == "approvals" || action == "answer") {
      const auto s = store_.get(d.at("sessionId"));
      if (s["mode"] != d.at("mode"))
        throw Error("FORBIDDEN", "Wrong credential for session mode");
      auto rt = runtimes_.find(s.at("id"));
      if (action == "answer") {
        auto command = web_command({{"action", "approval"},
                                    {"requestId", d.at("requestId")},
                                    {"approvalId", d.at("approvalId")},
                                    {"runtimeId", d.at("runtimeId")},
                                    {"approvalVersion", d.at("approvalVersion")},
                                    {"allow", d.at("allow")}});
        command["internal"] = true;
        external_answer(s.at("id"), command, done);
        return;
      }
      Json pending = Json::array();
      if (rt != runtimes_.end())
        for (auto &[key, approval] : rt->second->approvals)
          pending.push_back({{"approvalId", key},
                             {"runtimeId", rt->second->runtime_id},
                             {"approvalVersion", approval.version},
                             {"method", approval.rpc.at("method")},
                             {"params", redact(approval.rpc.value("params", Json::object()))},
                             {"submitted", approval.submitted},
                             {"unsupported", approval.unsupported}});
      done({{"forwarding", s.value("approvalForwarding", false)}, {"data", pending}}, nullptr);
      return;
    }
    if (action == "queue") {
      auto s = store_.get(d.at("sessionId"));
      if (s["mode"] != d.at("mode"))
        throw Error("FORBIDDEN", "Wrong credential for session mode");
      auto command = web_command(
          {{"action", "prompt"}, {"requestId", d.at("requestId")}, {"text", d.at("text")}});
      command["internal"] = true;
      queue_external(s.at("id"), command, done);
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
      if (s["mode"] == "cli" && r->epoch > 0 &&
          (r->cli_delivery_stream.empty() ||
           d.value("deliveryResume", "") != r->cli_delivery_stream))
        throw Error("CLI_REATTACH_UNSUPPORTED", "End this CLI session and create a new one");
      // Preparation cannot grant business admission. A proof-bearing OPEN applies
      // the durable control epoch before this connection may dispatch commands.
      r->pending_epoch = d.at("epoch");
      r->pending_expires = d.value("expires", now() + 15000);
      done({{"ok", true}}, nullptr);
      return;
    }
    if (action != "create")
      throw Error("UNSUPPORTED_ACTION", "Unknown control action");
    auto p = project(d.at("projectId"));
    if (d.at("mode") != "cli" && d.at("mode") != "web")
      throw Error("INVALID_REQUEST", "Invalid session mode");
    if (d.contains("threadId")) {
      if ((d.at("mode") != "web" && !d.value("external", false)) || !d.at("threadId").is_string() ||
          !valid_id(d.at("threadId").get<std::string>()))
        throw Error("INVALID_REQUEST", "Invalid history thread");
      for (auto &o : store_.sessions(true))
        if (o.value("threadId", Json()) == d.at("threadId") && o["state"] == "ready")
          throw Error("SESSION_BUSY", "Thread already has an active session");
    }
    if (d.value("external", false) && !d.contains("threadId"))
      throw Error("INVALID_REQUEST", "External sessions require a threadId");
    Json s = {
        {"id", config_["hostId"].get<std::string>() + "~" + uuid()},
        {"projectId", d.at("projectId")},
        {"mode", d.at("mode")},
        {"sandbox", config_["sandbox"]},
        {"state", d.at("mode") == "cli" && !d.value("external", false) ? "ready" : "starting"},
        {"running", false},
        {"autoApproval", false},
        {"createdAt", now()}};
    if (d.contains("threadId"))
      s["threadId"] = d.at("threadId");
    auto id = s["id"].get<std::string>();
    auto rt = std::make_shared<Runtime>();
    bool session_saved = false;
    try {
      rt->process = std::make_shared<CodexProcess>(
          io_, config_, p["path"], [this, id](Json m) { on_codex(id, m); },
          [this, id] { on_exit(id); });
      store_.operation_session(operation_key, s);
      session_saved = true;
      runtimes_[id] = rt;
      rt->process->start();
    } catch (const std::exception &error) {
      if (runtimes_.erase(id))
        rt->process->close();
      if (session_saved && error_data(error).value("code", "") != "BACKPRESSURE") {
        s["state"] = "failed";
        store_.save(s);
      }
      throw;
    }
    if (s["mode"] == "cli" && !d.value("external", false)) {
      done(s, nullptr);
      return;
    }
    rt->process->initialize([this, id, rt, d, done](Json, Json error) {
      if (!error.is_null()) {
        stop(id);
        done(nullptr, error);
        return;
      }
      auto s = store_.get(id);
      if (d.value("external", false)) {
        observe_external(id, rt, done);
        return;
      }
      auto launch = [this, id, rt, d, done]() {
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
                             [this, id, rt, d, done](Json result, Json error) {
                               if (!error.is_null()) {
                                 if (d.contains("threadId") && active_writer_error(error)) {
                                   observe_external(id, rt, done);
                                   return;
                                 }
                                 stop(id);
                                 done(nullptr, error);
                                 return;
                               }
                               auto current = store_.get(id);
                               current["threadId"] = result.at("thread").at("id");
                               current["historyMode"] =
                                   result.at("thread").value("historyMode", "paginated");
                               store_.save(current);
                               if (d.contains("threadId")) {
                                 current["archiveDone"] = false;
                                 current["archiveCursor"] = nullptr;
                                 store_.save(current);
                                 load_archive(id, [this, id, done](Json, Json error) {
                                   if (!error.is_null()) {
                                     stop(id);
                                     done(nullptr, error);
                                     return;
                                   }
                                   auto current = store_.get(id);
                                   current["state"] = "ready";
                                   store_.save(current);
                                   done(current, nullptr);
                                 });
                               } else {
                                 current["state"] = "ready";
                                 store_.save(current);
                                 done(current, nullptr);
                               }
                             });
      };
      if (!d.contains("threadId")) {
        launch();
        return;
      }
      rt->process->request("thread/read", {{"threadId", d.at("threadId")}, {"includeTurns", false}},
                           [this, id, s, launch, done](Json result, Json error) {
                             if (!error.is_null()) {
                               stop(id);
                               done(nullptr, error);
                               return;
                             }
                             if (!same_project_path(result.at("thread").value("cwd", ""),
                                                    project(s["projectId"])["path"])) {
                               stop(id);
                               done(nullptr, {{"code", "FORBIDDEN"},
                                              {"message", "Thread belongs to another project"}});
                               return;
                             }
                             launch();
                           });
    });
  }
  void observe_external(const std::string &id, std::shared_ptr<Runtime> rt, Completion done) {
    auto s = store_.get(id);
    s["external"] = true;
    s["queueEnabled"] =
        config_.value("externalSessions", Json::object()).value("allowQueue", false) &&
        config_["sandbox"] == "workspace-write";
    s["approvalConfigured"] = config_["externalSessions"].value("allowApprovals", false) &&
                              config_["sandbox"] == "workspace-write";
    s["approvalForwarding"] = false;
    s["externalStatus"] = "unknown";
    s["externalSeeded"] = false;
    store_.save(s);
    rt->reader = std::make_shared<ExternalThread>(
        io_, rt->process, s.at("threadId"), project(s["projectId"])["path"],
        [this, id](std::string turn, Json item, bool historical) {
          if (!runtimes_.count(id) || stopped_)
            return;
          const auto state = store_.get(id).value("state", "");
          if (state != "ready" && state != "starting")
            return;
          auto event = store_.external_item(id, turn, std::move(item), historical);
          if (!event.is_null())
            publish(id, event);
        },
        [this, id](Json metadata) {
          if (!runtimes_.count(id) || stopped_)
            return;
          auto s = store_.get(id);
          if (s["state"] != "ready" && s["state"] != "starting")
            return;
          if (metadata.contains("seed")) {
            if (!s.value("externalSeeded", false) && metadata["seed"].value("seeded", false)) {
              s["externalSeeded"] = true;
              s["archiveCursor"] = metadata["seed"]["archiveCursor"];
              s["archiveDone"] = s["archiveCursor"].is_null();
              s["historyMode"] = metadata["seed"]["historyMode"];
              store_.save(s);
            }
          } else if (s.value("running", false) != metadata.value("running", false) ||
                     s.value("externalStatus", "unknown") !=
                         metadata.value("externalStatus", "unknown")) {
            s["running"] = metadata["running"];
            s["externalStatus"] = metadata["externalStatus"];
            store_.save(s);
            emit(id, "externalState",
                 {{"running", s["running"]}, {"externalStatus", s["externalStatus"]}});
          }
        },
        [this, id](Json error) {
          auto it = runtimes_.find(id);
          if (it != runtimes_.end() && it->second->observer_error != error.dump()) {
            it->second->observer_error = error.dump();
            emit(id, "warning",
                 {{"message",
                   "External history refresh failed: " + error.value("message", "Read failed")}});
          }
        });
    rt->reader->bootstrap([this, id, done](Json result, Json error) {
      if (!runtimes_.count(id) || store_.get(id)["state"] != "starting") {
        done(nullptr, {{"code", "SESSION_CLOSED"}, {"message", "Reader closed during connection"}});
        return;
      }
      if (!error.is_null()) {
        stop(id);
        done(nullptr, error);
        return;
      }
      auto s = store_.get(id);
      s["state"] = "ready";
      s["archiveCursor"] = result["archiveCursor"];
      s["archiveDone"] = s["archiveCursor"].is_null();
      s["historyMode"] = result["historyMode"];
      s["externalSeeded"] = result["seeded"];
      store_.save(s);
      done(s, nullptr);
      if (s.value("approvalConfigured", false))
        start_external_approvals(id);
    });
  }
  void start_external_approvals(const std::string &id) {
    auto rt = runtimes_.at(id);
    const auto s = store_.get(id);
    rt->external_approvals = std::make_shared<ExternalApprovals>(
        io_, config_["externalSessions"], s.at("threadId"), project(s.at("projectId")).at("path"),
        [this, id](Json approval, std::shared_ptr<void> reservation) {
          auto it = runtimes_.find(id);
          if (it == runtimes_.end() || stopped_)
            return;
          if (approval.contains("context")) {
            const auto &context = approval.at("context");
            auto event = store_.external_item(id, context.at("turnId"), context.at("item"));
            if (!event.is_null())
              publish(id, event);
            return;
          }
          const auto key = approval.at("approvalId").get<std::string>();
          if (!remember_approval(
                  it->second, key,
                  {{"method", approval.at("method")}, {"params", approval.at("params")}},
                  approval.value("unsupported", false), std::move(reservation)))
            return;
          approval["runtimeId"] = it->second->runtime_id;
          approval["approvalVersion"] = it->second->approvals.at(key).version;
          emit(id, "approval", approval);
          auto_approve(id, key);
        },
        [this, id](Json resolved) {
          auto it = runtimes_.find(id);
          if (it == runtimes_.end() || stopped_)
            return;
          it->second->approvals.erase(resolved.at("approvalId"));
          resolved["external"] = true;
          emit(id, "approvalResolved", resolved);
        },
        [this, id](bool connected, std::string message) {
          auto it = runtimes_.find(id);
          if (it == runtimes_.end() || stopped_)
            return;
          auto s = store_.get(id);
          if (s["state"] != "ready")
            return;
          s["approvalForwarding"] = connected;
          store_.save(s);
          emit(id, "externalState",
               {{"running", s.value("running", false)},
                {"externalStatus", s.value("externalStatus", "unknown")},
                {"approvalForwarding", connected}});
          if (connected) {
            std::vector<std::string> pending;
            for (const auto &[key, approval] : it->second->approvals)
              pending.push_back(key);
            for (const auto &key : pending)
              auto_approve(id, key);
          }
          if (!connected) {
            for (auto &[key, approval] : it->second->approvals)
              emit(id, "approvalResolved",
                   {{"approvalId", key},
                    {"external", true},
                    {"message", "Approval connection lost; decision unconfirmed"}});
            it->second->approvals.clear();
            if (it->second->observer_error != message) {
              it->second->observer_error = message;
              emit(id, "warning",
                   {{"message",
                     message +
                         "; remote approvals unavailable; original client remains authoritative"}});
            }
          }
        },
        rt->resources);
    rt->external_approvals->start();
  }
  void validate_approval(const std::shared_ptr<Runtime> &rt, const Json &cmd) {
    auto found = rt->approvals.find(cmd.at("approvalId"));
    if (found == rt->approvals.end())
      throw Error("UNKNOWN_APPROVAL", "Approval expired or already answered");
    if (cmd.at("runtimeId") != rt->runtime_id || cmd.at("approvalVersion") != found->second.version)
      throw Error("STALE_APPROVAL", "Approval belongs to another runtime or request version");
  }
  void external_answer(const std::string &id, const Json &cmd, Completion done) {
    const auto s = store_.get(id);
    auto runtime = runtimes_.find(id);
    if (!s.value("external", false) || runtime == runtimes_.end() ||
        !runtime->second->external_approvals || !s.value("approvalForwarding", false) ||
        s["state"] != "ready")
      throw Error("APPROVAL_UNAVAILABLE", "No connection to original approval server");
    try {
      validate_approval(runtime->second, cmd);
      auto result =
          runtime->second->external_approvals->answer(cmd.at("approvalId"), cmd.at("allow"));
      auto approval = runtime->second->approvals.find(cmd.at("approvalId"));
      if (approval != runtime->second->approvals.end())
        approval->second.submitted = true;
      emit(id, "approvalSubmitted", {{"approvalId", cmd.at("approvalId")}});
      done(result, nullptr);
    } catch (const std::exception &error) {
      auto value = error_data(error);
      done(nullptr, value);
    }
  }
  void queue_external(const std::string &id, const Json &cmd, Completion done) {
    auto s = store_.get(id);
    auto it = runtimes_.find(id);
    if (!s.value("external", false) || it == runtimes_.end() || !it->second->reader ||
        s["state"] != "ready")
      throw Error("SESSION_CLOSED", "An active external reader is required");
    if (!config_.value("externalSessions", Json::object()).value("allowQueue", false) ||
        config_["sandbox"] != "workspace-write")
      throw Error("EXTERNAL_QUEUE_DISABLED",
                  "Enable externalSessions.allowQueue on a workspace-write Agent to queue input; "
                  "the original client controls execution and approvals");
    auto reader = it->second->reader;
    auto complete = [this, cmd, id, done](Json result, Json error) {
      if (!error.is_null()) {
        done(nullptr, error);
        return;
      }
      Json queued = {
          {"state", "queued"},
          {"queueId", result.at("queuedSubmission").at("id")},
          {"clientUserMessageId", result.at("queuedSubmission").at("clientUserMessageId")}};
      emit(id, "queueAccepted",
           {{"requestId", cmd.at("requestId")},
            {"queueId", queued["queueId"]},
            {"text", cmd.at("text")},
            {"message", "Message queued for the original Codex client"}});
      done(queued, nullptr);
    };
    reader->enqueue(cmd.at("text"), uuid(), [] {}, complete);
  }
  void read_archive(const std::string &id, std::shared_ptr<CodexProcess> process, bool temporary,
                    int remaining, Completion done) {
    auto s = store_.get(id);
    const bool legacy = s.value("historyMode", "paginated") == "legacy";
    Json params = {{"threadId", s.at("threadId")},
                   {"cursor", s.value("archiveCursor", Json())},
                   {"sortDirection", "desc"},
                   {"limit", 1}};
    if (legacy)
      params["itemsView"] = "full";
    process->request(
        legacy ? "thread/turns/list" : "thread/items/list", params,
        [this, id, process, temporary, remaining, done, legacy](Json result, Json error) {
          if (!error.is_null()) {
            archive_loading_.erase(id);
            if (temporary)
              process->close();
            done(nullptr, error);
            return;
          }
          Json events = Json::array(), entries = Json::array();
          if (legacy) {
            for (auto &turn : result.value("data", Json::array())) {
              auto items = turn.value("items", Json::array());
              std::reverse(items.begin(), items.end());
              for (auto &item : items)
                entries.push_back({{"turnId", turn.at("id")}, {"item", item}});
            }
          } else
            entries = result.value("data", Json::array());
          const bool external = store_.get(id).value("external", false);
          for (auto &entry : entries) {
            if (external) {
              auto event = store_.external_item(id, entry.at("turnId"), entry.at("item"), true);
              if (!event.is_null())
                publish(id, event);
              continue;
            }
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
              events.push_back(
                  {{"type", "item/completed"}, {"data", {{"item", item}, {"turnId", turn}}}});
          }
          auto cursor = result.value("nextCursor", Json());
          if (external) {
            auto current = store_.get(id);
            current["archiveCursor"] = cursor;
            current["archiveDone"] = cursor.is_null();
            store_.save(current);
          } else
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
  void prepare_history_source(int remaining = 8) {
    if (stopped_ || !remaining || history_readers_ || !archive_loading_.empty())
      return;
    const auto candidate = store_.history_source_candidate();
    if (candidate.is_null()) {
      asio::post(io_, [this, remaining] { prepare_history_source(remaining - 1); });
      return;
    }
    const std::string id = candidate.at("session");
    std::string cwd;
    std::filesystem::path home;
    try {
      cwd = project(candidate.at("projectId")).at("path");
      home = history_source_home(cwd);
    } catch (const std::exception &) {
      ++history_prepare_skipped_;
      asio::post(io_, [this, remaining] { prepare_history_source(remaining - 1); });
      return;
    }
    auto process = std::make_shared<CodexProcess>(
        io_, config_, cwd, [](Json) {}, [] {}, CodexProcessRole::reader);
    auto finished = std::make_shared<bool>(false);
    auto complete = [this, id, candidate, process, finished, remaining](Json source, Json error) {
      if (*finished)
        return;
      *finished = true;
      --history_readers_;
      process->close();
      if (stopped_)
        return;
      try {
        if (!error.is_null())
          throw Error(error.value("code", "CONTENT_UNAVAILABLE"), "Source preparation failed");
        store_.history_source_register(id, candidate.at("seq"), source.at("origin"),
                                       source.at("entry"), candidate);
        ++history_prepared_;
        store_.history_cache_compact({{"session", id},
                                      {"seq", candidate.at("seq")},
                                      {"origin", source.at("origin")},
                                      {"entry", source.at("entry")}});
      } catch (const std::exception &) {
        // Optional recovery metadata never authorizes retrying a business RPC.
        // Storage failures retain the Store's normal fail-closed callback.
        ++history_prepare_skipped_;
      }
      asio::post(io_, [this, remaining] { prepare_history_source(remaining - 1); });
    };
    ++history_readers_;
    try {
      process->start();
      process->initialize([this, candidate, process, cwd, home, complete](Json, Json error) {
        if (!error.is_null()) {
          complete(nullptr, error);
          return;
        }
        try {
          read_history_source(process, home, candidate.at("threadId"), cwd, candidate.at("turnId"),
                              candidate.at("itemId"),
                              config_.at("historyStorage").at("readPageMaxBytes"), complete,
                              candidate.at("origin"));
        } catch (const std::exception &failure) {
          complete(nullptr, error_data(failure));
        }
      });
    } catch (const std::exception &failure) {
      complete(nullptr, error_data(failure));
    }
  }
  void read_history_content(const std::string &id, const Json &query, Completion done) {
    const auto offset = query.value("offset", int64_t(0));
    try {
      auto result =
          query.contains("reference")
              ? store_.history_content(id, query.at("reference"), offset)
              : store_.content(id, query.at("seq"), offset, query.value("revision", int64_t(-1)));
      done(result, nullptr);
      return;
    } catch (const Error &error) {
      if (error.code != "CONTENT_UNAVAILABLE")
        throw;
    }
    if (offset < 0)
      throw Error("INVALID_REQUEST", "Invalid content offset");
    const auto plan = store_.history_source_plan(id, query.at("seq"));
    const auto reference = plan.at("reference");
    if ((query.contains("reference") && query.at("reference") != reference) ||
        (query.contains("revision") && query.at("revision") != reference.at("revision")))
      throw Error("CONTENT_UNAVAILABLE", "Original history reference is no longer available");
    const auto policy = config_.at("historyStorage");
    if (history_readers_ >= policy.at("readConcurrency").get<size_t>())
      throw Error("BACKPRESSURE", "History recovery reader capacity exhausted");
    const auto state = store_.get(id);
    const std::string cwd = project(state.at("projectId")).at("path");
    const auto home = history_source_home(cwd);
    auto process = std::make_shared<CodexProcess>(
        io_, config_, cwd, [](Json) {}, [] {}, CodexProcessRole::reader);
    auto finished = std::make_shared<bool>(false);
    auto complete = [this, process, done, finished](Json result, Json error) {
      if (*finished)
        return;
      *finished = true;
      --history_readers_;
      process->close();
      done(result, error);
    };
    ++history_readers_;
    try {
      process->start();
      process->initialize([this, id, plan, reference, offset, process, home, cwd, policy,
                           complete](Json, Json error) {
        if (!error.is_null()) {
          complete(nullptr, error);
          return;
        }
        try {
          read_history_source(
              process, home, plan.at("threadId"), cwd, plan.at("turnId"), plan.at("itemId"),
              policy.at("readPageMaxBytes"),
              [this, id, reference, offset, complete](Json source, Json error) {
                if (!error.is_null()) {
                  complete(nullptr, error);
                  return;
                }
                Json page;
                try {
                  page = store_.history_recovered_content(id, reference, source.at("origin"),
                                                          source.at("entry"), offset);
                } catch (const std::exception &failure) {
                  complete(nullptr, error_data(failure));
                  return;
                }
                complete(page, nullptr);
              },
              plan.at("origin"));
        } catch (const std::exception &failure) {
          complete(nullptr, error_data(failure));
        }
      });
    } catch (const std::exception &failure) {
      complete(nullptr, error_data(failure));
    }
  }
  void load_archive(const std::string &id, Completion done) {
    auto s = store_.get(id);
    if (archive_loading_.count(id))
      throw Error("BACKPRESSURE", "Archive page is already loading");
    auto existing = runtimes_.find(id);
    // Closed sessions can still fetch uncached archive pages after Agent restart.
    const bool temporary = existing == runtimes_.end() || s.value("state", "") == "closing" ||
                           s.value("state", "") == "closed" || s.value("state", "") == "failed";
    auto process = temporary ? std::make_shared<CodexProcess>(
                                   io_, config_, project(s["projectId"])["path"], [](Json) {},
                                   [] {}, CodexProcessRole::reader)
                             : existing->second->process;
    archive_loading_.insert(id);
    auto read = [this, id, process, temporary, done]() {
      auto s = store_.get(id);
      read_history_thread(process, s.at("threadId"), project(s.at("projectId")).at("path"),
                          [this, id, process, temporary, done](Json, Json error) {
                            try {
                              if (!error.is_null())
                                throw Error(error.at("code"), error.at("message"));
                              read_archive(id, process, temporary, 10, done);
                            } catch (const std::exception &error) {
                              archive_loading_.erase(id);
                              if (temporary)
                                process->close();
                              done(nullptr, error_data(error));
                            }
                          });
    };
    if (temporary) {
      try {
        process->start();
      } catch (...) {
        archive_loading_.erase(id);
        process->close();
        throw;
      }
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
  void flush_rpc_output(const std::string &id, const std::shared_ptr<Runtime> &runtime) {
    if (!runtime->rpc_delivery)
      return;
    const auto stream = "rpc-output:" + id;
    const auto state = store_.output_state(stream);
    runtime->rpc_sent = std::max(runtime->rpc_sent, state.at("acked").get<int64_t>());
    for (const auto &frame : store_.output_page(stream, runtime->rpc_sent)) {
      if (frame.at("seq").get<int64_t>() > runtime->rpc_credit ||
          frame.at("end").get<int64_t>() > runtime->rpc_byte_credit)
        break;
      store_.output_publish(stream, frame.at("seq"));
      send({{"type", "rpc"},
            {"sessionId", id},
            {"epoch", runtime->epoch},
            {"payload",
             {{"type", "delivery-data"},
              {"seq", frame.at("seq")},
              {"end", frame.at("end")},
              {"body", frame.at("body")}}}});
      runtime->rpc_sent = frame.at("seq");
    }
  }
  void rpc(const std::string &id, const Json &raw) {
    auto m = redact(raw);
    auto it = runtimes_.find(id);
    if (it != runtimes_.end() && !it->second->immediate_delivery.is_null()) {
      delivery_reply(id, it->second->immediate_delivery, m);
      return;
    }
    if (it != runtimes_.end() && m.contains("id") && !m.contains("method")) {
      auto found = it->second->deliveries.find("rpc:" + m.at("id").dump());
      if (found != it->second->deliveries.end()) {
        auto context = found->second;
        it->second->deliveries.erase(found);
        delivery_reply(id, context, m);
        return;
      }
    }
    if (Json(m.dump()).dump().size() > max_frame - 4096) {
      emit(id, "largeRpc", m);
      if (m.contains("id") && !m.contains("method"))
        m = {{"id", m["id"]},
             {"error",
              {{"code", -32000},
               {"message", "Large result is available through coc-client history content reads"}}}};
      else
        return; // Full content remains in the Agent journal and read-only history stream.
    }
    if (it != runtimes_.end()) {
      try {
        store_.output_append("rpc-output:" + id, m);
      } catch (const Error &error) {
        if (error.code == "BACKPRESSURE") {
          auto session = store_.get(id);
          session["outputError"] = {
              {"code", "BACKPRESSURE"},
              {"message", "Durable output is full; the Codex runtime was stopped"}};
          store_.save(session);
          // Stop producing. Previously journaled and acknowledged output stays intact.
          it->second->process->close();
        }
        throw;
      }
      flush_rpc_output(id, it->second);
      return;
    }
  }
  void cli(const std::string &id, const Json &m) {
    auto s = store_.get(id);
    auto rt = runtimes_.at(id);
    try {
      if (s["mode"] != "cli" || s.value("external", false))
        throw Error("FORBIDDEN", "External readers use history and queue commands");
      if (!m.is_object())
        throw Error("INVALID_REQUEST", "Invalid RPC");
      if (m.contains("id"))
        rpc_key(m.at("id"));
      if (!m.contains("method")) {
        auto key = m.at("id").dump();
        if (!rt->approvals.count(key))
          throw Error("UNKNOWN_APPROVAL", "No matching server request");
        if (!m.contains("coc") || !m.at("coc").contains("approval"))
          throw Error("STALE_APPROVAL", "Approval reply requires its original runtime proof");
        const auto &proof = m.at("coc").at("approval");
        const auto &pending = rt->approvals.at(key);
        if (proof.at("instance") != store_.delivery_instance() ||
            proof.at("runtimeId") != rt->runtime_id ||
            proof.at("approvalVersion") != pending.version ||
            proof.at("requestId") != pending.rpc.at("id"))
          throw Error("STALE_APPROVAL", "Reply does not match the original runtime and approval");
        auto reply = m;
        reply.erase("coc");
        rt->process->send(reply);
        rt->approvals.erase(key);
        return;
      }
      if (m.at("method") == "coc/cancel") {
        const auto target = command_target(m.at("params").at("target"));
        auto original = target;
        original.erase("turnId");
        auto active = s.value("activeTask", Json::object());
        const auto turn = active.value("turnId", "");
        active.erase("turnId");
        if (s.value("running", false) && original == active) {
          if ((turn.empty() && target.contains("turnId")) ||
              (!turn.empty() && target.value("turnId", "") != turn))
            throw Error("TARGET_NOT_FOUND", "Cancellation must name the original active turn");
          store_.delivery_cancel(id, target);
          if (turn.empty())
            rt->interrupt_target = original;
          else
            rt->process->request("turn/interrupt",
                                 {{"threadId", s.at("threadId")}, {"turnId", turn}},
                                 [](Json, Json) {});
        } else {
          const auto result = store_.delivery_cancel(id, target);
          if (result.at("state") == "started")
            throw Error("TARGET_NOT_ACTIVE", "The original task cannot be matched to this runtime");
        }
        return;
      }
      auto business = m;
      business.erase("coc");
      auto guarded = guard_cli(business, project(s["projectId"])["path"], config_["sandbox"],
                               s.value("threadId", ""));
      auto method = m.at("method").get<std::string>();
      if (method == "turn/interrupt") {
        if (!m.contains("coc") || !m.at("coc").contains("target"))
          throw Error("TARGET_NOT_FOUND", "An interruption requires the original task identity");
        const auto target = command_target(m.at("coc").at("target"));
        const auto active = s.value("activeTask", Json::object());
        if (target != active || !s.value("running", false) || !s.contains("turnId") ||
            target.value("turnId", "") != s.at("turnId") ||
            guarded.at("params").at("turnId") != s.at("turnId"))
          throw Error("TARGET_NOT_FOUND",
                      "The interruption does not match this runtime's original task and turn");
      }
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
      if (method == "turn/steer" &&
          (!s.value("running", false) || !s.contains("turnId") ||
           guarded.at("params").value("expectedTurnId", "") != s.at("turnId")))
        throw Error("TARGET_NOT_FOUND", "Steering must name the original active turn");
      if (method == "turn/start") {
        if (s.value("running", false))
          throw Error("TURN_BUSY", "A turn is already running");
        check_busy(s);
      }
      auto before_send = [this, id, rt, m, guarded, method]() {
        if (method == "turn/start" || method == "turn/steer")
          reserve_history_turn(id, guarded.value("params", Json::object()));
        if (method == "turn/interrupt")
          store_.delivery_cancel(id, command_target(m.at("coc").at("target")));
        if (method == "turn/start") {
          auto current = store_.get(id);
          rt->submitted = true;
          current["running"] = true;
          current.erase("turnId");
          const auto context = rt->deliveries.find("rpc:" + m.at("id").dump());
          if (context != rt->deliveries.end())
            current["activeTask"] =
                store_.delivery_target(context->second.at("stream"), context->second.at("seq"));
          else
            current.erase("activeTask");
          store_.save(current);
        }
        if (method == "turn/start" || method == "turn/steer") {
          std::string text;
          for (auto &input : guarded.at("params").value("input", Json::array()))
            text += input.value("text", "");
          emit(id, "user", {{"text", text}});
        }
      };
      if (!m.contains("id")) {
        // Only initialized is a supported client notification. Writes require a
        // response identity so they can own a pending slot and a durable result.
        if (method != "initialized")
          throw Error("INVALID_REQUEST", "RPC requests require an ID");
        rt->process->send(guarded);
        return;
      }
      const auto client_id = m.at("id");
      const auto key = client_id.dump();
      if (rt->requests.count(key))
        throw Error("IDEMPOTENCY_CONFLICT", "RPC ID is already pending");
      rt->requests[key] = method;
      rt->process->request(
          method, guarded.value("params", Json::object()),
          [this, id, rt, client_id, key, method](Json result, Json error) {
            rt->requests.erase(key);
            if (!runtimes_.count(id) || runtimes_.at(id) != rt)
              return;
            auto current = store_.get(id);
            if (method == "thread/start" && error.is_null() && result.contains("thread")) {
              current["threadId"] = result.at("thread").at("id");
              store_.save(current);
            }
            if (method == "turn/start" && !error.is_null() &&
                error.value("code", "") != "RESULT_UNKNOWN") {
              current["running"] = false;
              store_.save(current);
            }
            if (error.is_null())
              rpc(id, {{"id", client_id}, {"result", result}});
            else
              rpc(id, {{"id", client_id},
                       {"error", error.value("rpc", Json{{"code", -32001},
                                                         {"message", error.at("message")},
                                                         {"data", error}})}});
          },
          before_send);
    } catch (const std::exception &e) {
      rpc(id,
          {{"id", m.is_object() ? m.value("id", Json()) : Json()},
           {"error",
            {{"code", -32001}, {"message", error_data(e)["message"]}, {"data", error_data(e)}}}});
    }
  }
  void reserve_history_turn(const std::string &id, const Json &input) {
    // Reserve the initial input projection and bounded output headroom before
    // forwarding a side effect. This is not a promise of unlimited model output.
    const auto encoded = input.dump().size();
    if (encoded > max_frame)
      throw Error("MESSAGE_TOO_LARGE", "Turn input exceeds history admission bound");
    store_.history_reserve(id, 64 * 1024 + static_cast<int64_t>(encoded) * 4, 64);
  }
  void on_codex(const std::string &id, const Json &m) {
    auto it = runtimes_.find(id);
    if (it == runtimes_.end())
      return;
    auto rt = it->second;
    auto s = store_.get(id);
    auto method = m.value("method", "");
    if (s.value("external", false)) {
      if (!method.empty() && m.contains("id"))
        rt->process->send(
            {{"id", m["id"]},
             {"error",
              {{"code", -32601}, {"message", "External reader does not handle approvals"}}}});
      return;
    }
    if (method == "turn/started") {
      s["running"] = true;
      s["turnId"] = m.at("params").at("turn").at("id");
      if (s.contains("activeTask"))
        s["activeTask"]["turnId"] = s.at("turnId");
      store_.save(s);
      if (!rt->interrupt_target.is_null()) {
        auto target = rt->interrupt_target;
        rt->interrupt_target = nullptr;
        auto active = s.value("activeTask", Json::object());
        active.erase("turnId");
        if (target == active)
          rt->process->request("turn/interrupt",
                               {{"threadId", s.at("threadId")}, {"turnId", s.at("turnId")}},
                               [](Json, Json) {});
      }
    }
    const bool completed_active_turn =
        method == "turn/completed" && s.contains("turnId") &&
        m.value("params", Json::object()).value("turn", Json::object()).value("id", "") ==
            s.at("turnId").get<std::string>();
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
      const auto key = rpc_key(m.at("id"));
      bool basic = method == "item/commandExecution/requestApproval" ||
                   method == "item/fileChange/requestApproval" ||
                   method == "item/permissions/requestApproval";
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
      try {
        if (!remember_approval(rt, key, m))
          return;
      } catch (const Error &error) {
        if (error.code != "BACKPRESSURE")
          throw; // Ambiguous ID reuse closes the runtime; an old proof cannot answer new input.
        rt->process->send(
            {{"id", m.at("id")},
             {"error",
              {{"code", -32001}, {"message", error.what()}, {"data", error_data(error)}}}});
        emit(id, "warning", {{"message", "Approval resource limit reached; request rejected"}});
        return;
      }
      if (s["mode"] == "web") {
        emit(id, "approval",
             {{"approvalId", key},
              {"runtimeId", rt->runtime_id},
              {"approvalVersion", rt->approvals.at(key).version},
              {"method", method},
              {"params", m.value("params", Json::object())}});
        auto_approve(id, key);
        return;
      }
    }
    if (s["mode"] == "cli") {
      if (!method.empty() && !m.contains("id"))
        emit(id, method, m.value("params", Json::object()));
      auto output = m;
      if (method == "turn/started" && s.contains("activeTask"))
        output["coc"] = {{"task", s.at("activeTask")}};
      if (m.contains("id") && m.contains("method") && rt->approvals.count(m.at("id").dump()))
        output["coc"]["approval"] = {
            {"instance", store_.delivery_instance()},
            {"runtimeId", rt->runtime_id},
            {"approvalVersion", rt->approvals.at(m.at("id").dump()).version},
            {"requestId", m.at("id")}};
      rpc(id, output);
    } else if (!method.empty()) {
      auto params = m.value("params", Json::object());
      if (method == "turn/started" && s.contains("activeTask"))
        params["activeTask"] = s.at("activeTask");
      emit(id, method, params);
    }
    // All final history and CC output above are durable before unused capacity
    // can be retired. An unrelated/late terminal event cannot refund a new turn.
    if (completed_active_turn)
      store_.history_release(id);
  }
  void drain(const std::string &id, std::shared_ptr<Runtime> rt) {
    if (rt->busy || rt->commands.empty() || !runtimes_.count(id))
      return;
    auto queued = std::move(rt->commands.front());
    rt->commands.pop_front();
    auto d = std::move(queued.frame);
    if (d.value("delivery", Json()).is_null() && d["epoch"] != rt->epoch) {
      drain(id, rt);
      return;
    }
    if (!d.value("delivery", Json()).is_null() &&
        !store_.delivery_start(d["delivery"]["stream"], d["delivery"]["seq"])) {
      const auto record = store_.delivery_record(d["delivery"]["stream"], d["delivery"]["seq"]);
      if (!record.is_null() && record.at("phase") == "finished") {
        rt->deliveries.erase(d.at("payload").value("requestId", ""));
        delivery_reply(id, d.at("delivery"), record.at("result"));
      }
      drain(id, rt);
      return;
    }
    rt->busy = true;
    auto raw = d["payload"];
    auto finish = [this, id, rt, raw, reservation = std::move(queued.reservation)](Json,
                                                                                   Json error) {
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
    if (action != "sync" && action != "models" &&
        !rt->deliveries.count(cmd.at("requestId").get<std::string>()))
      throw Error("UPGRADE_REQUIRED", "Writes require the delivery:2 command window");
    if (action == "sync") {
      auto replay = store_.replay(id, cmd["after"]);
      replay["type"] = "sync";
      replay["session"] = s;
      replay["approvals"] = Json::array();
      for (auto &[key, a] : rt->approvals)
        replay["approvals"].push_back({{"approvalId", key},
                                       {"runtimeId", rt->runtime_id},
                                       {"approvalVersion", a.version},
                                       {"method", a.rpc["method"]},
                                       {"params", redact(a.rpc.value("params", Json::object()))},
                                       {"submitted", a.submitted},
                                       {"unsupported", a.unsupported}});
      notice(id, replay);
      done(nullptr, nullptr);
      return;
    }
    if (action == "autoApproval") {
      if (s["state"] != "ready")
        throw Error("SESSION_CLOSED", "An active session is required");
      if (cmd.at("enabled") == true && s.value("external", false) &&
          (!config_["externalSessions"].value("allowApprovals", false) ||
           !s.value("approvalForwarding", false)))
        throw Error("APPROVAL_UNAVAILABLE", "Original approval forwarding is unavailable");
      s["autoApproval"] = cmd.at("enabled");
      store_.save(s);
      Json result = {{"autoApproval", s["autoApproval"]}};
      emit(id, "autoApprovalChanged", result);
      notice(id, {{"type", "ack"}, {"requestId", cmd["requestId"]}, {"result", result}});
      done(result, nullptr);
      if (s["autoApproval"] == true) {
        std::vector<std::string> pending;
        for (const auto &[approval, value] : rt->approvals)
          pending.push_back(approval);
        for (const auto &approval : pending)
          auto_approve(id, approval);
      }
      return;
    }
    if (s.value("external", false)) {
      if (action == "approval") {
        external_answer(id, cmd, [this, id, cmd, done](Json result, Json error) {
          if (error.is_null())
            notice(id, {{"type", "ack"}, {"requestId", cmd["requestId"]}, {"result", result}});
          done(result, error);
        });
        return;
      }
      if (action != "prompt")
        throw Error("EXTERNAL_READ_ONLY",
                    "The original Codex client handles interruption and approvals");
      if (cmd.contains("model"))
        throw Error("EXTERNAL_READ_ONLY", "Switch models in the original Codex client");
      queue_external(id, cmd, [this, id, cmd, done](Json result, Json error) {
        if (error.is_null())
          notice(id, {{"type", "ack"}, {"requestId", cmd["requestId"]}, {"result", result}});
        done(result, error);
      });
      return;
    }
    if (action == "models") {
      Json params = {{"limit", 100}, {"includeHidden", false}};
      if (cmd.contains("cursor"))
        params["cursor"] = cmd["cursor"];
      rt->process->request("model/list", params, [this, id, cmd, done](Json result, Json error) {
        if (error.is_null())
          notice(id, {{"type", "ack"}, {"requestId", cmd["requestId"]}, {"result", result}});
        done(result, error);
      });
      return;
    }
    auto complete = [this, id, cmd, done](Json result, Json error) {
      if (error.is_null())
        notice(id, {{"type", "ack"}, {"requestId", cmd["requestId"]}, {"result", result}});
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
      Json params = {{"threadId", s.at("threadId")},
                     {"input", Json::array({{{"type", "text"},
                                             {"text", cmd["text"]},
                                             {"text_elements", Json::array()}}})}};
      if (cmd.contains("model"))
        params["model"] = cmd["model"];
      auto user_event = std::make_shared<Json>();
      rt->process->request(
          "turn/start", params,
          [this, id, complete, user_event](Json result, Json error) {
            auto current = store_.get(id);
            if (error.is_null()) {
              auto turn = result.at("turn").at("id");
              if (current["running"] == true)
                current["turnId"] = turn;
              store_.save(current);
              complete({{"turnId", turn}, {"history", *user_event}}, nullptr);
            } else {
              if (error.value("code", "") != "RESULT_UNKNOWN") {
                current["running"] = false;
                store_.save(current);
              }
              complete(nullptr, error);
            }
          },
          [this, id, rt, cmd, user_event]() {
            reserve_history_turn(id, cmd);
            auto s = store_.get(id);
            s["running"] = true;
            const auto context = rt->deliveries.find(cmd.at("requestId").get<std::string>());
            if (context != rt->deliveries.end())
              s["activeTask"] =
                  store_.delivery_target(context->second.at("stream"), context->second.at("seq"));
            else
              s.erase("activeTask");
            s.erase("turnId");
            store_.save(s);
            const auto event =
                emit(id, "user", {{"text", cmd["text"]}, {"requestId", cmd["requestId"]}});
            *user_event = store_.history_reference(id, event.at("seq"));
          });
      return;
    }
    if (action == "interrupt") {
      try {
        const auto target = command_target(cmd.at("target"));
        auto original = target;
        original.erase("turnId");
        auto active = s.value("activeTask", Json::object());
        active.erase("turnId");
        if (s.value("running", false) && original == active) {
          if ((s.contains("turnId") && target.value("turnId", "") != s.at("turnId")) ||
              (!s.contains("turnId") && target.contains("turnId")))
            throw Error("TARGET_NOT_FOUND", "Interruption must name the original active turn");
          store_.delivery_cancel(id, target);
          if (s.contains("turnId"))
            rt->process->request("turn/interrupt",
                                 {{"threadId", s.at("threadId")}, {"turnId", s.at("turnId")}},
                                 [complete](Json, Json error) {
                                   complete({{"state", "interrupt-submitted"}}, error);
                                 });
          else {
            rt->interrupt_target = original;
            complete({{"state", "interrupt-pending-turn"}}, nullptr);
          }
          return;
        }
        const auto cancelled = store_.delivery_cancel(id, target);
        discard_finished_commands(id, rt);
        if (cancelled.at("state") == "started")
          throw Error("TARGET_NOT_ACTIVE", "The original task cannot be matched to this runtime");
        complete({{"state", cancelled.at("state") == "pending-target" ? "cancel-pending-target"
                                                                      : "target-finished"},
                  {"target", target}},
                 nullptr);
      } catch (const std::exception &error) {
        complete(nullptr, error_data(error));
      }
      return;
    }
    if (action == "approval") {
      try {
        validate_approval(rt, cmd);
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
        method == "item/fileChange/requestApproval" || method == "item/permissions/requestApproval")
      rt->process->send({{"id", m["id"]}, {"result", approval_decision(m, allow)}});
    else
      rt->process->send(
          {{"id", m["id"]}, {"error", {{"code", -32000}, {"message", "Approval timed out"}}}});
    rt->approvals.erase(it);
    emit(id, "approvalResolved", {{"approvalId", key}, {"allow", allow}});
  }
  void auto_approve(const std::string &id, const std::string &key) {
    auto runtime = runtimes_.find(id);
    if (runtime == runtimes_.end())
      return;
    auto rt = runtime->second;
    const auto s = store_.get(id);
    auto approval = rt->approvals.find(key);
    if (s["state"] != "ready" || s["mode"] != "web" || !s.value("autoApproval", false) ||
        approval == rt->approvals.end() || approval->second.submitted ||
        approval->second.unsupported)
      return;
    const auto method = approval->second.rpc.value("method", "");
    if (method != "item/commandExecution/requestApproval" &&
        method != "item/fileChange/requestApproval" && method != "item/permissions/requestApproval")
      return;
    if (s.value("external", false) && !s.value("approvalForwarding", false))
      return;
    if (approval->second.auto_attempted)
      return;
    approval->second.auto_attempted = true;
    try {
      if (s.value("external", false)) {
        unsigned char hash[SHA256_DIGEST_LENGTH];
        const auto identity = rt->runtime_id + ":" + approval->second.version;
        SHA256(reinterpret_cast<const unsigned char *>(identity.data()), identity.size(), hash);
        std::string request = "auto-";
        for (auto byte : hash) {
          request += "0123456789abcdef"[byte >> 4];
          request += "0123456789abcdef"[byte & 15];
        }
        external_answer(id,
                        {{"action", "approval"},
                         {"requestId", request},
                         {"internal", true},
                         {"approvalId", key},
                         {"runtimeId", rt->runtime_id},
                         {"approvalVersion", approval->second.version},
                         {"allow", true}},
                        [](Json, Json) {});
      } else
        answer(id, key, true);
    } catch (const std::exception &error) {
      emit(id, "warning",
           {{"message", "Automatic approval unconfirmed; inspect the original request: " +
                            error_data(error).at("message").get<std::string>()}});
    }
  }
  void on_exit(const std::string &id) {
    if (!runtimes_.count(id))
      return;
    if (runtimes_.at(id)->reader)
      runtimes_.at(id)->reader->close();
    if (runtimes_.at(id)->external_approvals)
      runtimes_.at(id)->external_approvals->close();
    auto s = store_.get(id);
    if (s["state"] == "closing")
      s["state"] = "closed";
    else if (s["state"] != "closed")
      s["state"] = "failed";
    s["running"] = false;
    s["autoApproval"] = false;
    if (s.value("external", false))
      s["approvalForwarding"] = false;
    store_.save(s);
    auto runtime = runtimes_.find(id);
    if (runtime != runtimes_.end()) {
      const auto pending = runtime->second->deliveries;
      runtime->second->deliveries.clear();
      for (const auto &[key, context] : pending) {
        (void)key;
        const auto record = store_.delivery_record(context.at("stream"), context.at("seq"));
        const bool started = !record.is_null() && record.at("phase") == "started";
        delivery_reply(id, context,
                       {{"error",
                         {{"code", started ? "RESULT_UNKNOWN" : "SESSION_CLOSED"},
                          {"message", started ? "Runtime exited after execution began"
                                              : "Runtime exited before command execution"}}}});
      }
    }
    store_.delivery_retire_session(id);
    emit(id, "sessionClosed", {{"state", s["state"]}});
    auto rt = runtimes_.at(id);
    rt->commands.clear();
    rt->approvals.clear();
    rt->result_routes.clear();
    runtimes_.erase(id);
  }
  void stop(const std::string &id) {
    auto s = store_.get(id);
    auto it = runtimes_.find(id);
    s["state"] = it == runtimes_.end() ? "closed" : "closing";
    s["running"] = false;
    s["autoApproval"] = false;
    if (s.value("external", false))
      s["approvalForwarding"] = false;
    store_.save(s);
    if (it != runtimes_.end()) {
      auto p = it->second->process;
      if (it->second->reader)
        it->second->reader->close();
      if (it->second->external_approvals)
        it->second->external_approvals->close();
      if (!s.value("external", false) && s.contains("turnId"))
        p->request("turn/interrupt", {{"threadId", s.at("threadId")}, {"turnId", s.at("turnId")}},
                   [](Json, Json) {});
      p->close();
    }
  }
  void check_update() {
    try {
      // Only this setting is hot-reloaded; project/policy changes still need restart.
      config_["autoUpdate"] =
          read_json(config_file_).value("autoUpdate", Json(UpdateSettings{}.enabled));
      if (updater_.poll(config_, config_.at("relayUrl"),
                        runtimes_.empty() && archive_loading_.empty() && !history_readers_ &&
                            !listing_threads_ && file_requests_ == 0)) {
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
    if (stopped_)
      return;
    if (approval_check_pending_) {
      approval_check_again_ = true;
      return;
    }
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
        if (approval_check_again_) {
          approval_check_again_ = false;
          asio::post(io_, [this] { check_client_requests(); });
        }
        if (stopped_)
          return;
        if (!failure.is_null()) {
          if (!approval_check_failed_)
            std::cerr << Json{{"event", "client_approval_check_failed"},
                              {"error", failure},
                              {"message",
                               "Refresh requests explicitly or reconnect; Agent continues running"}}
                             .dump()
                      << '\n';
          approval_check_failed_ = true;
          return;
        }
        approval_check_failed_ = false;
        // Quote the config path for a POSIX shell, including spaces, quotes and '$'.
        std::string config_arg = "'";
        for (char c : std::filesystem::absolute(config_file_).u8string())
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
          for (const auto *key : {"id", "role", "name", "requestedHostId", "message", "manager",
                                  "email", "code", "expires"})
            notice[key] = request.value(key, Json());
          if (request.value("manager", false)) {
            std::cerr
                << "Client administrator identity pairing requires a verified browser login.\n"
                << notice.dump() << "\nOpen: " << config_.at("relayUrl").get<std::string>()
                << "/#manager=" << id << '\n'
                << std::flush;
            continue;
          }
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
      check_update();
      if (stopped_)
        return;
      try {
        prune_result_routes();
        for (auto &[id, r] : runtimes_) {
          // A lost final RESULT/ACK or output frame must recover without new business.
          // The maintenance timer already exists; idle streams emit no traffic.
          for (const auto &[stream, route] : r->result_routes) {
            if (route.at("epoch") != r->epoch)
              continue;
            const auto state = store_.delivery_result_state(stream);
            if (state.at("sent") > state.at("acked")) {
              const auto results = store_.delivery_results(stream, state.at("acked"));
              if (!results.empty()) {
                auto context = route;
                context["seq"] = results.at(0).at("seq");
                delivery_reply(id, context, nullptr);
              }
            }
          }
          if (r->rpc_delivery && r->epoch > 0) {
            const auto state = store_.output_state("rpc-output:" + id);
            if (state.at("sent") > state.at("acked")) {
              r->rpc_sent = state.at("acked");
              flush_rpc_output(id, r);
            }
          }
          std::vector<std::string> expired;
          for (auto &[key, a] : r->approvals)
            if (!r->external_approvals && now() - a.time > 600000)
              expired.push_back(key);
          for (auto &key : expired)
            answer(id, key, false);
          if (r->detached && now() - r->detached > 1800000 &&
              !store_.get(id).value("autoApproval", false))
            stop(id);
        }
        size_t approvals = 0, commands = 0;
        for (const auto &[id, runtime] : runtimes_) {
          approvals += runtime->approvals.size();
          commands += runtime->commands.size();
        }
        const auto history_usage = store_.history_budget().at("global");
        std::cerr << Json{{"event", "agent_metrics"},
                          {"time", now()},
                          {"runtimes", runtimes_.size()},
                          {"archiveReaders", archive_loading_.size()},
                          {"historyReaders", history_readers_},
                          {"historyPrepared", history_prepared_},
                          {"historyPreparationSkipped", history_prepare_skipped_},
                          {"approvals", approvals},
                          {"queuedCommands", commands},
                          {"fileRequests", file_requests_},
                          {"fileQueueBytes", file_bytes_},
                          {"bufferedEvents", buffered_events_.size()},
                          {"historyBytes", history_usage.at("bytes")},
                          {"historyRecords", history_usage.at("records")},
                          {"projects", projects_.usage()},
                          {"codexProcesses", CodexProcess::usage()},
                          {"runtimeResources", runtime_usage()},
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
        prepare_history_source();
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
    project_control_.reset();
    event_timer_.cancel();
    remote_restart_timer_.cancel();
    asio::post(file_pool_, [this] { files_.clear(); });
    retry_.cancel();
    maintenance_.cancel();
    history_retry_.cancel();
    signals_.cancel();
    asio::post(relay_io_, [this] {
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
    coc::Options options(argc, argv);
    if (options.values.count("manager"))
      throw coc::Error("USAGE", "--manager is only supported by coc-client login");
    if (options.values.count("message"))
      throw coc::Error("USAGE", "--message is only supported by coc-client paired login");
    auto command = options.args.empty() ? "help" : options.args[0];
    auto file = std::filesystem::u8path(options.get(
        "config", coc::config_path("COC_AGENT_CONFIG", "coc-agent/agent.json").u8string()));
    if (command == "help") {
      std::cout
          << "Usage: coc-agent "
             "<login|logout|name|proxy|status|wake-url|access-emails|requests|approve|reject|"
             "doctor|project|admin-email|run|update|--"
             "version> "
             "[--config "
             "PATH] "
             "[--relay URL] "
             "[--proxy URL] [--access-config FILE] [--name NAME] [--project PATH] [--project-id "
             "ID] [--api-key]\n"
             "login --api-key: read COC_API_KEY or prompt securely; otherwise approve the "
             "displayed request in the management website. logout only "
             "removes local credentials.\n"
             "requests: list CC/CW requests explicitly targeting this Agent.\n"
             "approve REQUEST_ID / reject REQUEST_ID: after checking the pairing code and role, "
             "handle one targeted request with this Agent credential.\n";
      std::cout << "project list|browse PATH|add PATH [--mkdir] [--name NAME] [--project-id "
                   "ID]|rename ID NAME|remove ID\n";
      std::cout << "admin-email EMAIL: bind administrator email; empty string clears.\n";
      std::cout << "wake-url URL: save and register wake URL; use an empty URL to clear it.\n";
      std::cout
          << "access-emails [EMAIL...]: save and register CW email access; no emails clears it.\n";
      return 0;
    }
    if (options.api_key && command != "login")
      throw coc::Error("USAGE", "--api-key is only valid for login");
    const auto settings =
        std::filesystem::exists(file) ? coc::read_json(file) : coc::Json::object();
    coc::configure_proxy(command == "proxy" ? ""
                                            : options.get("proxy", settings.value("proxy", "")));
    const auto access_file = coc::configure_access(
        options.get("access-config", settings.value("cloudflareAccessFile", "")));
    if (command == "project") {
      auto config = coc::agent_config(settings);
      std::cout << coc::local_project_request(config, coc::project_arguments(options)).dump(2)
                << '\n';
      return 0;
    }
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
    if (command == "login" || command == "logout" || command == "wake-url" || command == "name" ||
        command == "proxy" || command == "access-emails" || command == "admin-email")
      config_lock = std::make_unique<coc::PrivateLock>(file);
    if (command == "proxy" || command == "name") {
      if (options.args.size() != 2)
        throw coc::Error("USAGE", command + " VALUE");
      auto config = settings;
      if (command == "proxy") {
        coc::configure_proxy(options.args[1]);
        config["proxy"] = options.args[1];
      } else {
        auto name = coc::display_name(options.args[1]);
        if (!config.value("token", "").empty())
          coc::http_json(coc::relay_url(config.at("relayUrl")), "/api/v1/instance/name",
                         {{"displayName", name}}, config.at("token"));
        config["displayName"] = name;
      }
      coc::save_private(file, config);
      std::cout << "Configuration saved; restart a running Agent to reload.\n";
      return 0;
    }
    if (command == "login") {
      if (options.args.size() != 1)
        throw coc::Error("USAGE", "Unexpected login argument");
      coc::Json config;
      if (std::filesystem::exists(file)) {
        config = coc::read_json(file);
        if (!config.value("token", "").empty())
          throw coc::Error("ALREADY_LOGGED_IN",
                           "Local A credential exists; use status or logout first");
      }
      if (!config.contains("dataDir"))
        config["dataDir"] = (std::filesystem::absolute(file).parent_path() / "data").u8string();
      if (!config.contains("projects"))
        config["projects"] = coc::Json::array();
      if (!options.get("project").empty() && config["projects"].empty()) {
        auto path = std::filesystem::canonical(std::filesystem::u8path(options.get("project")));
        auto id = options.get("project-id", "my-project");
        if (!std::filesystem::is_directory(path) || !coc::valid_id(id))
          throw coc::Error("CONFIG_ERROR", "Invalid project");
        config["projects"].push_back({{"id", id}, {"name", id}, {"path", path.u8string()}});
      }
      const auto name = coc::display_name(
          options.get("name", config.value("displayName", coc::asio::ip::host_name())));
      config["displayName"] = name;
      config["proxy"] = options.get("proxy", settings.value("proxy", ""));
      if (!access_file.empty())
        config["cloudflareAccessFile"] = access_file;
      auto grant = coc::device_login(options.get("relay", "https://r.xlogic.cc"), "agent", name, "",
                                     options.api_key);
      config["relayUrl"] = grant.at("relay");
      config["hostId"] = grant.at("hostId");
      config["token"] = grant.at("token");
      config["wakeUrl"] = config.value("wakeUrl", "");
      config["accessEmails"] = config.value("accessEmails", coc::Json::array());
      config = coc::agent_config(std::move(config));
      const auto updates = coc::update_settings(config);
      config["autoUpdate"] = {{"enabled", updates.enabled},
                              {"intervalHours", updates.interval_hours},
                              {"platform", updates.platform}};
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
    if (command == "admin-email") {
      if (options.args.size() != 2)
        throw coc::Error("USAGE", "admin-email EMAIL (empty string clears)");
      auto config = coc::read_json(file);
      auto email = options.args[1];
      if (!email.empty())
        email = coc::access_emails(coc::Json::array({email})).at(0);
      coc::http_json(coc::relay_url(config.at("relayUrl")), "/api/v1/agent/admin-email",
                     {{"email", email}}, config.at("token"));
      config["adminEmail"] = email;
      coc::save_private(file, config);
      std::cout << "Agent administrator email registered; platform override takes priority.\n";
      return 0;
    }
    if (command == "access-emails") {
      auto config = coc::read_json(file);
      auto emails = coc::Json::array();
      for (size_t i = 1; i < options.args.size(); ++i)
        emails.push_back(options.args[i]);
      emails = coc::access_emails(emails);
      coc::http_json(coc::relay_url(config.at("relayUrl")), "/api/v1/agent/access-emails",
                     {{"emails", emails}}, config.at("token"));
      config["accessEmails"] = emails;
      coc::save_private(file, config);
      std::cout << "CW email access registered; administrator override takes priority.\n";
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
    config["proxy"] = options.get("proxy", config.value("proxy", ""));
    coc::update_settings(config);
    coc::verify_codex(config);
    boost::asio::io_context io;
    coc::AgentUpdater updater;
    bool restart = false, remote_restart = false;
    {
      coc::Agent agent(io, config, file, updater);
      agent.start();
      io.run();
      restart = agent.update_restart();
      remote_restart = agent.remote_restart();
    }
    if (remote_restart)
      coc::restart_process(argc, argv);
    if (restart && updater.install())
      coc::restart_updated(argc, argv);
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
