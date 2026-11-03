#include "coc/delivery.hpp"
#include "coc/store.hpp"
#include <iostream>
using namespace coc;
namespace {
void check(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class F> void rejects(F action, const std::string &code) {
  try {
    action();
  } catch (const Error &error) {
    if (error.code != code)
      throw std::runtime_error("Expected " + code + ", got " + error.code + ": " + error.what());
    return;
  }
  throw std::runtime_error("Expected " + code);
}
struct Temp {
  std::filesystem::path path = std::filesystem::temp_directory_path() / ("coc-retention-" + uuid());
  ~Temp() { std::filesystem::remove_all(path); }
  std::string dir() const { return path.u8string(); }
};
Json intent(Store &store, const std::string &id) {
  return {
      {"owner", std::string(64, 'a')}, {"requestId", id}, {"instance", store.operation_instance()}};
}
void sql(const Temp &temp, const std::string &statement) {
  sqlite3 *db = nullptr;
  check(sqlite3_open((temp.path / "agent.db").u8string().c_str(), &db) == SQLITE_OK,
        "Open fixture");
  char *error = nullptr;
  const auto result = sqlite3_exec(db, statement.c_str(), nullptr, nullptr, &error);
  const std::string message = error ? error : "";
  sqlite3_free(error);
  sqlite3_close(db);
  if (result != SQLITE_OK)
    throw std::runtime_error(message);
}
void deadline_and_fence() {
  Temp temp;
  Json original;
  const Json data = {{"projectId", "project"}};
  {
    Store store(temp.dir());
    store.save({{"id", "host~old"}, {"state", "closed"}, {"running", false}});
    store.event("host~old", "warning", {{"message", "Agent-only evidence"}});
    original = intent(store, "lost-request");
    const auto started = store.operation_begin(original, "create", data);
    store.operation_finish(started.at("key"), {{"error", {{"code", "RESULT_UNKNOWN"}}}});
    store.history_reserve("host~old", 65536, 16,
                          "operation:" + started.at("key").get<std::string>());
    store.output_append("rpc-output:host~old", {{"notification", "unreceived output"}});
    store.output_publish("rpc-output:host~old", 1);
    const auto before = store.retention_cleanup(now() + 6 * 86400000LL);
    check(before.at("removed") == 0, "Expired before one week");
    const auto cleanup = store.retention_cleanup(now() + 7 * 86400000LL + 1000);
    check(cleanup.at("removed") >= 3, "Week-old work or backlog remained");
    rejects([&] { store.operation_begin(original, "create", data); }, "REQUEST_EXPIRED");
    const auto page = store.history("host~old", 0, -1, 2);
    check(page.at("gap") && page.at("events").empty(), "History loss was not explicit");
    rejects([&] { store.output_page("rpc-output:host~old", 0); }, "CONTENT_EXPIRED");
    check(store.history_budget().at("global").at("bytes") < 10000, "Promise capacity leaked");
    check(store.get("host~old").at("state") == "closed", "Session/configuration was deleted");
  }
  Store reopened(temp.dir());
  rejects([&] { reopened.operation_begin(original, "create", data); }, "REQUEST_EXPIRED");
  const auto fresh = intent(reopened, "fresh-request");
  check(reopened.operation_begin(fresh, "create", data).at("state") == "new", "New work blocked");
}
void client_recovery() {
  Temp temp;
  std::filesystem::create_directories(temp.path);
  const std::string session = "host~recover", owner(64, 'a');
  const Json origin = {{"environment", std::string(64, 'c')},
                       {"projectPath", std::filesystem::canonical(temp.path).u8string()}};
  const Json entry = {{"turnId", "turn"},
                      {"completedAtMs", 1},
                      {"item", {{"id", "item"}, {"type", "agentMessage"}, {"text", "原文🙂"}}}};
  Json reference;
  int64_t seq = 0;
  {
    Store store(temp.dir());
    store.save({{"id", session},
                {"state", "closed"},
                {"external", true},
                {"projectId", "project"},
                {"threadId", "thread"}});
    const auto event = store.external_item(session, "turn", entry.at("item"));
    seq = event.at("seq");
    store.history_source_register(session, seq, origin, entry);
    const auto page = store.history(session, 0, -1, 2, -1, owner);
    reference = page.at("events").at(0).at("contentReference");
    check(reference.contains("recovery"), "Client did not receive recovery credential");
    store.retention_cleanup(now() + 7 * 86400000LL + 1000);
    check(store.history(session, 0, -1, 2).at("events").empty(), "Projection was not deleted");
    check(store.history_recovered_content(session, reference, origin, entry, 0, owner).at("text") ==
              "原文🙂",
          "Client credential cannot replace deleted Agent mapping");
    rejects([&] { store.history_content(session, reference, 0, owner); }, "CONTENT_UNAVAILABLE");
    rejects([&] { store.history_source_plan(session, seq, reference, std::string(64, 'b')); },
            "FORBIDDEN");
    auto changed = reference;
    changed["recovery"]["payload"] =
        reference.at("recovery").at("payload").get<std::string>() + " ";
    rejects([&] { store.history_source_plan(session, seq, changed, owner); }, "FORBIDDEN");
    changed = reference;
    changed["digest"] = changed["contentId"] = std::string(64, 'd');
    rejects([&] { store.history_source_plan(session, seq, changed, owner); }, "FORBIDDEN");
    auto rewritten = entry;
    rewritten["item"]["text"] = "different content";
    rejects(
        [&] { store.history_recovered_content(session, reference, origin, rewritten, 0, owner); },
        "CONTENT_UNAVAILABLE");
  }
  Store reopened(temp.dir());
  check(
      reopened.history_recovered_content(session, reference, origin, entry, 0, owner).at("text") ==
          "原文🙂",
      "Restart invalidated saved client credential");
  auto wrong_origin = origin;
  wrong_origin["environment"] = std::string(64, 'e');
  rejects(
      [&] {
        reopened.history_recovered_content(session, reference, wrong_origin, entry, 0, owner);
      },
      "DELIVERY_STATE_MISMATCH");
}
void pressure_and_active_work() {
  Temp temp;
  Store store(temp.dir(), true, "", {{"maxBytes", 131072}, {"maxSessionBytes", 131072}});
  store.save({{"id", "host~history"}, {"state", "closed"}});
  for (int i = 0; i < 20 && store.history_budget().at("global").at("bytes") < 131072 * 80 / 100;
       ++i)
    store.event("host~history", "warning", {{"message", std::string(2500, 'x')}});
  const auto before = store.history_budget().at("global").at("bytes").get<int64_t>();
  check(before >= 131072 * 80 / 100, "Fixture did not reach threshold");
  const auto cleaned = store.retention_cleanup(now());
  check(cleaned.at("historyPressure"), "Pressure did not trigger");
  check(store.history_budget().at("global").at("bytes") < 131072 * 60 / 100,
        "Pressure did not reclaim to target");
  check(store.history("host~history", 0, -1, 2).at("gap"), "Forced deletion hid the gap");
  store.event("host~history", "warning", {{"message", "new operations remain available"}});
  store.save({{"id", "host~active"}, {"state", "ready"}, {"running", true}});
  store.history_reserve("host~active", 16384, 8, "runtime-terminal");
  store.event("host~active", "warning", {{"message", "live output"}});
  const auto active = store.history("host~active");
  store.retention_cleanup(now() + 8 * 86400000LL);
  check(store.history("host~active") == active, "Cleanup damaged active execution");
}
void transaction_and_flow_fencing() {
  Temp temp;
  Store store(temp.dir());
  store.save({{"id", "host~flow"}, {"state", "closed"}});
  store.event("host~flow", "warning", {{"message", "original"}});
  const auto original = intent(store, "old-operation");
  const auto operation = store.operation_begin(original, "stop", {{"sessionId", "host~flow"}});
  store.operation_finish(operation.at("key"), {{"data", true}});
  const auto instance = store.operation_instance();
  sql(temp, "CREATE TRIGGER fail_cleanup BEFORE DELETE ON history BEGIN "
            "SELECT RAISE(ABORT,'injected cleanup failure'); END");
  rejects([&] { store.retention_cleanup(now() + 8 * 86400000LL); }, "STORAGE_ERROR");
  check(store.operation_instance() == instance && !store.history("host~flow").at("events").empty(),
        "Cleanup failure did not roll back fence and deletions");
  sql(temp, "DROP TRIGGER fail_cleanup");
  store.control_apply("host~flow", 1, "control", "owner");
  store.delivery_open("stream", "host~flow", 1, max_frame);
  store.delivery_bind("stream", 1, "control");
  const auto old_window = store.delivery_window("stream");
  store.retention_cleanup(now() + 8 * 86400000LL);
  store.delivery_open("stream", "host~flow", 1, max_frame);
  store.delivery_bind("stream", 1, "control");
  const auto fresh_window = store.delivery_window("stream");
  check(fresh_window.at("streamSerial") > old_window.at("streamSerial"),
        "Allocation serial reused");
  rejects([&] { store.delivery_verify("stream", old_window); }, "DELIVERY_STATE_MISMATCH");
  check(!store.delivery_start("stream", 1), "Old command restarted after cleanup");
}
void history_scope_reclamation() {
  Temp temp;
  int64_t revision = 0;
  {
    Store store(temp.dir(), true, "", {{"maxSessions", 3}});
    for (int i = 0; i < 3; ++i) {
      const auto session = "host~scope" + std::to_string(i);
      store.save({{"id", session}, {"state", "closed"}});
      revision = store.event(session, "warning", {{"message", "old"}}).at("revision");
    }
    store.retention_cleanup(now() + 8 * 86400000LL);
    check(store.history_budget().at("sessions").empty(), "Empty scopes still pin admission");
    const auto page = store.history("host~scope2", 0, -1, 2);
    check(page.at("snapshotSeq") == revision && page.at("gap"), "Compacted coverage rewound");
    store.save({{"id", "host~scope2"}, {"state", "closed"}});
    check(store.history("host~scope2", 0, -1, 2).at("snapshotSeq") == revision,
          "Runtime save overwrote compacted coverage");
  }
  Store reopened(temp.dir(), true, "", {{"maxSessions", 3}});
  const auto next = reopened.event("host~scope2", "warning", {{"message", "new"}});
  check(next.at("revision") > revision, "Reopened scope reused a revision");
  check(reopened.history("host~scope2", 0, -1, 2).at("gap"), "Reimport erased coverage gap");
  reopened.save({{"id", "host~fresh"}, {"state", "closed"}});
  reopened.event("host~fresh", "warning", {{"message", "admitted"}});
}
void compact_transport_counters() {
  Temp temp;
  Json original;
  {
    Store store(temp.dir());
    store.save({{"id", "host~counters"}, {"state", "closed"}});
    original = store.control_apply("host~counters", 2, "control", "owner");
    store.output_append("rpc-output:host~counters", {{"event", "old"}});
    store.output_publish("rpc-output:host~counters", 1);
    store.output_ack("rpc-output:host~counters", 1);
    store.retention_cleanup(now() + 8 * 86400000LL);
    check(store.control_state("host~counters") == original, "Compaction lost the control fence");
    store.save({{"id", "host~counters"}, {"state", "closed"}});
    check(store.delivery_heads("host~counters").at("rpc") == 1, "Output head rewound after save");
  }
  Store reopened(temp.dir());
  rejects([&] { reopened.control_apply("host~counters", 1, "old", "owner"); }, "STALE_CONTROLLER");
  check(reopened.output_append("rpc-output:host~counters", {{"event", "new"}}).at("seq") == 2,
        "Compacted output counters reused an identity");
}
void total_storage_pressure() {
  Temp temp;
  Store store(temp.dir(), true, "", {{"storageMaxBytes", 2 * 1024 * 1024}});
  store.save({{"id", "host~storage"}, {"state", "closed"}});
  for (int i = 0; i < 20; ++i)
    store.event("host~storage", "warning", {{"message", std::string(65536, 'x')}});
  const auto cleaned = store.retention_cleanup(now());
  check(cleaned.at("storagePressure") && cleaned.at("removed") > 0,
        "SQLite used-page threshold did not reclaim history");
  store.event("host~storage", "warning", {{"message", "new work"}});
}
void client_result_expiration() {
  Temp temp;
  Store client(temp.dir(), false);
  client.local_operation_prepare("completed", "/sessions", Json::object(), "instance");
  const Json result = {{"data", {{"id", "host~result"}}}};
  const Json receipt = {
      {"requestId", "completed"}, {"owner", std::string(64, 'a')}, {"instance", "instance"}};
  client.local_operation_finish("completed", result, receipt);
  client.local_operation_expire("completed");
  check(client.local_operation("completed").at("result") == result,
        "Expiration overwrote a result already held by the client");
  client.local_operation_prepare("missing", "/sessions", Json::object(), "instance");
  client.local_operation_expire("missing");
  check(client.local_operation("missing").at("result").at("error").at("code") == "REQUEST_EXPIRED",
        "Unreceived expired result was invented");
}
void unknown_upload_expiration() {
  Temp temp;
  {
    Store store(temp.dir());
    store.upload_prepare(temp.dir(), "owner", "lost-upload",
                         {{"path", "target"}, {"size", 1024}, {"sha256", std::string(64, 'a')}});
  }
  Store reopened(temp.dir());
  check(reopened.upload_budget().at("active") == 1, "Unknown upload fixture lost its promise");
  reopened.retention_cleanup(now() + 8 * 86400000LL);
  check(reopened.upload_budget().at("records") == 0 && reopened.upload_budget().at("bytes") == 0,
        "Restart-unknown upload retained its accounting past one week");
}
} // namespace
int main() {
  try {
    deadline_and_fence();
    client_recovery();
    pressure_and_active_work();
    transaction_and_flow_fencing();
    history_scope_reclamation();
    compact_transport_counters();
    total_storage_pressure();
    client_result_expiration();
    unknown_upload_expiration();
    std::cout << "Retention, pressure, client credentials and replay fencing passed\n";
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
