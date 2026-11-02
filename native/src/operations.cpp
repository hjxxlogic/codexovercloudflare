#include "coc/credit.hpp"
#include "coc/delivery.hpp"
#include "coc/external.hpp"
#include "coc/store.hpp"
namespace coc {
namespace {
std::string operation_digest(const std::string &action, const Json &data) {
  if (!valid_id(action) || !data.is_object())
    throw Error("INVALID_REQUEST", "Invalid operation scope");
  const auto payload = Json{{"action", action}, {"data", data}}.dump();
  if (payload.size() > max_frame - 8192)
    throw Error("MESSAGE_TOO_LARGE", "Operation exceeds its endpoint budget");
  return delivery_digest(payload);
}
} // namespace
bool operation_write(const std::string &action, const Json &data) {
  const auto operation = data.is_object() ? data.value("operation", "") : "";
  return action == "create" || action == "stop" || action == "queue" || action == "answer" ||
         (action == "projectManage" && operation != "list" && operation != "browse") ||
         (action == "files" && (operation == "begin" || operation == "finish"));
}
Json operation_intent(const Json &intent) {
  if (!intent.is_object())
    throw Error("INVALID_REQUEST", "Missing original operation identity");
  for (const auto &field : {"owner", "requestId", "instance"})
    if (!intent.contains(field) || !intent.at(field).is_string())
      throw Error("INVALID_REQUEST", "Invalid original operation identity");
  const auto owner = intent.at("owner").get<std::string>();
  if (owner.size() != 64 || owner.find_first_not_of("0123456789abcdef") != std::string::npos ||
      !valid_id(intent.at("requestId")) || !valid_id(intent.at("instance")) ||
      (intent.contains("ack") && !intent.at("ack").is_boolean()))
    throw Error("INVALID_REQUEST", "Invalid original operation identity");
  Json result = {
      {"owner", owner}, {"requestId", intent.at("requestId")}, {"instance", intent.at("instance")}};
  if (intent.contains("ack"))
    result["ack"] = intent.at("ack");
  return result;
}
std::string Store::operation_key(const Json &input) {
  const auto intent = operation_intent(input);
  const auto owner = intent.at("owner").get<std::string>();
  if (intent.at("instance") != delivery_instance_)
    throw Error("DELIVERY_STATE_MISMATCH", "Original operation belongs to another Agent store");
  return delivery_digest(Json::array({owner, intent.at("requestId")}).dump());
}
Json Store::operation_begin(const Json &intent, const std::string &action, const Json &data) {
  const auto key = operation_key(intent);
  const auto digest = operation_digest(action, data);
  run("BEGIN IMMEDIATE");
  try {
    const auto existing =
        query("SELECT digest,phase,result FROM transport2_operations WHERE key=?", {key});
    if (!existing.empty()) {
      const auto &record = existing.at(0);
      if (record.at("digest") != digest)
        throw Error("IDEMPOTENCY_CONFLICT", "Original operation content or scope changed");
      if (record.at("phase") == "acked")
        throw Error("RESULT_UNAVAILABLE", "Original operation was confirmed and retired");
      Json result = {{"key", key}, {"state", record.at("phase")}};
      if (record.at("phase") != "started" && !record.at("result").is_null())
        result["result"] = Json::parse(record.at("result").get<std::string>());
      run("COMMIT");
      return result;
    }
    const auto budget = query("SELECT COALESCE(SUM(reserved),0) AS bytes,COUNT(*) AS records,"
                              "COALESCE(SUM(CASE WHEN owner=? THEN reserved ELSE 0 END),0) "
                              "AS owner_bytes FROM transport2_operations",
                              {intent.at("owner")})
                            .at(0);
    if (budget.at("records") >= credit::operation_records ||
        budget.at("bytes").get<int64_t>() + credit::operation_slot > credit::operation_budget ||
        budget.at("owner_bytes").get<int64_t>() + credit::operation_slot > credit::operation_owner)
      throw Error("BACKPRESSURE", "Original operation reservation or retirement budget exhausted");
    // The commit is the at-most-once dispatch boundary. A later process can
    // reconcile this identity, but may never execute it as a new request.
    run("INSERT INTO transport2_operations VALUES(?,?,?,?,'started',NULL,?)",
        {key, intent.at("owner"), intent.at("requestId"), digest, credit::operation_slot});
    run("COMMIT");
    return {{"key", key}, {"state", "new"}};
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::operation_session(const std::string &key, const Json &session) {
  run("BEGIN IMMEDIATE");
  try {
    const auto rows = query("SELECT phase,result FROM transport2_operations WHERE key=?", {key});
    if (rows.empty() || rows.at(0).at("phase") != "started")
      throw Error("RESULT_UNAVAILABLE", "Session creation requires its original started operation");
    if (!rows.at(0).at("result").is_null())
      throw Error("IDEMPOTENCY_CONFLICT", "Original operation already allocated a session");
    const auto id = session.at("id").get<std::string>();
    history_reserve(id, 16 * 1024, 8, "runtime-terminal");
    history_reserve(id, 64 * 1024, 16);
    const Json recovery = {
        {"error",
         {{"code", "RESULT_UNKNOWN"},
          {"sessionId", id},
          {"message", "Session " + id +
                          " was allocated by this request; initialization outcome "
                          "is unknown. Inspect this session before a new intent."}}}};
    // This is recovery evidence, not a terminal result while execution is live.
    // It shares the session commit and the already reserved operation result slot.
    save(session);
    run("UPDATE transport2_operations SET result=? WHERE key=?", {recovery.dump(), key});
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::operation_finish(const std::string &key, Json envelope) {
  if (!envelope.is_object() || envelope.contains("data") == envelope.contains("error"))
    throw Error("INVALID_REQUEST", "Operation result requires one data or error envelope");
  if (envelope.dump().size() > max_frame - 8192)
    envelope = {{"error",
                 {{"code", "RESULT_UNKNOWN"},
                  {"message", "Original operation completed beyond its result budget; "
                              "reconcile its side effects"}}}};
  const auto body = envelope.dump();
  run("BEGIN IMMEDIATE");
  try {
    const auto rows = query("SELECT phase,result FROM transport2_operations WHERE key=?", {key});
    if (rows.empty())
      throw Error("NOT_FOUND", "Unknown original operation");
    if (rows.at(0).at("phase") == "completed") {
      if (rows.at(0).at("result") != body)
        throw Error("IDEMPOTENCY_CONFLICT", "Original operation already has another result");
    } else {
      if (rows.at(0).at("phase") != "started")
        throw Error("RESULT_UNAVAILABLE",
                    "Retired or uncertain operation cannot be completed anew");
      if (!rows.at(0).at("result").is_null() && envelope.contains("data") &&
          envelope.at("data").is_object()) {
        const auto recovery = Json::parse(rows.at(0).at("result").get<std::string>());
        const auto id = recovery.value("error", Json::object()).value("sessionId", "");
        if (!id.empty()) {
          if (envelope.at("data").value("id", "") != id)
            throw Error("IDEMPOTENCY_CONFLICT", "Creation result does not match allocated session");
          // Initialization finished. Only unused initial capacity is released;
          // actual history and the independently reserved result remain durable.
          history_release(id);
        }
      }
      run("UPDATE transport2_operations SET phase='completed',result=? WHERE key=?", {body, key});
    }
    run("COMMIT");
    return envelope;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::operation_ack(const Json &intent, const std::string &action, const Json &data) {
  const auto key = operation_key(intent);
  const auto digest = operation_digest(action, data);
  run("BEGIN IMMEDIATE");
  try {
    const auto rows = query("SELECT phase,digest FROM transport2_operations WHERE key=?", {key});
    if (rows.empty())
      throw Error("NOT_FOUND", "Unknown original operation");
    if (rows.at(0).at("digest") != digest)
      throw Error("IDEMPOTENCY_CONFLICT", "Confirmation does not match the original operation");
    if (rows.at(0).at("phase") == "started")
      throw Error("RESULT_PENDING", "Original operation has no durable terminal result yet");
    run("UPDATE transport2_operations SET phase='acked',result=NULL,reserved=? WHERE key=?",
        {credit::record_bytes, key});
    run("COMMIT");
    return {{"confirmed", true}};
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
namespace {
bool uncertain_operation(const Json &operation) {
  const auto phase = operation.at("phase");
  if (phase == "unknown" || phase == "acked")
    return true;
  if (phase != "completed" || operation.at("result").is_null())
    return false;
  const auto result = Json::parse(operation.at("result").get<std::string>());
  return result.value("error", Json::object()).value("code", "") == "RESULT_UNKNOWN";
}
} // namespace
Json Store::operation_queue_candidate() {
  // The cursor is a bounded scheduling hint, not a new persistent recovery log.
  const auto rows = query("SELECT key,session FROM transport2_history_entries "
                          "WHERE key>? AND key GLOB 'reservation:*' ORDER BY key LIMIT 128",
                          {queue_recovery_key_});
  if (rows.empty()) {
    queue_recovery_key_.clear();
    return nullptr;
  }
  for (const auto &row : rows) {
    queue_recovery_key_ = row.at("key");
    const auto identity = Json::parse(queue_recovery_key_.substr(12), nullptr, false);
    if (!identity.is_array() || identity.size() != 2 || identity.at(0) != row.at("session") ||
        !identity.at(1).is_string())
      continue;
    const auto owner = identity.at(1).get<std::string>();
    if (owner.size() != 74 || owner.rfind("operation:", 0) != 0)
      continue;
    const auto key = owner.substr(10);
    const auto operations =
        query("SELECT phase,result,request_id,digest FROM transport2_operations "
              "WHERE key=?",
              {key});
    if (operations.empty() || !uncertain_operation(operations.at(0)))
      continue;
    const auto sessions = query("SELECT value FROM sessions WHERE id=?", {row.at("session")});
    if (sessions.empty())
      continue;
    const auto state = Json::parse(sessions.at(0).at("value").get<std::string>());
    if (!state.value("external", false) || state.value("running", false) ||
        !state.contains("threadId") || !state.contains("projectId") || !state.contains("mode"))
      continue;
    return {{"session", row.at("session")},
            {"key", key},
            {"owner", owner},
            {"requestId", operations.at(0).at("request_id")},
            {"digest", operations.at(0).at("digest")},
            {"threadId", state.at("threadId")},
            {"projectId", state.at("projectId")},
            {"mode", state.at("mode")}};
  }
  return nullptr;
}
Json Store::operation_queue_reconcile(const Json &candidate, const Json &queued) {
  // Caller supplies a freshly and uniquely found queue entry after source/project
  // validation. Recheck the original durable scope in the same retirement commit.
  run("BEGIN IMMEDIATE");
  try {
    const std::string session = candidate.at("session"), key = candidate.at("key");
    const auto owner = "operation:" + key;
    const auto operations = query("SELECT phase,result,owner,request_id,digest FROM "
                                  "transport2_operations WHERE key=?",
                                  {key});
    if (operations.empty() || !uncertain_operation(operations.at(0)))
      throw Error("RESULT_UNKNOWN", "Original queue operation is not recoverable");
    const auto &operation = operations.at(0);
    const auto state = get(session);
    const Json intent = {{"owner", operation.at("owner")},
                         {"requestId", operation.at("request_id")},
                         {"instance", delivery_instance_}};
    if (operation_key(intent) != key || candidate.at("owner") != owner ||
        candidate.at("requestId") != operation.at("request_id") ||
        candidate.at("digest") != operation.at("digest") || !state.value("external", false) ||
        state.value("running", false) || state.at("threadId") != candidate.at("threadId") ||
        state.at("projectId") != candidate.at("projectId") ||
        state.at("mode") != candidate.at("mode"))
      throw Error("RESULT_UNKNOWN", "Original queue recovery scope changed");
    const auto input = queued.value("input", Json::array());
    if (!queued.contains("id") || !queued.at("id").is_string() ||
        queued.at("id").get_ref<const std::string &>().empty() ||
        queued.at("id").get_ref<const std::string &>().size() > 200 ||
        queued.value("clientUserMessageId", "") !=
            queue_submission_id(delivery_instance_, session, owner) ||
        !input.is_array() || input.size() != 1 || !input.at(0).is_object() ||
        input.at(0).value("type", "") != "text" || !input.at(0).contains("text") ||
        !input.at(0).at("text").is_string() ||
        input.at(0).value("text_elements", Json::array()) != Json::array())
      throw Error("RESULT_UNKNOWN", "Source queue entry does not identify the original input");
    const Json data = {{"sessionId", session},
                       {"mode", state.at("mode")},
                       {"requestId", operation.at("request_id")},
                       {"text", input.at(0).at("text")}};
    if (operation_digest("queue", data) != operation.at("digest"))
      throw Error("RESULT_UNKNOWN", "Source queue input differs from the durable request digest");
    const auto event = history_queue_accept(
        session, owner,
        redact(Json{{"requestId", operation.at("request_id")},
                    {"queueId", queued.at("id")},
                    {"text", data.at("text")},
                    {"message", "Original queued message verified after recovery"}}));
    // Keep every original operation result, including acknowledged unknown results,
    // unchanged. The independently queryable history fact retires only this promise.
    run("COMMIT");
    return event;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::operation_budget() {
  return {{"globalLimit", credit::operation_budget},
          {"ownerLimit", credit::operation_owner},
          {"recordLimit", credit::operation_records},
          {"slot", credit::operation_slot},
          {"global", query("SELECT COALESCE(SUM(reserved),0) AS reserved,COUNT(*) AS records "
                           "FROM transport2_operations")
                         .at(0)},
          {"owners", query("SELECT owner,SUM(reserved) AS reserved,COUNT(*) AS records FROM "
                           "transport2_operations GROUP BY owner ORDER BY owner")}};
}
} // namespace coc
