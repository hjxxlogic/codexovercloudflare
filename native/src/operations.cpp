#include "coc/credit.hpp"
#include "coc/delivery.hpp"
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
    const Json recovery = {
        {"error",
         {{"code", "RESULT_UNKNOWN"},
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
