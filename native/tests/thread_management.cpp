#include "coc/thread_management.hpp"
#include <fstream>
#include <iostream>
using namespace coc;
namespace {
void check(bool ok, const std::string &message) {
  if (!ok)
    throw std::runtime_error(message);
}
struct Fixture {
  std::filesystem::path root =
      std::filesystem::temp_directory_path() / ("coc-management-" + uuid());
  Fixture() { std::filesystem::create_directories(root); }
  ~Fixture() { std::filesystem::remove_all(root); }
  void write(const Json &state) { std::ofstream(root / ".thread-management.json") << state; }
  Json read() {
    std::ifstream input(root / ".thread-management.json");
    Json state;
    input >> state;
    return state;
  }
  Json thread(const std::string &id, const std::string &parent = "") {
    return {{"id", id},
            {"cwd", root.u8string()},
            {"createdAt", 1},
            {"status", {{"type", "notLoaded"}}},
            {"parentThreadId", parent.empty() ? Json() : Json(parent)},
            {"archived", false}};
  }
  Json run(
      Store &store, const Json &request, const std::string &key,
      std::function<void(const Json &)> idle = [](const Json &) {}) {
    asio::io_context io;
    Json answer;
    bool finished = false;
    asio::steady_timer deadline(io, std::chrono::seconds(10));
    deadline.async_wait([&](auto error) {
      if (!error) {
        answer = {{"error", {{"code", "TIMEOUT"}}}};
        io.stop();
      }
    });
    manage_thread(io,
                  {{"codexPath",
#ifdef _WIN32
                    COC_HISTORY_TEST_NODE
#else
                       "node"
#endif
                   },
                   {"codexArgs", Json::array({std::string(COC_SOURCE_DIR) +
                                              "/tests/fixtures/thread-management.mjs"})},
                   {"sandbox", "read-only"}},
                  root.u8string(), store, request, key, idle, [&](Json data, Json error) {
                    answer = error.is_null() ? Json{{"data", data}} : Json{{"error", error}};
                    finished = true;
                    deadline.cancel();
                  });
    io.run();
    check(finished, "Management timed out");
    return answer;
  }
};
Json begin(Store &store, const Json &request) {
  return store.operation_begin({{"owner", std::string(64, 'a')},
                                {"requestId", uuid()},
                                {"instance", store.operation_instance()}},
                               "threadManage", request);
}
Json request(const std::string &operation, const std::string &thread = "root") {
  return {{"projectId", "project"},
          {"threadId", thread},
          {"operation", operation},
          {"mode", "web"},
          {"confirm", operation == "delete"}};
}
void lifecycle() {
  Fixture f;
  Store store((f.root / "state").u8string());
  auto fork = f.thread("fork");
  fork["forkedFromId"] = "root";
  f.write({{"threads", Json::array({f.thread("root"), f.thread("child", "root"), fork})}});
  for (const auto &id : {"s1", "s2"}) {
    store.save({{"id", id},
                {"projectId", "project"},
                {"threadId", "root"},
                {"mode", "web"},
                {"state", "closed"},
                {"running", false},
                {"createdAt", 1}});
    store.event(id, "message", {{"text", "private transcript"}});
  }
  auto r = request("archive");
  auto op = begin(store, r);
  auto result = f.run(store, r, op.at("key"));
  check(result.contains("data") && result.at("data").at("threadIds").size() == 2, result.dump());
  check(store.get("s1").at("archived") && store.get("s2").at("archived"),
        "All CoC associations must archive");
  check(store.history("s1").at("events").size() == 1, "Archive must preserve history");
  check(!f.read().at("threads")[2].at("archived"), "Independent fork must not cascade");
  r = request("unarchive");
  op = begin(store, r);
  result = f.run(store, r, op.at("key"));
  check(result.at("data").at("threadIds").size() == 1 && !store.get("s1").at("archived"),
        "Unarchive restores only the requested root");
  check(f.read().at("threads")[1].at("archived"), "Unarchive must retain archived descendant");
  r = request("delete");
  op = begin(store, r);
  result = f.run(store, r, op.at("key"));
  check(result.at("data").at("threadIds").size() == 2 &&
            result.at("data").at("sessionIds").size() == 2,
        result.dump());
  check(f.read().at("threads").size() == 1 && f.read().at("threads")[0].at("id") == "fork",
        "Delete root and archived child only");
  check(store.sessions().empty() && store.history("s1").at("events").empty(),
        "Deleted sessions retain no transcript");
  check(store.session_page(Json::object()).at("data")[0].at("deleted"),
        "Catalog must synchronize tombstones");
  try {
    store.get("s1");
    throw std::runtime_error("Deleted session remained accessible");
  } catch (const Error &e) {
    check(e.code == "SESSION_DELETED", e.what());
  }
  check(store.thread_job(op.at("key")).is_null(), "Completed plan must retire atomically");
}
void admission() {
  for (const auto &scenario : {"cross-project", "busy", "pending", "unsupported"}) {
    Fixture f;
    Store store((f.root / "state").u8string());
    auto child = f.thread("child", "root");
    if (std::string(scenario) == "cross-project")
      child["cwd"] = (f.root / "outside").u8string();
    if (std::string(scenario) == "busy")
      child["status"]["type"] = "active";
    f.write({{"threads", Json::array({f.thread("root"), child})},
             {"unsupported", std::string(scenario) == "unsupported"}});
    if (std::string(scenario) == "pending") {
      store.save({{"id", "session"}, {"threadId", "root"}, {"state", "closed"}});
      store.history_reserve("session", 65536, 16, "unresolved-request");
    }
    const auto r = request("delete");
    const auto op = begin(store, r);
    const auto result = f.run(store, r, op.at("key"));
    const std::string code = std::string(scenario) == "cross-project" ? "FORBIDDEN"
                             : std::string(scenario) == "busy"        ? "SESSION_BUSY"
                             : std::string(scenario) == "pending"     ? "RESULT_PENDING"
                                                                      : "UPGRADE_REQUIRED";
    check(result.at("error").at("code") == code, result.dump());
    check(f.read().value("mutations", 0) == 0 && store.thread_job(op.at("key")).is_null(),
          "Admission must not mutate or leave a plan");
  }
}
void recovery() {
  Fixture f;
  std::string key;
  auto r = request("delete");
  f.write({{"threads", Json::array({f.thread("root"), f.thread("child", "root")})},
           {"dropReply", true}});
  {
    Store store((f.root / "state").u8string());
    auto op = begin(store, r);
    key = op.at("key");
    auto result = f.run(store, r, key);
    check(result.at("error").at("code") == "RESULT_UNKNOWN" && !store.thread_job(key).is_null(),
          "Lost response must retain original plan");
    store.retention_cleanup(now() + 14LL * 24 * 60 * 60 * 1000);
    check(!store.thread_job(key).is_null(), "Retention cannot erase an unresolved mutation plan");
  }
  Store store((f.root / "state").u8string());
  auto result = f.run(store, r, key);
  check(result.at("data").at("deleted") && f.read().at("mutations") == 1,
        "Restart must verify deletion without redispatch");
  // Recovery with no proven mutation keeps the original pending; no new dispatch.
  Fixture untouched;
  Store other((untouched.root / "state").u8string());
  untouched.write({{"threads", Json::array({untouched.thread("root")})}});
  auto op = begin(other, r);
  other.thread_plan(op.at("key"), {{"operation", "delete"},
                                   {"projectId", "project"},
                                   {"threads", Json::array({{{"id", "root"}, {"createdAt", 1}}})}});
  result = untouched.run(other, r, op.at("key"));
  check(result.at("error").at("code") == "RESULT_UNKNOWN" &&
            untouched.read().value("mutations", 0) == 0,
        "Unproven crash boundary must not redispatch");
}
void partial_and_rollback() {
  Fixture f;
  Store store((f.root / "state").u8string());
  f.write(
      {{"threads", Json::array({f.thread("root"), f.thread("child", "root")})}, {"partial", true}});
  auto r = request("archive");
  auto op = begin(store, r);
  auto result = f.run(store, r, op.at("key"));
  check(result.at("data").at("partial") && result.at("data").at("threadIds").size() == 1,
        "Partial archive must report actual affected subtree");
  store.save({{"id", "s"},
              {"projectId", "project"},
              {"threadId", "root"},
              {"mode", "web"},
              {"createdAt", 1},
              {"state", "closed"}});
  store.event("s", "message", {{"text", "keep until committed"}});
  sqlite3 *db = nullptr;
  check(sqlite3_open((f.root / "state" / "agent.db").u8string().c_str(), &db) == SQLITE_OK,
        "Open fault connection");
  check(sqlite3_exec(db,
                     "CREATE TRIGGER reject_delete BEFORE DELETE ON history BEGIN SELECT "
                     "RAISE(ABORT,'injected'); END",
                     nullptr, nullptr, nullptr) == SQLITE_OK,
        "Inject fault");
  r = request("delete");
  op = begin(store, r);
  result = f.run(store, r, op.at("key"));
  check(result.contains("error") && !store.get("s").value("deleted", false) &&
            store.history("s").at("events").size() == 1,
        "Cleanup failure must roll back CoC state");
  check(sqlite3_exec(db, "DROP TRIGGER reject_delete", nullptr, nullptr, nullptr) == SQLITE_OK,
        "Remove fault");
  sqlite3_close(db);
  result = f.run(store, r, op.at("key"));
  check(result.at("data").at("deleted") && f.read().at("mutations") == 2,
        "Cleanup recovery must not repeat delete");
}
} // namespace
int main() {
  try {
    lifecycle();
    admission();
    recovery();
    partial_and_rollback();
    std::cout << "Thread management passed\n";
    return 0;
  } catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
}
