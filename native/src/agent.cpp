#include "coc/access.hpp"
#include "coc/approvals.hpp"
#include "coc/build.hpp"
#include "coc/diagnostics.hpp"
#include "coc/external.hpp"
#include "coc/files.hpp"
#include "coc/login.hpp"
#include "coc/projects.hpp"
#include "coc/proxy.hpp"
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
};
struct Runtime {
  std::shared_ptr<CodexProcess> process;
  std::shared_ptr<ExternalThread> reader;
  std::shared_ptr<ExternalApprovals> external_approvals;
  std::string observer_error;
  int64_t epoch = 0, detached = now(), pending_epoch = 0, pending_expires = 0;
  int64_t published_revision = 0;
  bool submitted = false, busy = false, interrupt_pending = false;
  size_t priority = 0;
  std::map<std::string, Approval> approvals;
  std::set<std::string> auto_attempted;
  std::map<std::string, std::string> requests;
  std::deque<Json> commands;
  std::map<std::string, Json> deliveries;
  Json immediate_delivery;
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
  std::shared_ptr<Socket> socket_;
  asio::steady_timer retry_, maintenance_, event_timer_;
  asio::signal_set signals_;
  std::atomic<bool> stopped_{false};
  bool listing_threads_ = false, negotiated_ = false;
  std::set<std::string> archive_loading_;
  int attempts_ = 0;

public:
  Agent(asio::io_context &io, Json c, std::filesystem::path config_file, AgentUpdater &updater)
      : relay_io_(io), relay_work_(asio::make_work_guard(io)), config_(std::move(c)),
        config_file_(std::move(config_file)), updater_(updater), store_(config_["dataDir"]),
        projects_(config_), file_store_(config_["dataDir"], false), files_(&file_store_),
        retry_(io_), maintenance_(io_), event_timer_(io_), signals_(io_, SIGINT, SIGTERM) {}
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
      if (update_restart_)
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
    auto rt = runtimes_.find(id);
    if (rt == runtimes_.end())
      return;
    send({{"type", "notice"},
          {"sessionId", id},
          {"epoch", context.at("epoch")},
          {"heads", store_.delivery_heads(id)},
          {"payload",
           {{"type", "delivery-result"},
            {"stream", stream},
            {"lane", context.at("lane")},
            {"seq", seq},
            {"payload", store_.delivery_record(stream, seq).at("result")},
            {"window", store_.delivery_window(stream)}}}});
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
  Json manage_projects(const Json &d) {
    if (stopped_)
      throw Error("HOST_OFFLINE", "Agent is stopping");
    auto result = projects_.request(d, [this](const std::string &id) {
      if (file_requests_ || listing_threads_ || !archive_loading_.empty())
        return true;
      for (const auto &s : store_.sessions(true))
        if (s.at("projectId") == id && runtimes_.count(s.at("id").get<std::string>()))
          return true;
      return false;
    });
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
    if (d.contains("heads") && d["heads"].is_object()) {
      const auto session =
          d.value("sessionId", d.value("data", Json::object()).value("sessionId", ""));
      for (const auto &lane : {"normal", "priority"}) {
        const auto &heads = d.at("heads");
        if (!heads.contains(lane))
          continue;
        const auto stream = heads.at(lane).value("stream", "");
        const auto sent = heads.at(lane).value("sent", int64_t(0));
        if (!valid_id(stream) || sent < 0 || sent > 9007199254740991LL)
          continue;
        const auto key = "delivery-peer-head:" + stream;
        const auto saved = store_.cache_get(key);
        if (saved.is_null() || saved.get<int64_t>() < sent)
          store_.cache_put(key, sent);
        if (runtimes_.count(session)) {
          try {
            const auto window = store_.delivery_window(stream);
            if (d.contains("delivery") && d["delivery"].value("stream", "") == stream &&
                d["delivery"].value("seq", int64_t(0)) == window.at("received").get<int64_t>() + 1)
              continue;
            if (sent > window.at("received").get<int64_t>())
              notice(session, {{"type", "delivery-window"}, {"lane", lane}, {"window", window}});
          } catch (const Error &error) {
            if (error.code != "NOT_FOUND")
              throw;
          }
        }
      }
    }

    if (type == "hello") {
      if (d.value("minProtocol", 1) > 1 || d.value("demand", 0) != 1) {
        std::cerr << "Relay does not support demand-v1; upgrade the Relay before this Agent\n";
        close();
        return;
      }
      Json capabilities = {{"type", "capabilities"},
                           {"build", Json::parse(COC_BUILD_JSON)},
                           {"protocol", 1},
                           {"delivery", 1},
                           {"deliveryInstance", store_.delivery_instance()}};
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
      auto request = d.at("requestId");
      try {
        control(d.at("action"), d.value("data", Json::object()),
                [this, request, started = now(), action = d.value("action", ""),
                 session_id = d.value("data", Json::object()).value("sessionId", "")](Json data,
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
                  if (!session_id.empty())
                    result["heads"] = store_.delivery_heads(session_id);
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
      rt->rpc_credit = 0;
      rt->rpc_byte_credit = 0;
      rt->rpc_sent = store_.output_state("rpc-output:" + id).at("acked");
    }
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
    Json delivery;
    if (d.contains("delivery")) {
      delivery = d.at("delivery");
      const auto stream = delivery.at("stream").get<std::string>();
      const auto body = delivery.at("body").get<std::string>();
      if (Json::parse(body) != d.at("payload"))
        throw Error("IDEMPOTENCY_CONFLICT", "Delivery body does not match forwarded command");
      Json accepted;
      try {
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
      delivery["epoch"] = incoming_epoch;
      notice(id, {{"type", "delivery-window"},
                  {"lane", delivery.at("lane")},
                  {"window", accepted.at("window")}});
      if (accepted.at("accepted") == false) {
        const auto record = accepted.at("record");
        if (record.at("phase") == "finished")
          delivery_reply(id, delivery, record.at("result"));
        return;
      }
      const auto payload = d.at("payload");
      const auto key = type == "web" ? payload.at("requestId").get<std::string>()
                                     : (payload.contains("id") && payload.contains("method")
                                            ? "rpc:" + id_key(payload.at("id"))
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
        if (rt->priority >= 8) {
          notice(id,
                 {{"type", "error"},
                  {"requestId", payload.value("requestId", Json())},
                  {"error",
                   {{"code", "BACKPRESSURE"}, {"message", "Priority control budget exhausted"}}}});
          return;
        }
        if (!delivery.is_null() &&
            !store_.delivery_start(delivery.at("stream"), delivery.at("seq")))
          return;
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
                    {"requestId", payload.value("requestId", Json())},
                    {"error", {{"code", "BACKPRESSURE"}, {"message", "Web command queue full"}}}});
        return;
      }
      rt->commands.push_back(
          {{"epoch", rt->epoch}, {"payload", d.at("payload")}, {"delivery", delivery}});
      drain(id, rt);
    }
  }
  void control(const std::string &action, const Json &d, Completion done) {
    if (action == "delivery") {
      const auto id = d.at("sessionId").get<std::string>();
      const auto session = store_.get(id);
      if (session.at("mode") != d.at("mode"))
        throw Error("FORBIDDEN", "Wrong delivery session mode");
      const auto stream = d.at("stream").get<std::string>();
      const bool priority = d.at("lane") == "priority";
      auto window = store_.delivery_open(stream, id, priority ? 4 : 16,
                                         priority ? 512 * 1024 : 2 * 1024 * 1024);
      Json result = {{"window", window}};
      if (d.contains("seq")) {
        auto record = store_.delivery_record(stream, d.at("seq"));
        if (record.is_object())
          record.erase("body");
        result["record"] = record;
      }
      done(result, nullptr);
      return;
    }
    if (action == "probe") {
      done({{"online", true}, {"confirmedAt", now()}}, nullptr);
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
    if (action == "projectManage") {
      done(manage_projects(d), nullptr);
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
      for (auto &session : page["data"])
        session["heads"] = store_.delivery_heads(session.at("id"));
      done(d.value("paged", false) ? page : page["data"], nullptr);
      return;
    }
    if (action == "request") {
      if (d.contains("sessionId") && store_.get(d.at("sessionId"))["mode"] != d.at("mode"))
        throw Error("FORBIDDEN", "Wrong credential for session mode");
      auto key = d.contains("sessionId") ? d.at("sessionId").get<std::string>() + ":" : "create:";
      key += d.at("requestId").get<std::string>();
      auto status = store_.request_status(key);
      if (d.contains("sessionId") && status.value("state", "") == "submitted") {
        auto id = d.at("sessionId").get<std::string>();
        auto rt = runtimes_.find(id);
        auto marker = store_.cache_get("external-submission:" + key);
        if (rt != runtimes_.end() && rt->second->reader && !marker.is_null()) {
          rt->second->reader->find_queued(
              marker.at("clientUserMessageId"), [this, key, done](Json result, Json error) {
                if (error.is_null()) {
                  const auto &entry = result.at("queuedSubmission");
                  store_.finish(key, {{"state", "queued"},
                                      {"queueId", entry.at("id")},
                                      {"clientUserMessageId", entry.at("clientUserMessageId")}});
                }
                done(store_.request_status(key), nullptr);
              });
          return;
        }
      }
      done(status, nullptr);
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
        external_answer(s.at("id"),
                        web_command({{"action", "approval"},
                                     {"requestId", d.at("requestId")},
                                     {"approvalId", d.at("approvalId")},
                                     {"allow", d.at("allow")}}),
                        done);
        return;
      }
      Json pending = Json::array();
      if (rt != runtimes_.end())
        for (auto &[key, approval] : rt->second->approvals)
          pending.push_back({{"approvalId", key},
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
      queue_external(
          s.at("id"),
          web_command(
              {{"action", "prompt"}, {"requestId", d.at("requestId")}, {"text", d.at("text")}}),
          done);
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
          (r->epoch > 0 || (r->pending_epoch > 0 && r->pending_expires > now())) &&
          (r->cli_delivery_stream.empty() ||
           d.value("deliveryResume", "") != r->cli_delivery_stream))
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
    if (d.contains("external"))
      fingerprint += ",\"external\":" + d.at("external").dump();
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
    if (s["mode"] == "cli" && !d.value("external", false)) {
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
      if (d.value("external", false)) {
        observe_external(id, rt, key, done);
        return;
      }
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
                             [this, id, rt, key, d, done](Json result, Json error) {
                               if (!error.is_null()) {
                                 if (d.contains("threadId") && active_writer_error(error)) {
                                   observe_external(id, rt, key, done);
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
  void observe_external(const std::string &id, std::shared_ptr<Runtime> rt, const std::string &key,
                        Completion done) {
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
    rt->reader->bootstrap([this, id, key, done](Json result, Json error) {
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
      store_.finish(key, s);
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
        [this, id](Json approval) {
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
          it->second->approvals[key] = {
              Json{{"method", approval.at("method")}, {"params", approval.at("params")}}, now(),
              false, approval.value("unsupported", false)};
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
        });
    rt->external_approvals->start();
  }
  void external_answer(const std::string &id, const Json &cmd, Completion done) {
    const auto s = store_.get(id);
    auto runtime = runtimes_.find(id);
    if (!s.value("external", false) || runtime == runtimes_.end() ||
        !runtime->second->external_approvals || !s.value("approvalForwarding", false) ||
        s["state"] != "ready")
      throw Error("APPROVAL_UNAVAILABLE", "No connection to original approval server");
    const auto key = id + ":" + cmd.at("requestId").get<std::string>();
    auto cached = store_.begin(key, web_fingerprint(cmd));
    if (cached["cached"] == true) {
      done(cached["value"], nullptr);
      return;
    }
    try {
      store_.submitted(key);
      auto result =
          runtime->second->external_approvals->answer(cmd.at("approvalId"), cmd.at("allow"));
      auto approval = runtime->second->approvals.find(cmd.at("approvalId"));
      if (approval != runtime->second->approvals.end())
        approval->second.submitted = true;
      store_.finish(key, result);
      emit(id, "approvalSubmitted", {{"approvalId", cmd.at("approvalId")}});
      done(result, nullptr);
    } catch (const std::exception &error) {
      auto value = error_data(error);
      if (value.value("code", "") != "RESULT_UNKNOWN")
        store_.finish(key, {{"requestError", value}});
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
    const auto key = id + ":" + cmd.at("requestId").get<std::string>();
    const auto marker = "external-submission:" + key;
    auto complete = [this, key, cmd, id, done](Json result, Json error) {
      if (!error.is_null()) {
        if (error.value("code", "") != "RESULT_UNKNOWN")
          store_.finish(key, {{"requestError", error}});
        done(nullptr, error);
        return;
      }
      Json queued = {
          {"state", "queued"},
          {"queueId", result.at("queuedSubmission").at("id")},
          {"clientUserMessageId", result.at("queuedSubmission").at("clientUserMessageId")}};
      store_.finish(key, queued);
      emit(id, "queueAccepted",
           {{"requestId", cmd.at("requestId")},
            {"queueId", queued["queueId"]},
            {"text", cmd.at("text")},
            {"message", "Message queued for the original Codex client"}});
      done(queued, nullptr);
    };
    Json cached;
    try {
      cached = store_.begin(key, web_fingerprint(cmd));
    } catch (const Error &error) {
      if (error.code != "RESULT_UNKNOWN")
        throw;
      auto saved = store_.cache_get(marker);
      if (saved.is_null()) {
        done(nullptr, error_data(error));
        return;
      }
      reader->find_queued(saved.at("clientUserMessageId"), complete);
      return;
    }
    if (cached["cached"] == true) {
      done(cached["value"], nullptr);
      return;
    }
    const auto client_id = uuid();
    store_.cache_put(marker, {{"clientUserMessageId", client_id}});
    auto submitted = [this, key] { store_.submitted(key); };
    reader->enqueue(cmd.at("text"), client_id, submitted, complete);
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
    if (archive_loading_.count(id))
      throw Error("BACKPRESSURE", "Archive page is already loading");
    archive_loading_.insert(id);
    auto read = [this, id, process, temporary, done]() {
      auto s = store_.get(id);
      if (!s.value("external", false)) {
        read_archive(id, process, temporary, 10, done);
        return;
      }
      process->request("thread/read", {{"threadId", s.at("threadId")}, {"includeTurns", false}},
                       [this, id, process, temporary, done](Json result, Json error) {
                         try {
                           if (!error.is_null())
                             throw Error(error.at("code"), error.at("message"));
                           auto s = store_.get(id);
                           if (result.at("thread").at("id") != s.at("threadId") ||
                               !same_project_path(result.at("thread").value("cwd", ""),
                                                  project(s.at("projectId")).at("path")))
                             throw Error("FORBIDDEN", "External thread belongs to another project");
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
    auto it = runtimes_.find(id);
    if (it != runtimes_.end() && !it->second->immediate_delivery.is_null()) {
      delivery_reply(id, it->second->immediate_delivery, m);
      return;
    }
    if (it != runtimes_.end() && m.contains("id") && !m.contains("method")) {
      auto found = it->second->deliveries.find("rpc:" + id_key(m.at("id")));
      if (found != it->second->deliveries.end()) {
        auto context = found->second;
        it->second->deliveries.erase(found);
        delivery_reply(id, context, m);
        return;
      }
    }
    if (it != runtimes_.end() && it->second->rpc_delivery) {
      store_.output_append("rpc-output:" + id, m);
      flush_rpc_output(id, it->second);
      return;
    }
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
      if (s["mode"] != "cli" || s.value("external", false))
        throw Error("FORBIDDEN", "External readers use history and queue commands");
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
    if (s.value("external", false)) {
      if (!method.empty() && m.contains("id"))
        rt->process->send(
            {{"id", m["id"]},
             {"error",
              {{"code", -32601}, {"message", "External reader does not handle approvals"}}}});
      return;
    }
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
      rt->approvals[key] = {m, now()};
      if (s["mode"] == "web") {
        emit(id, "approval",
             {{"approvalId", key},
              {"method", method},
              {"params", m.value("params", Json::object())}});
        auto_approve(id, key);
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
      if (!d.value("delivery", Json()).is_null()) {
        auto error = Json{
            {"type", "error"},
            {"requestId", d["payload"].value("requestId", "")},
            {"error",
             {{"code", "STALE_CONTROLLER"}, {"message", "Controller changed before execution"}}}};
        rt->deliveries.erase(d["payload"].value("requestId", ""));
        delivery_reply(id, d.at("delivery"), error);
      }
      drain(id, rt);
      return;
    }
    if (!d.value("delivery", Json()).is_null() &&
        !store_.delivery_start(d["delivery"]["stream"], d["delivery"]["seq"])) {
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
      const auto key = id + ":" + cmd.at("requestId").get<std::string>();
      auto cached = store_.begin(key, web_fingerprint(cmd));
      if (cached["cached"] == true) {
        notice(id, {{"type", "ack"}, {"requestId", cmd["requestId"]}, {"result", cached["value"]}});
        done(cached["value"], nullptr);
        return;
      }
      store_.submitted(key);
      s["autoApproval"] = cmd.at("enabled");
      store_.save(s);
      Json result = {{"autoApproval", s["autoApproval"]}};
      store_.finish(key, result);
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
      Json params = {{"threadId", s.at("threadId")},
                     {"input", Json::array({{{"type", "text"},
                                             {"text", cmd["text"]},
                                             {"text_elements", Json::array()}}})}};
      if (cmd.contains("model"))
        params["model"] = cmd["model"];
      rt->process->request("turn/start", params, [this, id, complete](Json result, Json error) {
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
    if (!rt->auto_attempted.insert(key).second)
      return;
    try {
      if (s.value("external", false)) {
        unsigned char hash[SHA256_DIGEST_LENGTH];
        SHA256(reinterpret_cast<const unsigned char *>(key.data()), key.size(), hash);
        std::string request = "auto-";
        for (auto byte : hash) {
          request += "0123456789abcdef"[byte >> 4];
          request += "0123456789abcdef"[byte & 15];
        }
        external_answer(
            id,
            {{"action", "approval"}, {"requestId", request}, {"approvalId", key}, {"allow", true}},
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
    emit(id, "sessionClosed", {{"state", s["state"]}});
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
        for (auto &[id, r] : runtimes_) {
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
    project_control_.reset();
    event_timer_.cancel();
    asio::post(file_pool_, [this] { files_.clear(); });
    retry_.cancel();
    maintenance_.cancel();
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
