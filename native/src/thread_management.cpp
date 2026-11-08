#include "coc/thread_management.hpp"
#include "coc/delivery.hpp"
#include "coc/external.hpp"
#include <set>
namespace coc {
Json Store::thread_state(const std::string &thread) {
  const auto rows = query("SELECT value FROM transport2_thread_state WHERE thread=?", {thread});
  return rows.empty() ? Json() : Json::parse(rows[0]["value"].get<std::string>());
}
Json Store::thread_job(const std::string &key) {
  const auto rows = query("SELECT value FROM transport2_thread_jobs WHERE key=?", {key});
  return rows.empty() ? Json() : Json::parse(rows[0]["value"].get<std::string>());
}
bool Store::thread_pending(const std::string &thread) {
  return !query("SELECT 1 FROM transport2_thread_jobs j,json_each(j.value,'$.threads') t "
                "WHERE json_extract(t.value,'$.id')=? LIMIT 1",
                {thread})
              .empty();
}
void Store::thread_plan(const std::string &key, const Json &plan) {
  if (key.empty() || plan.dump().size() > 64 * 1024 || plan.at("threads").size() > 128)
    throw Error("BACKPRESSURE", "Thread management plan exceeds its budget");
  run("BEGIN IMMEDIATE");
  try {
    for (const auto &thread : plan.at("threads"))
      if (thread_pending(thread.at("id")))
        throw Error("RESULT_PENDING", "Another original operation is managing this thread");
    size_t added = 0;
    for (const auto &thread : plan.at("threads")) {
      const auto state = thread_state(thread.at("id"));
      if (!state.is_null() && state.value("deleted", false))
        throw Error("SESSION_DELETED", "Thread was permanently deleted");
      added += state.is_null();
      for (const auto &row :
           query("SELECT id FROM sessions WHERE json_extract(value,'$.threadId')=?",
                 {thread.at("id")})) {
        const auto session = row.at("id");
        if (!query("SELECT 1 FROM transport2_history_entries WHERE session=? AND key GLOB "
                   "'reservation:*' LIMIT 1",
                   {session})
                 .empty() ||
            !query("SELECT 1 FROM transport2_commands c JOIN transport2_credit f ON "
                   "f.stream=c.stream "
                   "LEFT JOIN transport2_result_heads h ON h.stream=c.stream "
                   "LEFT JOIN transport2_results r ON r.stream=c.stream AND r.command_seq=c.seq "
                   "WHERE f.session=? AND (c.phase!='finished' OR r.seq>h.acked OR "
                   "json_extract(c.result,'$.error.code') IN ('RESULT_UNKNOWN','RESULT_PENDING')) "
                   "LIMIT 1",
                   {session})
                 .empty())
          throw Error("RESULT_PENDING",
                      "Resolve pending original commands before managing this thread");
      }
    }
    const auto count =
        query("SELECT COUNT(*) AS n FROM transport2_thread_state")[0]["n"].get<int64_t>();
    if (count + added > 4096)
      throw Error("BACKPRESSURE", "Thread management identity budget is full");
    run("INSERT INTO transport2_thread_jobs(key,value) VALUES(?,?)", {key, plan.dump()});
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::thread_abandon(const std::string &key) {
  run("DELETE FROM transport2_thread_jobs WHERE key=?", {key});
}
Json Store::thread_apply(const std::string &key, const Json &threads) {
  run("BEGIN IMMEDIATE");
  try {
    const auto plan = thread_job(key);
    if (plan.is_null())
      throw Error("RESULT_UNKNOWN", "Thread operation plan is unavailable");
    const bool deleted = plan.at("operation") == "delete";
    const bool archived = plan.at("operation") == "archive";
    Json result = {{"operation", plan.at("operation")},
                   {"threadIds", Json::array()},
                   {"sessionIds", Json::array()},
                   {"archived", archived},
                   {"deleted", deleted},
                   {"partial", threads.size() != plan.at("threads").size()}};
    for (const auto &thread : threads) {
      const auto id = thread.at("id");
      result["threadIds"].push_back(id);
      const Json state = {
          {"projectId", plan.at("projectId")}, {"archived", archived}, {"deleted", deleted}};
      run("INSERT INTO transport2_thread_state(thread,value) VALUES(?,?) ON CONFLICT(thread) "
          "DO UPDATE SET value=excluded.value",
          {id, state.dump()});
      for (const auto &row :
           query("SELECT id,value FROM sessions WHERE json_extract(value,'$.threadId')=?", {id})) {
        auto s = Json::parse(row.at("value").get<std::string>());
        const auto session = row.at("id");
        result["sessionIds"].push_back(session);
        if (deleted) {
          delivery_retire_session(session);
          // Keep closed flow identities, but erase conversation/command/result bodies.
          const std::string streams = " IN (SELECT stream FROM transport2_credit WHERE session=?)";
          for (const auto *table :
               {"transport2_commands", "transport2_results", "transport2_result_content"})
            run(std::string("DELETE FROM ") + table + " WHERE stream" + streams, {session});
          for (const auto *table : {"chunks", "bodies"})
            run(std::string("DELETE FROM ") + table +
                    " WHERE seq IN(SELECT seq FROM history WHERE session=?)",
                {session});
          for (const auto *table : {"events", "history", "streams", "external_items",
                                    "transport2_history_subscriptions"})
            run(std::string("DELETE FROM ") + table + " WHERE session=?", {session});
          run("DELETE FROM transport2_outputs WHERE stream=?",
              {"rpc-output:" + session.get<std::string>()});
          run("DELETE FROM transport2_history_heads WHERE session=?", {session});
          run("UPDATE sessions SET source=NULL WHERE id=?", {session});
          s = {{"id", session},
               {"projectId", s.at("projectId")},
               {"threadId", id},
               {"mode", s.at("mode")},
               {"state", "closed"},
               {"running", false},
               {"createdAt", s.at("createdAt")},
               {"deleted", true}};
        } else
          s["archived"] = archived;
        save(s);
      }
    }
    // The CoC mutation and terminal original result commit together.
    run("UPDATE transport2_operations SET phase='completed',result=? WHERE key=?",
        {Json{{"data", result}}.dump(), key});
    run("DELETE FROM transport2_thread_jobs WHERE key=?", {key});
    run("COMMIT");
    return result;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
namespace {
class Management : public std::enable_shared_from_this<Management> {
  Store &store_;
  Json request_, plan_, catalog_ = Json::object();
  std::string key_, cwd_;
  std::shared_ptr<CodexProcess> process_;
  std::function<void(const Json &)> check_;
  Completion done_;
  bool archived_ = false, recovery_ = false, verifying_ = false, finished_ = false;
  size_t pages_ = 0;
  std::set<std::string> cursors_;
  void finish(Json data, Json error) {
    if (finished_)
      return;
    finished_ = true;
    process_->close();
    done_(std::move(data), std::move(error));
  }
  template <class F> void guard(F action) {
    if (finished_)
      return;
    try {
      action();
    } catch (const std::exception &e) {
      finish(nullptr, error_data(e));
    }
  }
  void scan(const Json &cursor = nullptr) {
    if (++pages_ > 64)
      throw Error("BACKPRESSURE", "Thread catalog exceeds management scan budget");
    auto self = shared_from_this();
    process_->request(
        "thread/list",
        {{"archived", archived_},
         {"limit", 100},
         {"cursor", cursor},
         {"modelProviders", Json::array()},
         {"sourceKinds",
          Json::array({"cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
                       "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"})}},
        [self](Json result, Json error) {
          self->guard([&] {
            if (!error.is_null()) {
              self->finish(nullptr, error);
              return;
            }
            for (const auto &t : result.at("data")) {
              const auto id = t.at("id").get<std::string>();
              if (!valid_id(id) || self->catalog_.size() >= 4096)
                throw Error("BACKPRESSURE", "Thread catalog exceeds management budget");
              Json row;
              for (const auto *field :
                   {"id", "cwd", "createdAt", "status", "parentThreadId", "source", "ephemeral"})
                if (t.contains(field))
                  row[field] = t.at(field);
              row["archived"] = self->archived_;
              self->catalog_[id] = row;
            }
            const auto next = result.value("nextCursor", Json());
            if (!next.is_null()) {
              if (!next.is_string() || !self->cursors_.insert(next.get<std::string>()).second)
                throw Error("INVALID_RESPONSE", "Codex repeated a thread catalog cursor");
              self->scan(next);
            } else if (!self->archived_) {
              self->archived_ = true;
              self->cursors_.clear();
              self->scan();
            } else
              self->catalog_ready();
          });
        });
  }
  void catalog_ready() {
    const auto root = request_.at("threadId").get<std::string>();
    const auto action = request_.at("operation").get<std::string>();
    if (recovery_ || verifying_) {
      Json changed = Json::array();
      for (const auto &thread : plan_.at("threads")) {
        const auto id = thread.at("id").get<std::string>();
        const bool found = catalog_.contains(id);
        if (found && (catalog_.at(id).at("createdAt") != thread.at("createdAt") ||
                      !same_project_path(catalog_.at(id).at("cwd"), cwd_)))
          throw Error("DELIVERY_STATE_MISMATCH", "Codex thread identity changed during management");
        const bool expected =
            action == "delete" ? !found
                               : found && catalog_.at(id).at("archived") == (action == "archive");
        if (expected)
          changed.push_back(thread);
        else if (action != "archive" || id == root)
          throw Error("RESULT_UNKNOWN",
                      "Codex mutation is unconfirmed; the original request remains pending");
      }
      // Archive may succeed for the root while some descendants remain unarchived.
      auto result = store_.thread_apply(key_, changed);
      finish(result, nullptr);
      return;
    }
    if (!catalog_.contains(root))
      throw Error("THREAD_NOT_FOUND", "Codex thread does not exist");
    std::set<std::string> ids{root};
    if (action != "unarchive") {
      bool again;
      do {
        again = false;
        for (const auto &entry : catalog_.items()) {
          const auto &t = entry.value();
          std::string parent;
          if (t.contains("parentThreadId") && t.at("parentThreadId").is_string())
            parent = t.at("parentThreadId");
          else if (t.contains("source") && t.at("source").is_object()) {
            const auto sub = t.at("source").value("subAgent", Json::object());
            if (sub.is_object() && sub.contains("thread_spawn"))
              parent = sub.at("thread_spawn").value("parent_thread_id", "");
          }
          if (ids.count(parent) && ids.insert(entry.key()).second)
            again = true;
        }
      } while (again);
    }
    plan_ = request_;
    plan_["threads"] = Json::array();
    for (const auto &id : ids) {
      const auto &t = catalog_.at(id);
      if (!same_project_path(t.at("cwd"), cwd_))
        throw Error("FORBIDDEN", "Thread subtree crosses the requested project");
      if (t.value("ephemeral", false))
        throw Error("INVALID_REQUEST", "Ephemeral thread cannot be managed");
      const auto status = t.value("status", Json::object()).value("type", "unknown");
      if (status != "idle" && status != "notLoaded")
        throw Error("SESSION_BUSY", "Codex thread must be idle before management");
      check_(t);
      plan_["threads"].push_back({{"id", id}, {"createdAt", t.at("createdAt")}});
    }
    store_.thread_plan(key_, plan_);
    auto self = shared_from_this();
    process_->request("thread/" + action, {{"threadId", root}}, [self](Json, Json error) {
      self->guard([&] {
        if (!error.is_null()) {
          if (error.value("rpc", Json::object()).value("code", Json()) == -32601) {
            self->store_.thread_abandon(self->key_);
            error = {{"code", "UPGRADE_REQUIRED"},
                     {"message", "Installed Codex does not support this thread operation"}};
          }
          self->finish(nullptr, error);
          return;
        }
        self->verifying_ = true;
        self->catalog_ = Json::object();
        self->archived_ = false;
        self->pages_ = 0;
        self->cursors_.clear();
        self->scan();
      });
    });
  }

public:
  Management(asio::io_context &io, const Json &config, std::string cwd, Store &store, Json request,
             std::string key, std::function<void(const Json &)> check, Completion done)
      : store_(store), request_(std::move(request)), key_(std::move(key)), cwd_(std::move(cwd)),
        check_(std::move(check)), done_(std::move(done)) {
    plan_ = store_.thread_job(key_);
    recovery_ = !plan_.is_null();
    process_ = std::make_shared<CodexProcess>(
        io, config, cwd_, [](Json) {}, [] {}, CodexProcessRole::reader);
  }
  void start() {
    process_->start();
    auto self = shared_from_this();
    process_->initialize([self](Json, Json error) {
      self->guard([&] {
        if (!error.is_null())
          self->finish(nullptr, error);
        else
          self->scan();
      });
    });
  }
};
} // namespace
void manage_thread(asio::io_context &io, const Json &config, const std::string &cwd, Store &store,
                   const Json &request, const std::string &operation,
                   std::function<void(const Json &)> check_idle, Completion done) {
  auto management = std::make_shared<Management>(io, config, cwd, store, request, operation,
                                                 std::move(check_idle), std::move(done));
  management->start();
}
} // namespace coc
