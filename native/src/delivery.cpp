#include "coc/delivery.hpp"
#include "coc/credit.hpp"
#include <iomanip>
#include <openssl/sha.h>
#include <sstream>
namespace coc {
std::string delivery_request_key(const Json &original) {
  if (original.contains("requestId") && original.at("requestId").is_string())
    return "web:" + original.at("requestId").get<std::string>();
  if (original.contains("id") && !original.at("id").is_null())
    return std::string(original.contains("method") ? "rpc:" : "reply:") + original.at("id").dump() +
           (!original.contains("method") && original.contains("coc") &&
                    original.at("coc").contains("approval")
                ? ":" + original.at("coc").at("approval").at("runtimeId").get<std::string>() + ":" +
                      original.at("coc").at("approval").at("approvalVersion").get<std::string>()
                : "");
  return "";
}
Json delivery_failure(const Json &original, const std::string &code, const std::string &message) {
  Json result = {{"error", {{"code", code}, {"message", message}}}};
  if (original.contains("requestId")) {
    result["type"] = "error";
    result["requestId"] = original.at("requestId");
  } else if (original.contains("id")) {
    result["id"] = original.at("id");
    result["error"]["code"] = -32001;
    result["error"]["data"] = {{"code", code}};
  }
  return result;
}
std::string delivery_digest(const std::string &body) {
  unsigned char bytes[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char *>(body.data()), body.size(), bytes);
  std::ostringstream out;
  for (auto byte : bytes)
    out << std::hex << std::setw(2) << std::setfill('0') << int(byte);
  return out.str();
}
namespace {
constexpr int64_t sequence_max = 9007199254740991LL;
void positive_sequence(int64_t value) {
  if (value <= 0 || value > sequence_max)
    throw Error("INVALID_REQUEST", "Invalid delivery sequence");
}
} // namespace
Json Store::control_state(const std::string &session) {
  const auto rows =
      query("SELECT epoch,control_id,owner FROM transport2_control WHERE session=?", {session});
  if (rows.empty()) {
    const auto compact = query("SELECT json_extract(value,'$.controlCoverage') AS control "
                               "FROM sessions WHERE id=?",
                               {session});
    return compact.empty() || compact.at(0).at("control").is_null()
               ? Json()
               : Json::parse(compact.at(0).at("control").get<std::string>());
  }
  return {{"controlEpoch", rows.at(0).at("epoch")},
          {"controlId", rows.at(0).at("control_id")},
          {"owner", rows.at(0).at("owner")},
          {"instance", delivery_instance_}};
}
Json Store::control_apply(const std::string &session, int64_t epoch, const std::string &control_id,
                          const std::string &owner) {
  retention_cleanup();
  positive_sequence(epoch);
  if (!valid_id(control_id) || !valid_id(owner))
    throw Error("INVALID_REQUEST", "Invalid control proof identity");
  const bool transaction = sqlite3_get_autocommit(db_);
  if (transaction)
    run("BEGIN IMMEDIATE");
  try {
    const auto previous = control_state(session);
    if (!previous.is_null()) {
      if (epoch < previous.at("controlEpoch").get<int64_t>())
        throw Error("STALE_CONTROLLER", "Control epoch has already advanced");
      if (epoch == previous.at("controlEpoch")) {
        if (previous.at("controlId") != control_id || previous.at("owner") != owner)
          throw Error("IDEMPOTENCY_CONFLICT", "Control epoch identity changed");
        if (transaction)
          run("COMMIT");
        return previous;
      }
    }
    if (query("SELECT 1 FROM transport2_control WHERE session=?", {session}).empty() &&
        query("SELECT COUNT(*) AS count FROM transport2_control").at(0).at("count") >=
            credit::flow_limit)
      throw Error("BACKPRESSURE", "Control namespace metadata budget exhausted");
    const auto ready = Json{{"controlEpoch", epoch},
                            {"controlId", control_id},
                            {"owner", owner},
                            {"instance", delivery_instance_}};
    // The proof and all received-but-unstarted terminal records share one commit.
    // Started side effects remain started and keep their original completion identity.
    const auto pending =
        query("SELECT c.stream,c.seq FROM transport2_commands c JOIN "
              "transport2_flow_control f ON f.stream=c.stream WHERE "
              "f.session=? AND f.epoch<? AND c.phase='received' ORDER BY c.stream,c.seq",
              {session, epoch});
    for (const auto &command : pending) {
      const auto record = delivery_record(command.at("stream"), command.at("seq"));
      const auto original = Json::parse(record.at("body").get<std::string>());
      const auto result =
          delivery_failure(original, "STALE_CONTROLLER", "Control changed before execution began");
      delivery_finish(command.at("stream"), command.at("seq"), result);
    }
    run("UPDATE transport2_flow_control SET closed=1 WHERE session=? AND epoch<?",
        {session, epoch});
    for (const auto &flow :
         query("SELECT f.stream FROM transport2_flow_control f JOIN transport2_credit b ON "
               "b.stream=f.stream WHERE f.session=? AND f.closed=1 AND b.closed=0",
               {session}))
      delivery_close(flow.at("stream"));
    run("DELETE FROM transport2_cancel WHERE stream IN (SELECT stream FROM transport2_flow_control "
        "WHERE session=? AND closed=1)",
        {session});
    run("INSERT INTO transport2_control(session,epoch,control_id,owner) VALUES(?,?,?,?) ON "
        "CONFLICT(session) DO UPDATE SET "
        "epoch=excluded.epoch,control_id=excluded.control_id,owner=excluded.owner",
        {session, epoch, control_id, owner});
    if (transaction)
      run("COMMIT");
    return ready;
  } catch (...) {
    if (transaction)
      run("ROLLBACK");
    throw;
  }
}
void Store::delivery_bind(const std::string &stream, int64_t epoch, const std::string &control_id) {
  run("BEGIN IMMEDIATE");
  try {
    const auto rows = query("SELECT session FROM transport2_streams WHERE stream=?", {stream});
    if (rows.empty())
      throw Error("NOT_FOUND", "Unknown control stream");
    const auto session = rows.at(0).at("session").get<std::string>();
    const auto control = control_state(session);
    if (control.is_null() || control.at("controlEpoch") != epoch ||
        control.at("controlId") != control_id)
      throw Error("STALE_CONTROLLER", "Delivery stream requires the active durable control proof");
    const auto previous = query(
        "SELECT epoch,control_id,closed FROM transport2_flow_control WHERE stream=?", {stream});
    if (!previous.empty() &&
        (previous.at(0).at("epoch") != epoch || previous.at(0).at("control_id") != control_id))
      throw Error("STREAM_CLOSED", "A retired control stream cannot inherit new credit");
    run("INSERT OR IGNORE INTO transport2_flow_control(stream,session,epoch,control_id) "
        "VALUES(?,?,?,?)",
        {stream, session, epoch, control_id});
    run("INSERT OR IGNORE INTO transport2_flow_owner VALUES(?,?)", {stream, control.at("owner")});
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::delivery_target(const std::string &stream, int64_t seq) {
  auto rows =
      query("SELECT f.epoch,o.owner,k.request_id FROM transport2_flow_control f "
            "JOIN transport2_flow_owner o ON o.stream=f.stream "
            "JOIN transport2_command_keys k ON k.stream=f.stream WHERE f.stream=? AND k.seq=?",
            {stream, seq});
  if (rows.empty())
    throw Error("TARGET_NOT_FOUND", "The command has no authenticated target identity");
  const auto key = rows.at(0).at("request_id").get<std::string>();
  if (key.empty())
    throw Error("TARGET_NOT_FOUND", "The command has no stable request identity");
  return {{"stream", stream},
          {"instance", delivery_instance_},
          {"owner", rows.at(0).at("owner")},
          {"controlEpoch", rows.at(0).at("epoch")},
          {"requestId", key}};
}
Json Store::delivery_cancel(const std::string &session, const Json &target) {
  const auto stream = target.at("stream").get<std::string>();
  if (target.at("instance") != delivery_instance_)
    throw Error("TARGET_NOT_FOUND", "Cancellation belongs to another storage instance");
  const auto request = target.at("requestId").get<std::string>();
  if (!valid_id(stream) || request.empty() || request.size() > 512)
    throw Error("INVALID_REQUEST", "Invalid cancellation target");
  positive_sequence(target.at("controlEpoch").get<int64_t>());
  run("BEGIN IMMEDIATE");
  try {
    const auto flow =
        query("SELECT f.session,f.epoch,f.closed,o.owner FROM transport2_flow_control f "
              "JOIN transport2_flow_owner o ON o.stream=f.stream WHERE f.stream=?",
              {stream});
    if (flow.empty() || flow.at(0).at("session") != session ||
        flow.at(0).at("owner") != target.at("owner") ||
        flow.at(0).at("epoch") != target.at("controlEpoch"))
      throw Error("TARGET_NOT_FOUND", "Cancellation does not match the original authorized flow");
    auto commands = query("SELECT seq FROM transport2_command_keys WHERE stream=? AND request_id=?",
                          {stream, request});
    if (!commands.empty()) {
      const auto seq = commands.at(0).at("seq").get<int64_t>();
      auto record = delivery_record(stream, seq);
      if (record.at("phase") == "received") {
        if (target.contains("turnId"))
          throw Error("TARGET_NOT_FOUND", "The unstarted request has no turn identity");
        const auto original = Json::parse(record.at("body").get<std::string>());
        delivery_finish(
            stream, seq,
            delivery_failure(original, "CANCELLED_BEFORE_START",
                             "The original request was cancelled before execution began"));
        record = delivery_record(stream, seq);
      }
      run("COMMIT");
      return {{"state", record.at("phase") == "started" ? "started" : "finished"},
              {"seq", seq},
              {"record", record}};
    }
    if (flow.at(0).at("closed") != 0)
      throw Error("STREAM_CLOSED", "The target flow no longer admits the original request");
    if (target.contains("turnId"))
      throw Error("TARGET_NOT_FOUND", "An unknown command cannot identify an existing turn");
    const auto existing =
        query("SELECT 1 AS present FROM transport2_cancel WHERE stream=? AND request_id=?",
              {stream, request});
    if (existing.empty()) {
      const auto budget = query("SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(request_id AS "
                                "BLOB))+512),0) AS bytes,"
                                "COALESCE(SUM(CASE WHEN stream=? THEN 1 ELSE 0 END),0) AS flow "
                                "FROM transport2_cancel",
                                {stream})
                              .at(0);
      if (budget.at("count").get<int64_t>() >= 128 || budget.at("flow").get<int64_t>() >= 4 ||
          budget.at("bytes").get<int64_t>() + int64_t(request.size()) + 512 > 65536)
        throw Error("BACKPRESSURE", "Durable cancellation marker budget exhausted");
      run("INSERT INTO transport2_cancel VALUES(?,?)", {stream, request});
    }
    run("COMMIT");
    return {{"state", "pending-target"}};
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::delivery_check_control(const std::string &stream) {
  const auto rows = query(
      "SELECT "
      "f.closed,f.epoch,COALESCE(c.epoch,json_extract(s.value,'$.controlCoverage.controlEpoch')) "
      "AS active_epoch FROM transport2_flow_control f "
      "LEFT JOIN transport2_control c ON c.session=f.session "
      "LEFT JOIN sessions s ON s.id=f.session WHERE f.stream=?",
      {stream});
  if (!rows.empty() &&
      (rows.at(0).at("closed") != 0 || rows.at(0).at("epoch") != rows.at(0).at("active_epoch")))
    throw Error("STALE_CONTROLLER", "The delivery stream control epoch is retired");
  if (!query("SELECT 1 FROM transport2_credit WHERE stream=? AND closed=1", {stream}).empty())
    throw Error("STREAM_CLOSED", "The receiver retired this credit generation");
}
Json Store::delivery_open(const std::string &stream, const std::string &session, int64_t slots,
                          int64_t bytes, const std::string &lane) {
  if (!valid_id(stream) || session.empty() || session.size() > 201 || slots < 1 || slots > 100 ||
      bytes < int64_t(max_frame) || bytes > int64_t(max_queue))
    throw Error("INVALID_REQUEST", "Invalid delivery window");
  retention_cleanup();
  run("BEGIN IMMEDIATE");
  try {
    const auto existing =
        query("SELECT session,slots,bytes FROM transport2_streams WHERE stream=?", {stream});
    if (!existing.empty() &&
        (existing.at(0).at("session") != session || existing.at(0).at("slots") != slots ||
         existing.at(0).at("bytes") != bytes))
      throw Error("IDEMPOTENCY_CONFLICT", "Delivery stream identity changed");
    delivery_reserve(stream, session, lane, slots, bytes);
    run("INSERT OR IGNORE INTO transport2_streams(stream,session,slots,bytes) VALUES(?,?,?,?)",
        {stream, session, slots, bytes});
    const auto window = delivery_window(stream);
    run("COMMIT");
    return window;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::delivery_scope(const std::string &stream, const std::string &session) {
  auto rows = query("SELECT session FROM transport2_streams WHERE stream=?", {stream});
  if (rows.empty() || rows.at(0).at("session") != session)
    throw Error("FORBIDDEN", "Wrong delivery stream scope");
}
void Store::delivery_verify(const std::string &stream, const Json &allocation) {
  const auto proof = delivery_allocation(allocation);
  const auto rows =
      query("SELECT serial,generation FROM transport2_credit WHERE stream=?", {stream});
  if (proof.at("instance") != delivery_instance_ || rows.empty() ||
      rows.at(0).at("serial") != proof.at("streamSerial") ||
      rows.at(0).at("generation") != proof.at("creditGeneration"))
    throw Error("DELIVERY_STATE_MISMATCH", "Receiver credit allocation changed");
}
Json Store::delivery_window(const std::string &stream) {
  const bool transaction = sqlite3_get_autocommit(db_) != 0;
  if (transaction)
    run("BEGIN IMMEDIATE");
  try {
    const auto rows = query(
        "SELECT "
        "s.received,s.received_bytes,s.slots,s.bytes,b.credit,b.byte_credit,b.serial,b.generation,"
        "b.closed "
        "FROM transport2_streams s JOIN transport2_credit b ON b.stream=s.stream WHERE s.stream=?",
        {stream});
    if (rows.empty())
      throw Error("NOT_FOUND", "Unknown delivery stream allocation");
    const auto &state = rows.at(0);
    const auto result = delivery_result_state(stream);
    const auto used = query("SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(c.body AS "
                            "BLOB))),0) AS bytes FROM transport2_commands c "
                            "LEFT JOIN transport2_results r ON r.stream=c.stream AND "
                            "r.command_seq=c.seq WHERE c.stream=? AND "
                            "(c.phase!='finished' OR r.seq IS NULL OR r.seq>?)",
                            {stream, result.at("acked")})
                          .at(0);
    const int64_t received = state.at("received"), received_bytes = state.at("received_bytes");
    int64_t right = state.at("credit"), byte_right = state.at("byte_credit");
    const bool closed = state.at("closed") != 0;
    if (!closed) {
      right = std::max(right,
                       std::min(credit::record_limit, received + state.at("slots").get<int64_t>() -
                                                          used.at("count").get<int64_t>()));
      byte_right = std::max(
          byte_right, std::min(sequence_max, received_bytes + state.at("bytes").get<int64_t>() -
                                                 used.at("bytes").get<int64_t>()));
      run("UPDATE transport2_credit SET credit=?,byte_credit=? WHERE stream=?",
          {right, byte_right, stream});
    }
    const Json window = {{"stream", stream},
                         {"instance", delivery_instance_},
                         {"streamSerial", state.at("serial")},
                         {"creditGeneration", state.at("generation")},
                         {"closed", closed},
                         {"exhausted", received >= credit::record_limit},
                         {"sent", result.at("sent")},
                         {"resultBytes", result.at("sent_bytes")},
                         {"received", received},
                         {"receivedBytes", received_bytes},
                         {"credit", closed ? received : right},
                         {"byteCredit", closed ? received_bytes : byte_right}};
    if (transaction)
      run("COMMIT");
    return window;
  } catch (...) {
    if (transaction)
      run("ROLLBACK");
    throw;
  }
}
Json Store::delivery_record(const std::string &stream, int64_t seq) {
  auto rows = query(
      "SELECT c.end_bytes,c.body,c.phase,c.result,d.digest AS commandDigest,r.seq AS resultSeq,"
      "r.end_bytes AS resultEnd,r.body AS resultBody,r.digest AS resultDigest "
      "FROM transport2_commands c LEFT JOIN transport2_command_digests d ON d.stream=c.stream AND "
      "d.seq=c.seq LEFT JOIN transport2_results r ON c.stream=r.stream "
      "AND c.seq=r.command_seq WHERE c.stream=? AND c.seq=?",
      {stream, seq});
  if (rows.empty())
    return nullptr;
  auto record = rows[0];
  if (!record["result"].is_null())
    record["result"] = Json::parse(record["result"].get<std::string>());
  if (!record.at("resultSeq").is_null())
    record["resultStream"] = stream + "_r";
  return record;
}
Json Store::delivery_receive(const std::string &stream, int64_t seq, int64_t end,
                             const std::string &body) {
  positive_sequence(seq);
  positive_sequence(end);
  if (body.empty() || Json(body).dump().size() > max_frame - 4096)
    throw Error("MESSAGE_TOO_LARGE", "Delivery command exceeds frame budget");
  run("BEGIN IMMEDIATE");
  try {
    delivery_check_control(stream);
    auto previous = delivery_record(stream, seq);
    if (!previous.is_null()) {
      if (previous["commandDigest"] != delivery_digest(body) || previous["end_bytes"] != end)
        throw Error("IDEMPOTENCY_CONFLICT", "Delivery sequence reused with different content");
      auto window = delivery_window(stream);
      run("COMMIT");
      return {{"accepted", false}, {"record", previous}, {"window", window}};
    }
    auto window = delivery_window(stream);
    if (seq != window["received"].get<int64_t>() + 1 ||
        end != window["receivedBytes"].get<int64_t>() + int64_t(body.size()))
      throw Error("DELIVERY_GAP", "Replay from the continuous receive position");
    if (seq > window["credit"].get<int64_t>() || end > window["byteCredit"].get<int64_t>())
      throw Error("BACKPRESSURE", "Delivery credit exhausted");
    const auto original = Json::parse(body);
    const auto request = delivery_request_key(original);
    if (request.size() > 512)
      throw Error("INVALID_REQUEST", "Original request identity exceeds the target budget");
    if (!request.empty()) {
      const auto known =
          query("SELECT seq FROM transport2_command_keys WHERE stream=? AND request_id=?",
                {stream, request});
      if (!known.empty())
        throw Error("IDEMPOTENCY_CONFLICT",
                    "Original request reused at another transport sequence");
    }
    run("INSERT INTO transport2_commands(stream,seq,end_bytes,body,phase) "
        "VALUES(?,?,?,?,'received')",
        {stream, seq, end, body});
    run("INSERT INTO transport2_command_digests VALUES(?,?,?)",
        {stream, seq, delivery_digest(body)});
    run("UPDATE transport2_streams SET received=?,received_bytes=? WHERE stream=?",
        {seq, end, stream});
    if (!request.empty()) {
      run("INSERT INTO transport2_command_keys VALUES(?,?,?)", {stream, request, seq});
      if (!query("SELECT 1 AS present FROM transport2_cancel WHERE stream=? AND request_id=?",
                 {stream, request})
               .empty()) {
        delivery_finish(stream, seq,
                        delivery_failure(original, "CANCELLED_BEFORE_START",
                                         "Cancellation arrived before the original command"));
        run("DELETE FROM transport2_cancel WHERE stream=? AND request_id=?", {stream, request});
      }
    }
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
  return {{"accepted", true},
          {"record", delivery_record(stream, seq)},
          {"window", delivery_window(stream)}};
}
bool Store::delivery_start(const std::string &stream, int64_t seq) {
  run("UPDATE transport2_commands SET phase='started' WHERE stream=? AND seq=? AND "
      "phase='received' AND NOT EXISTS (SELECT 1 FROM transport2_credit WHERE stream=? AND "
      "closed=1) AND NOT EXISTS (SELECT 1 FROM transport2_flow_control f LEFT JOIN "
      "transport2_control c ON c.session=f.session LEFT JOIN sessions s ON s.id=f.session "
      "WHERE f.stream=? AND (f.closed!=0 OR "
      "COALESCE(c.epoch,json_extract(s.value,'$.controlCoverage.controlEpoch')) IS NULL OR "
      "f.epoch!=COALESCE(c.epoch,json_extract(s.value,'$.controlCoverage.controlEpoch'))))",
      {stream, seq, stream, stream});
  return sqlite3_changes(db_) == 1;
}
Json Store::delivery_result_state(const std::string &stream) {
  run("INSERT OR IGNORE INTO transport2_result_heads(stream) VALUES(?)", {stream});
  return query(
             "SELECT sent,sent_bytes,acked,acked_bytes FROM transport2_result_heads WHERE stream=?",
             {stream})
      .at(0);
}
bool Store::delivery_result_pending(const std::string &stream) {
  // A retired cache route must not recreate deleted result-head metadata.
  const auto rows =
      query("SELECT sent,acked FROM transport2_result_heads WHERE stream=?", {stream});
  return !rows.empty() && rows.at(0).at("sent") > rows.at(0).at("acked");
}
void Store::delivery_finish(const std::string &stream, int64_t seq, const Json &result) {
  const bool transaction = sqlite3_get_autocommit(db_) != 0;
  if (transaction)
    run("BEGIN IMMEDIATE");
  try {
    const auto record = delivery_record(stream, seq);
    if (record.is_null())
      throw Error("NOT_FOUND", "Unknown command completion");
    if (!record.at("resultSeq").is_null()) {
      if (transaction)
        run("COMMIT");
      return;
    }
    const auto full_body = (record.at("phase") == "finished" ? record.at("result") : result).dump();
    if (full_body.size() > 2 * 1024 * 1024)
      throw Error("BACKPRESSURE", "Result exceeds durable content budget");
    std::string body = full_body;
    const bool transfer = Json(body).dump().size() > max_frame - 8192;
    if (transfer) {
      const auto digest = delivery_digest(full_body);
      body = Json{{"type", "delivery-content"}, {"retention", "transfer"}, {"revision", 1},
                  {"length", full_body.size()}, {"contentId", digest},     {"digest", digest}}
                 .dump();
    }
    const auto state = delivery_result_state(stream);
    const auto result_seq = state.at("sent").get<int64_t>() + 1;
    const auto end = state.at("sent_bytes").get<int64_t>() + int64_t(body.size());
    positive_sequence(result_seq);
    positive_sequence(end);
    run("INSERT INTO transport2_results VALUES(?,?,?,?,?,?)",
        {stream, result_seq, seq, end, body, delivery_digest(body)});
    if (transfer)
      run("INSERT INTO transport2_result_content VALUES(?,?,?)", {stream, result_seq, full_body});
    run("UPDATE transport2_result_heads SET sent=?,sent_bytes=? WHERE stream=?",
        {result_seq, end, stream});
    run("UPDATE transport2_commands SET phase='finished',result=? WHERE stream=? AND seq=?",
        {body, stream, seq});
    if (transaction)
      run("COMMIT");
  } catch (...) {
    if (transaction)
      run("ROLLBACK");
    throw;
  }
}
void Store::delivery_result_ack(const std::string &stream, int64_t received, int64_t bytes) {
  if (received < 0 || received > sequence_max || bytes < 0 || bytes > sequence_max)
    throw Error("INVALID_REQUEST", "Invalid result receipt");
  run("BEGIN IMMEDIATE");
  try {
    const auto state = delivery_result_state(stream);
    if (received > state.at("sent").get<int64_t>())
      throw Error("INVALID_REQUEST", "Result receipt exceeds published completion log");
    if (received == state.at("acked").get<int64_t>() && bytes != state.at("acked_bytes"))
      throw Error("INVALID_REQUEST", "Result receipt changed byte position");
    if (received > state.at("acked").get<int64_t>()) {
      const auto rows = query("SELECT end_bytes FROM transport2_results WHERE stream=? AND seq=?",
                              {stream, received});
      if (rows.empty() || rows.at(0).at("end_bytes") != bytes)
        throw Error("INVALID_REQUEST", "Result receipt is not a published byte boundary");
      run("UPDATE transport2_result_heads SET acked=?,acked_bytes=? WHERE stream=?",
          {received, bytes, stream});
      // Retain compact identity/digest records; only the acknowledged continuous prefix loses its
      // body.
      const auto completed =
          query("SELECT c.seq,s.session,length(CAST(c.body AS BLOB)) AS body_bytes "
                "FROM transport2_commands c JOIN transport2_streams s ON s.stream=c.stream "
                "JOIN transport2_results r ON r.stream=c.stream AND r.command_seq=c.seq "
                "WHERE c.stream=? AND r.seq>? AND r.seq<=?",
                {stream, state.at("acked"), received});
      for (const auto &command : completed) {
        const auto owner =
            "command:" + delivery_digest(Json::array({stream, command.at("seq")}).dump());
        const auto key = "reservation:" + Json::array({command.at("session"), owner}).dump();
        const bool unresolved =
            !query("SELECT 1 FROM transport2_history_entries WHERE key=?", {key}).empty();
        if (unresolved)
          // The pending history promise takes over retention of the existing body
          // before delivery credit is returned; reserve its retained body and metadata.
          history_reserve(command.at("session"), command.at("body_bytes").get<int64_t>() + 65536,
                          16, owner);
        run("UPDATE transport2_commands SET body=CASE WHEN ? THEN body ELSE '' END,result=NULL "
            "WHERE stream=? AND seq=?",
            {unresolved ? 1 : 0, stream, command.at("seq")});
      }
      run("UPDATE transport2_results SET body=NULL WHERE stream=? AND seq<=?", {stream, received});
      run("DELETE FROM transport2_result_content WHERE stream=? AND seq<=?", {stream, received});
      const auto allocation =
          query("SELECT received FROM transport2_streams WHERE stream=?", {stream}).at(0);
      if (allocation.at("received").get<int64_t>() >= credit::record_limit &&
          received == state.at("sent") &&
          query("SELECT 1 FROM transport2_commands WHERE stream=? AND phase!='finished' LIMIT 1",
                {stream})
              .empty())
        delivery_close(stream);
      delivery_release(stream);
    }
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::delivery_content(const std::string &stream, int64_t result_seq, int64_t offset) {
  positive_sequence(result_seq);
  if (offset < 0 || offset > 2 * 1024 * 1024)
    throw Error("INVALID_REQUEST", "Invalid result content offset");
  auto rows = query("SELECT body FROM transport2_result_content WHERE stream=? AND seq=?",
                    {stream, result_seq});
  if (rows.empty())
    throw Error("CONTENT_UNAVAILABLE", "Transfer content is no longer available");
  const auto body = rows.at(0).at("body").get<std::string>();
  if (offset >= int64_t(body.size()) ||
      (static_cast<unsigned char>(body.at(offset)) & 0xc0) == 0x80)
    throw Error("INVALID_REQUEST", "Content offset is not a UTF-8 byte boundary");
  auto end = std::min(body.size(), size_t(offset) + 16384);
  while (end < body.size() && (static_cast<unsigned char>(body.at(end)) & 0xc0) == 0x80)
    --end;
  return {{"resultSeq", result_seq},
          {"offset", offset},
          {"next", end},
          {"length", body.size()},
          {"body", body.substr(offset, end - offset)}};
}
Json Store::delivery_results(const std::string &stream, int64_t after) {
  const auto state = delivery_result_state(stream);
  if (after < state.at("acked").get<int64_t>())
    throw Error("DELIVERY_STATE_MISMATCH", "Receiver lost acknowledged results");
  auto records = query("SELECT seq AS resultSeq,command_seq AS seq,end_bytes AS resultEnd,"
                       "body AS resultBody,digest AS resultDigest FROM transport2_results "
                       "WHERE stream=? AND seq>? ORDER BY seq LIMIT 1",
                       {stream, after});
  for (auto &record : records)
    record["resultStream"] = stream + "_r";
  return records;
}
Json Store::delivery_heads(const std::string &session) {
  const auto output = query("SELECT published FROM transport2_output_heads WHERE stream=?",
                            {"rpc-output:" + session});
  const auto compact = query("SELECT COALESCE(json_extract(value,'$.outputCoverage.published'),0) "
                             "AS published FROM sessions WHERE id=?",
                             {session});
  return {{"agent", history_head(session)},
          {"rpc", output.empty() ? (compact.empty() ? Json(0) : compact.at(0).at("published"))
                                 : output[0]["published"]}};
}
Json Store::output_state(const std::string &stream) {
  if (stream.empty() || stream.size() > 256)
    throw Error("INVALID_REQUEST", "Invalid output stream");
  if (query("SELECT 1 FROM transport2_output_heads WHERE stream=?", {stream}).empty() &&
      query("SELECT COUNT(*) AS count FROM transport2_output_heads").at(0).at("count") >=
          credit::flow_limit)
    throw Error("BACKPRESSURE", "Output stream metadata budget exhausted");
  if (stream.rfind("rpc-output:", 0) == 0)
    run("INSERT OR IGNORE INTO "
        "transport2_output_heads(stream,sent,sent_bytes,published,acked,acked_bytes,retired) "
        "SELECT ?,COALESCE(json_extract(value,'$.outputCoverage.sent'),0),"
        "COALESCE(json_extract(value,'$.outputCoverage.sent_bytes'),0),"
        "COALESCE(json_extract(value,'$.outputCoverage.published'),0),"
        "COALESCE(json_extract(value,'$.outputCoverage.acked'),0),"
        "COALESCE(json_extract(value,'$.outputCoverage.acked_bytes'),0),"
        "COALESCE(json_extract(value,'$.outputCoverage.retired'),0) FROM sessions WHERE id=?",
        {stream, stream.substr(11)});
  run("INSERT OR IGNORE INTO transport2_output_heads(stream) VALUES(?)", {stream});
  run("INSERT OR IGNORE INTO transport2_output_budget VALUES(?,0,0)", {stream});
  return query("SELECT sent,sent_bytes,published,acked,acked_bytes,retired FROM "
               "transport2_output_heads "
               "WHERE stream=?",
               {stream})
      .at(0);
}
Json Store::output_append(const std::string &stream, const Json &payload) {
  const auto body = payload.dump();
  if (Json(body).dump().size() > max_frame - 4096)
    throw Error("MESSAGE_TOO_LARGE", "Reliable output exceeds frame budget");
  retention_cleanup();
  run("BEGIN IMMEDIATE");
  try {
    auto head = output_state(stream);
    const auto usage =
        query("SELECT COALESCE(SUM(records),0) AS count,COALESCE(SUM(bytes),0) AS bytes,"
              "COALESCE(SUM(CASE WHEN stream=? THEN records ELSE 0 END),0) AS scope_count,"
              "COALESCE(SUM(CASE WHEN stream=? THEN bytes ELSE 0 END),0) "
              "AS scope_bytes FROM transport2_output_budget",
              {stream, stream})
            .at(0);
    const auto cost = int64_t(body.size()) + 512;
    if (usage.at("bytes").get<int64_t>() + cost > credit::output_budget ||
        usage.at("scope_bytes").get<int64_t>() + cost > credit::output_session ||
        usage.at("count").get<int64_t>() >= credit::output_records ||
        usage.at("scope_count").get<int64_t>() >= credit::output_session_records)
      throw Error("BACKPRESSURE", "Durable output budget exhausted; executor must stop");
    const auto seq = head.at("sent").get<int64_t>() + 1;
    const auto end = head.at("sent_bytes").get<int64_t>() + int64_t(body.size());
    positive_sequence(seq);
    positive_sequence(end);
    run("INSERT INTO transport2_outputs VALUES(?,?,?,?)", {stream, seq, end, body});
    run("UPDATE transport2_output_budget SET bytes=bytes+?,records=records+1 WHERE stream=?",
        {cost, stream});
    run("UPDATE transport2_output_heads SET sent=?,sent_bytes=? WHERE stream=?",
        {seq, end, stream});
    run("COMMIT");
    return {{"seq", seq}, {"end", end}, {"body", body}};
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::output_ack(const std::string &stream, int64_t received, int64_t byte_credit) {
  if (received < 0 || received > sequence_max)
    throw Error("INVALID_REQUEST", "Invalid output receipt");
  run("BEGIN IMMEDIATE");
  try {
    auto head = output_state(stream);
    if (received > head.at("published").get<int64_t>())
      throw Error("INVALID_REQUEST", "Output receipt exceeds published data");
    if (received == head.at("acked").get<int64_t>() && byte_credit != -1) {
      const auto bytes = head.at("acked_bytes").get<int64_t>();
      if (byte_credit < bytes || byte_credit - bytes > int64_t(max_queue) ||
          byte_credit > sequence_max)
        throw Error("INVALID_REQUEST", "Invalid output byte credit");
    }
    if (received > head.at("acked").get<int64_t>()) {
      auto rows = query("SELECT end_bytes FROM transport2_outputs WHERE stream=? AND seq=?",
                        {stream, received});
      if (rows.empty())
        if (received <= head.at("retired").get<int64_t>())
          throw Error("CONTENT_EXPIRED", "Output confirmation refers to expired content");
      if (rows.empty())
        throw Error("STORAGE_ERROR", "Output receipt range is missing");
      const auto bytes = rows[0]["end_bytes"].get<int64_t>();
      if (byte_credit != -1 && (byte_credit < bytes || byte_credit - bytes > int64_t(max_queue) ||
                                byte_credit > sequence_max))
        throw Error("INVALID_REQUEST", "Invalid output byte credit");
      run("UPDATE transport2_output_heads SET acked=?,acked_bytes=? WHERE stream=?",
          {received, rows[0]["end_bytes"], stream});
      const auto removed = query("SELECT COUNT(*) AS records,"
                                 "COALESCE(SUM(length(CAST(body AS BLOB))+512),0) AS bytes "
                                 "FROM transport2_outputs WHERE stream=? AND seq<=?",
                                 {stream, received})
                               .at(0);
      run("UPDATE transport2_output_budget SET bytes=bytes-?,records=records-? WHERE stream=?",
          {removed.at("bytes"), removed.at("records"), stream});
      run("DELETE FROM transport2_outputs WHERE stream=? AND seq<=?", {stream, received});
    }
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::output_receive(const std::string &key, int64_t seq, int64_t end,
                           const std::string &body, const std::string &instance) {
  positive_sequence(seq);
  positive_sequence(end);
  if (!valid_id(instance) || body.empty() || Json(body).dump().size() > max_frame - 4096)
    throw Error("INVALID_REQUEST", "Invalid output identity or body");
  if (!Json::accept(body))
    throw Error("INVALID_REQUEST", "Invalid output JSON");
  local_reserve(key, "output");
  run("BEGIN IMMEDIATE");
  try {
    auto state = cache_get(key);
    if (state.is_null())
      state = {{"received", 0}, {"bytes", 0}, {"instance", instance}, {"cache", Json::array()}};
    if (state.at("instance") != instance)
      throw Error("DELIVERY_STATE_MISMATCH", "Output receiver instance changed");
    if (!state.contains("cache"))
      state["cache"] = Json::array();
    if (seq <= state.at("received").get<int64_t>()) {
      for (const auto &record : state["cache"])
        if (record.at("seq") == seq && (record.at("body") != body || record.at("end") != end))
          throw Error("IDEMPOTENCY_CONFLICT", "Output identity changed");
      run("COMMIT");
      return {{"accepted", false}, {"state", state}};
    }
    if (seq != state.at("received").get<int64_t>() + 1 ||
        end != state.at("bytes").get<int64_t>() + int64_t(body.size()))
      throw Error("DELIVERY_GAP", "Output is not a continuous byte boundary");
    if (seq > state.value("consumed", int64_t(0)) + 32 ||
        end > state.value("consumedBytes", int64_t(0)) + 2 * 1024 * 1024)
      throw Error("BACKPRESSURE", "Output exceeds the durable unconsumed window");
    size_t bytes = body.size();
    for (const auto &record : state["cache"])
      bytes += record.at("body").get<std::string>().size();
    // Consumed diagnostic tails may yield to new data; unconsumed bodies may not.
    while (!state["cache"].empty() && state["cache"].front().value("consumed", false) &&
           (state["cache"].size() >= 100 || bytes > 2 * 1024 * 1024)) {
      bytes -= state["cache"].front().at("body").get<std::string>().size();
      state["cache"].erase(state["cache"].begin());
    }
    // Undelivered records cannot be evicted to make room for acknowledged data.
    if (state["cache"].size() >= 100 || bytes > 2 * 1024 * 1024)
      throw Error("BACKPRESSURE", "Durable output receive buffer is full");
    state["cache"].push_back({{"seq", seq}, {"end", end}, {"body", body}, {"consumed", false}});
    state["received"] = seq;
    state["bytes"] = end;
    cache_put(key, state);
    run("COMMIT");
    return {{"accepted", true}, {"state", state}};
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::output_consumed(const std::string &key, int64_t seq) {
  run("BEGIN IMMEDIATE");
  try {
    auto state = cache_get(key);
    if (state.is_null())
      throw Error("STORAGE_ERROR", "Missing durable output");
    auto &cache = state.at("cache");
    for (auto &record : cache)
      if (record.at("seq") == seq)
        record["consumed"] = true;
    for (const auto &record : cache) {
      const auto consumed = state.value("consumed", int64_t(0));
      if (record.at("seq").get<int64_t>() == consumed + 1 && record.value("consumed", false)) {
        state["consumed"] = record.at("seq");
        state["consumedBytes"] = record.at("end");
      }
    }
    // Keep a small replay/diagnostic tail, preserving every unconsumed body.
    while (cache.size() > 32 && cache.front().value("consumed", false))
      cache.erase(cache.begin());
    cache_put(key, state);
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::output_publish(const std::string &stream, int64_t sent) {
  auto state = output_state(stream);
  if (sent > state.at("sent").get<int64_t>() || sent < 0)
    throw Error("INVALID_REQUEST", "Cannot publish an absent output frame");
  run("UPDATE transport2_output_heads SET published=MAX(published,?) WHERE stream=?",
      {sent, stream});
}
Json Store::output_page(const std::string &stream, int64_t after) {
  auto state = output_state(stream);
  if (!query("SELECT 1 FROM transport2_output_heads h LEFT JOIN sessions s ON "
             "s.id=substr(h.stream,12) "
             "WHERE h.stream=? AND h.retained_at<=? AND "
             "COALESCE(json_extract(s.value,'$.running'),0)=0 AND EXISTS "
             "(SELECT 1 FROM transport2_outputs o WHERE o.stream=h.stream AND o.seq>?)",
             {stream, now() - history_policy_.at("retentionSeconds").get<int64_t>() * 1000, after})
           .empty())
    throw Error("CONTENT_EXPIRED", "Reliable output exceeded its retention window");
  if (after < state.at("retired").get<int64_t>())
    throw Error("CONTENT_EXPIRED", "Reliable output exceeded its retention window");
  if (after < state.at("acked").get<int64_t>())
    throw Error("DELIVERY_STATE_MISMATCH", "Local receiver lost acknowledged output state");
  return query(
      "SELECT seq,end_bytes AS 'end',body FROM transport2_outputs WHERE stream=? AND seq>? "
      "ORDER BY seq LIMIT 32",
      {stream, after});
}
} // namespace coc

namespace coc {
Json Store::endpoint_claim(const std::string &id, const std::string &owner,
                           const std::string &claim, bool takeover, const Json &resume) {
  if (!valid_id(owner) || !valid_id(claim))
    throw Error("INVALID_REQUEST", "Invalid control claim");
  run("BEGIN IMMEDIATE");
  try {
    auto session = get(id);
    auto lease = session.value("endpointLease", Json());
    const auto current = control_state(id);
    const auto renew = [&] {
      if (lease.value("ticketUsed", false) || lease.value("reservedUntil", int64_t(0)) <= now()) {
        lease["ticket"] = uuid();
        lease["ticketUsed"] = false;
        lease["reservedUntil"] = now() + 15000;
        session["endpointLease"] = lease;
        save(session);
      }
    };
    if (!lease.is_null() && !current.is_null() &&
        lease.at("controlId") == current.at("controlId")) {
      if (lease.at("owner") == owner && lease.at("claimId") == claim) {
        renew();
        run("COMMIT");
        return lease;
      }
      if (!resume.is_null() && lease.at("owner") == owner &&
          resume.value("controller", "") == lease.value("controller", "") &&
          resume.value("stream", "") == lease.value("stream", "") &&
          !lease.value("stream", "").empty()) {
        renew();
        run("COMMIT");
        return lease;
      }
      if (!takeover && (lease.value("connectionGeneration", int64_t(0)) > 0 ||
                        lease.value("reservedUntil", int64_t(0)) > now()))
        throw Error("SESSION_BUSY", "Session requires explicit takeover");
    }
    const auto generation =
        lease.is_null() ? int64_t(0) : lease.value("connectionGeneration", int64_t(0));
    const auto epoch = current.is_null() ? 1 : current.at("controlEpoch").get<int64_t>() + 1;
    const auto proof = control_apply(id, epoch, uuid(), owner);
    lease = {{"controlEpoch", epoch},
             {"controlId", proof.at("controlId")},
             {"owner", owner},
             {"ticket", uuid()},
             {"ticketUsed", false},
             {"claimId", claim},
             {"controller", uuid()},
             {"connectionGeneration", generation},
             {"reservedUntil", now() + 15000},
             {"stream", ""}};
    session["endpointLease"] = lease;
    save(session);
    run("COMMIT");
    return lease;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::endpoint_attach(const std::string &id, const std::string &owner,
                            const std::string &ticket) {
  run("BEGIN IMMEDIATE");
  try {
    auto session = get(id);
    auto lease = session.value("endpointLease", Json());
    const auto current = control_state(id);
    if (lease.is_null() || current.is_null() || lease.at("owner") != owner ||
        lease.at("ticket") != ticket || lease.value("ticketUsed", false) ||
        current.at("controlId") != lease.at("controlId"))
      throw Error("STALE_CONTROLLER", "Control ticket is stale or belongs to another identity");
    if (lease.value("reservedUntil", int64_t(0)) <= now())
      throw Error("ATTACH_EXPIRED", "Attach ticket expired");
    lease["ticketUsed"] = true;
    lease["connectionGeneration"] = lease.at("connectionGeneration").get<int64_t>() + 1;
    session["endpointLease"] = lease;
    save(session);
    run("COMMIT");
    return lease;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::endpoint_stream(const std::string &id, const std::string &owner,
                            const std::string &stream) {
  if (!valid_id(stream))
    throw Error("INVALID_REQUEST", "Invalid delivery stream");
  auto session = get(id);
  auto lease = session.value("endpointLease", Json());
  if (lease.is_null() || lease.at("owner") != owner ||
      (!lease.value("stream", "").empty() && lease.at("stream") != stream))
    throw Error("STREAM_CLOSED", "Control claim already owns another stream");
  lease["stream"] = stream;
  session["endpointLease"] = lease;
  save(session);
}
} // namespace coc
