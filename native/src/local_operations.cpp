#include "coc/credit.hpp"
#include "coc/delivery.hpp"
#include "coc/store.hpp"
namespace coc {
void Store::local_operation_expire(const std::string &request) {
  auto record = local_operation(request);
  if (record.is_null())
    throw Error("NOT_FOUND", "Unknown local original operation");
  record["state"] = "confirmed";
  record["finished"] = now();
  if (!record.contains("result"))
    record["result"] = {
        {"error",
         {{"code", "REQUEST_EXPIRED"},
          {"message", "Agent no longer retains this request; inspect its side effects"}}}};
  local_operation_save(request, record);
}
namespace {
const std::string allocation_name = "http-operations:v2";
const std::string identity_prefix = "http-operation:";
static_assert(credit::local_operation_pending * 2 * max_frame +
                  credit::operation_records * credit::record_bytes +
                  credit::local_operation_tail_bytes + 65536 <
              credit::local_command_reservation);
} // namespace
Json Store::local_operation(const std::string &request) {
  if (!valid_id(request))
    throw Error("INVALID_REQUEST", "Invalid original local operation identity");
  const auto rows = query("SELECT value FROM transport2_local_operations WHERE key=?",
                          {cache_namespace_ + identity_prefix + request});
  return rows.empty() ? Json() : Json::parse(rows.at(0).at("value").get<std::string>());
}
void Store::local_operation_save(const std::string &request, const Json &record) {
  const auto key = cache_namespace_ + identity_prefix + request;
  const auto allocation = cache_namespace_ + allocation_name;
  const auto body = record.dump();
  const auto used = query("SELECT COALESCE(SUM(length(CAST(value AS BLOB))+?),0) AS bytes "
                          "FROM transport2_local_operations WHERE allocation=? AND key<>?",
                          {credit::record_bytes, allocation, key})
                        .at(0)
                        .at("bytes")
                        .get<int64_t>();
  if (used + int64_t(body.size()) + credit::record_bytes + int64_t(allocation.size() * 6) + 4096 >
      credit::local_command_reservation)
    throw Error("BACKPRESSURE", "Local original operation reservation is full");
  run("INSERT INTO transport2_local_operations VALUES(?,?,?) ON CONFLICT(key) DO UPDATE "
      "SET value=excluded.value",
      {key, allocation, body});
}
Json Store::local_operation_prepare(const std::string &request, const std::string &path,
                                    const Json &body, const std::string &instance) {
  if (!valid_id(request) || !valid_id(instance) || path.empty() || path.front() != '/' ||
      path.size() > 1024 || path.find_first_of("\r\n") != std::string::npos || !body.is_object())
    throw Error("INVALID_REQUEST", "Invalid local original operation scope");
  const auto payload = Json{{"path", path}, {"body", body}}.dump();
  if (payload.size() > max_frame - 8192)
    throw Error("MESSAGE_TOO_LARGE", "Local original operation exceeds its reserved slot");
  const auto digest = delivery_digest(payload);
  local_reserve(allocation_name, "command");
  run("BEGIN IMMEDIATE");
  try {
    auto record = local_operation(request);
    if (!record.is_null()) {
      if (record.at("digest") != digest)
        throw Error("IDEMPOTENCY_CONFLICT", "Original local operation content or scope changed");
      if (record.at("instance") != instance)
        throw Error("DELIVERY_STATE_MISMATCH",
                    "Cannot rebind an original operation to a new store");
    } else {
      const auto usage = query("SELECT COUNT(*) AS records,COALESCE(SUM(CASE WHEN "
                               "json_extract(value,'$.state')<>'confirmed' THEN 1 ELSE 0 END),0) "
                               "AS pending FROM transport2_local_operations WHERE allocation=?",
                               {cache_namespace_ + allocation_name})
                             .at(0);
      if (usage.at("records") >= credit::operation_records ||
          usage.at("pending") >= credit::local_operation_pending)
        throw Error("BACKPRESSURE", "Local operation pending or retired identity budget exhausted");
      record = {{"requestId", request}, {"path", path},     {"body", body},
                {"instance", instance}, {"digest", digest}, {"state", "pending"}};
      local_operation_save(request, record);
    }
    run("COMMIT");
    return record;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::local_operation_finish(const std::string &request, const Json &envelope,
                                   const Json &input_receipt) {
  const auto receipt = operation_intent(input_receipt);
  if (!envelope.is_object() || envelope.contains("data") == envelope.contains("error") ||
      envelope.dump().size() > max_frame - 8192 || receipt.value("ack", false))
    throw Error("INVALID_REQUEST", "Invalid durable original operation result");
  run("BEGIN IMMEDIATE");
  try {
    auto record = local_operation(request);
    if (record.is_null())
      throw Error("NOT_FOUND", "Unknown local original operation");
    if (receipt.at("requestId") != request || receipt.at("instance") != record.at("instance") ||
        (record.contains("receipt") && record.at("receipt").at("owner") != receipt.at("owner")))
      throw Error("DELIVERY_STATE_MISMATCH", "Result does not match the durable original identity");
    if (record.at("state") != "pending") {
      if (!record.contains("result"))
        throw Error("RESULT_UNAVAILABLE", "Local confirmed result body was retired");
      if (record.at("result") != envelope)
        throw Error("IDEMPOTENCY_CONFLICT", "Local original operation already has another result");
    } else {
      record["result"] = envelope;
      record["receipt"] = receipt;
      record["state"] = "completed";
      local_operation_save(request, record);
    }
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::local_operation_confirm(const std::string &request) {
  run("BEGIN IMMEDIATE");
  try {
    auto record = local_operation(request);
    if (record.is_null())
      throw Error("NOT_FOUND", "Unknown local original operation");
    if (record.at("state") == "pending")
      throw Error("RESULT_PENDING", "Local operation result must commit before confirmation");
    if (record.at("state") != "confirmed") {
      record["state"] = "confirmed";
      record["finished"] = now();
      record.erase("body");
      local_operation_save(request, record);
      int64_t count = 0, bytes = 0;
      for (const auto &row : query("SELECT value FROM transport2_local_operations WHERE "
                                   "allocation=? AND json_extract(value,'$.state')='confirmed' "
                                   "ORDER BY json_extract(value,'$.finished') DESC,key DESC",
                                   {cache_namespace_ + allocation_name})) {
        auto previous = Json::parse(row.at("value").get<std::string>());
        if (!previous.contains("result"))
          continue;
        const auto size = int64_t(previous.at("result").dump().size());
        if (count < credit::local_operation_tail &&
            bytes + size <= credit::local_operation_tail_bytes) {
          ++count;
          bytes += size;
        } else {
          previous.erase("result");
          local_operation_save(previous.at("requestId"), previous);
        }
      }
    }
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
} // namespace coc
