#include "coc/login.hpp"
#include "coc/store.hpp"
#include <csignal>
#include <iostream>
#include <map>
#include <openssl/rand.h>
#include <set>
namespace coc {
struct Approval {
  Json rpc;
  int64_t time;
};
struct Runtime {
  std::shared_ptr<CodexProcess> process;
  int64_t epoch = 0, detached = now();
  bool submitted = false, busy = false;
  std::map<std::string, Approval> approvals;
  std::map<std::string, std::string> requests;
  std::deque<Json> commands;
};
class Agent {
  asio::io_context &io_;
  Json config_;
  Store store_;
  std::map<std::string, std::shared_ptr<Runtime>> runtimes_;
  std::shared_ptr<Socket> socket_;
  asio::steady_timer retry_, maintenance_;
  asio::signal_set signals_;
  bool stopped_ = false;
  int attempts_ = 0;
  int64_t pong_ = now();

public:
  Agent(asio::io_context &io, Json c)
      : io_(io), config_(std::move(c)), store_(config_["dataDir"]), retry_(io), maintenance_(io),
        signals_(io, SIGINT, SIGTERM) {}
  void start() {
    signals_.async_wait([this](auto ec, int) {
      if (!ec)
        close();
    });
    connect();
    maintain();
  }
  void connect() {
    if (stopped_)
      return;
    pong_ = now();
    socket_ = connect_socket(
        io_, relay_url(config_["relayUrl"]), config_["token"], [this](Json d) { receive(d); },
        [this](unsigned code) {
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
        });
    socket_->start();
  }
  void send(const Json &d) {
    if (socket_)
      socket_->send(d);
  }
  void notice(const std::string &id, const Json &p) {
    auto r = runtimes_.find(id);
    if (r != runtimes_.end())
      send({{"type", "notice"}, {"sessionId", id}, {"epoch", r->second->epoch}, {"payload", p}});
  }
  void emit(const std::string &id, const std::string &type, const Json &data) {
    auto event = store_.event(id, type, redact(data));
    auto r = runtimes_.find(id);
    if (r != runtimes_.end())
      send({{"type", "event"},
            {"sessionId", id},
            {"epoch", r->second->epoch},
            {"payload", {{"type", "event"}, {"event", event}}}});
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
    auto type = d.value("type", "");
    if (type == "hello") {
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
                [this, request](Json data, Json error) {
                  Json result = {{"type", "result"}, {"requestId", request}};
                  if (error.is_null())
                    result["data"] = data;
                  else
                    result["error"] = error;
                  send(result);
                });
      } catch (const std::exception &e) {
        send({{"type", "result"}, {"requestId", request}, {"error", error_data(e)}});
      }
      return;
    }
    auto id = d.value("sessionId", "");
    auto it = runtimes_.find(id);
    if (it == runtimes_.end() || it->second->epoch != d.value("epoch", int64_t(-1)))
      return;
    auto rt = it->second;
    if (type == "detach")
      rt->detached = now();
    else if (type == "rpc")
      cli(id, d.at("payload"));
    else if (type == "web") {
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
    if (action == "projects") {
      done(config_["projects"], nullptr);
      return;
    }
    if (action == "list") {
      done(store_.sessions(), nullptr);
      return;
    }
    if (action == "get") {
      done(store_.get(d.at("sessionId")), nullptr);
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
      if (s["mode"] == "cli" && r->epoch > 0)
        throw Error("CLI_REATTACH_UNSUPPORTED", "End this CLI session and create a new one");
      r->epoch = d.at("epoch");
      r->detached = 0;
      done({{"ok", true}}, nullptr);
      return;
    }
    if (action != "create")
      throw Error("UNSUPPORTED_ACTION", "Unknown control action");
    auto key = "create:" + d.at("key").get<std::string>();
    auto cached = store_.begin(key, "{\"projectId\":" + d.at("projectId").dump() +
                                        ",\"mode\":" + d.at("mode").dump() + "}");
    if (cached["cached"] == true) {
      done(cached["value"], nullptr);
      return;
    }
    auto p = project(d.at("projectId"));
    if (d.at("mode") != "cli" && d.at("mode") != "web")
      throw Error("INVALID_REQUEST", "Invalid session mode");
    if (runtimes_.size() >= 4)
      throw Error("CAPACITY", "At most four active sessions");
    Json s = {{"id", config_["hostId"].get<std::string>() + "~" + uuid()},
              {"projectId", d.at("projectId")},
              {"mode", d.at("mode")},
              {"sandbox", config_["sandbox"]},
              {"state", "ready"},
              {"running", false},
              {"createdAt", now()}};
    auto id = s["id"].get<std::string>();
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
    rt->process->initialize([this, id, rt, key, done](Json, Json error) {
      if (!error.is_null()) {
        stop(id);
        done(nullptr, error);
        return;
      }
      auto s = store_.get(id);
      rt->process->request("thread/start",
                           {{"cwd", project(s["projectId"])["path"]},
                            {"sandbox", config_["sandbox"]},
                            {"approvalPolicy", "on-request"}},
                           [this, id, key, done](Json result, Json error) {
                             if (!error.is_null()) {
                               stop(id);
                               done(nullptr, error);
                               return;
                             }
                             auto current = store_.get(id);
                             current["threadId"] = result.at("thread").at("id");
                             store_.save(current);
                             store_.finish(key, current);
                             done(current, nullptr);
                           });
    });
  }
  void check_busy(const Json &s) {
    for (auto &o : store_.sessions())
      if (o["id"] != s["id"] && o["projectId"] == s["projectId"] && o["state"] == "ready" &&
          o["running"] == true)
        throw Error("PROJECT_BUSY", "Another session is executing in this project");
  }
  void rpc(const std::string &id, const Json &m) {
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
    if (s["mode"] == "cli")
      rpc(id, m);
    else if (!method.empty())
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
      if (error.is_null()) {
        store_.finish(key, result);
        notice(id, {{"type", "ack"}, {"requestId", cmd["requestId"]}, {"result", result}});
      }
      done(result, error);
    };
    if (action == "prompt") {
      if (s["running"] == true)
        throw Error("TURN_BUSY", "A turn is already running");
      check_busy(s);
      s["running"] = true;
      store_.save(s);
      emit(id, "user", {{"text", cmd["text"]}});
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
    if (action == "approval")
      answer(id, cmd["approvalId"], cmd["allow"]);
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
    if (s["state"] != "closed")
      s["state"] = "failed";
    s["running"] = false;
    store_.save(s);
    emit(id, "sessionClosed", {{"state", s["state"]}});
    runtimes_.erase(id);
  }
  void stop(const std::string &id) {
    auto s = store_.get(id);
    s["state"] = "closed";
    s["running"] = false;
    store_.save(s);
    auto it = runtimes_.find(id);
    if (it != runtimes_.end()) {
      auto p = it->second->process;
      if (s.contains("turnId"))
        p->request("turn/interrupt", {{"threadId", s.at("threadId")}, {"turnId", s.at("turnId")}},
                   [](Json, Json) {});
      p->close();
    }
  }
  void maintain() {
    maintenance_.expires_after(std::chrono::seconds(30));
    maintenance_.async_wait([this](auto ec) {
      if (ec || stopped_)
        return;
      try {
        if (now() - pong_ > 90000)
          socket_->close();
        else
          send({{"type", "ping"}});
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
        store_.cleanup();
      } catch (...) {
        for (auto &[id, r] : runtimes_)
          stop(id);
      }
      maintain();
    });
  }
  void close() {
    if (stopped_)
      return;
    stopped_ = true;
    retry_.cancel();
    maintenance_.cancel();
    signals_.cancel();
    if (socket_)
      socket_->close();
    for (auto &[id, r] : runtimes_)
      stop(id);
  }
};
} // namespace coc
int main(int argc, char **argv) {
  try {
    signal(SIGPIPE, SIG_IGN);
    coc::Options options(argc, argv);
    auto command = options.args.empty() ? "help" : options.args[0];
    auto file = std::filesystem::path(options.get(
        "config", coc::config_path("COC_AGENT_CONFIG", "coc-agent/agent.json").string()));
    if (command == "help") {
      std::cout << "Usage: coc-agent <login|logout|status|run> [--config PATH] [--relay URL] "
                   "[--name NAME] [--project PATH] [--project-id ID] [--api-key]\n"
                   "login --api-key: read COC_API_KEY or prompt securely; otherwise approve the "
                   "displayed request in the management website. logout only "
                   "removes local credentials.\n";
      return 0;
    }
    if (options.api_key && command != "login")
      throw coc::Error("USAGE", "--api-key is only valid for login");
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
    coc::verify_codex(config);
    boost::asio::io_context io;
    coc::Agent agent(io, config);
    agent.start();
    io.run();
    return 0;
  } catch (const std::exception &e) {
    std::cerr << coc::error_data(e).dump() << '\n';
    return 1;
  }
}
