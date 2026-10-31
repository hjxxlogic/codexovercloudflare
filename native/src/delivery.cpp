#include "coc/store.hpp"
namespace coc {
namespace {
constexpr int64_t sequence_max = 9007199254740991LL;
void positive_sequence(int64_t value) {
  if (value <= 0 || value > sequence_max)
    throw Error("INVALID_REQUEST", "Invalid delivery sequence");
}
} // namespace
Json Store::delivery_open(const std::string &stream, const std::string &session, int64_t slots,
                          int64_t bytes) {
  if (!valid_id(stream) || slots < 1 || slots > 100 || bytes < int64_t(max_frame) ||
      bytes > int64_t(max_queue))
    throw Error("INVALID_REQUEST", "Invalid delivery window");
  auto existing =
      query("SELECT session,slots,bytes FROM delivery_streams WHERE stream=?", {stream});
  if (!existing.empty() && (existing[0]["session"] != session || existing[0]["slots"] != slots ||
                            existing[0]["bytes"] != bytes))
    throw Error("IDEMPOTENCY_CONFLICT", "Delivery stream identity changed");
  run("INSERT OR IGNORE INTO delivery_streams(stream,session,slots,bytes) VALUES(?,?,?,?)",
      {stream, session, slots, bytes});
  return delivery_window(stream);
}
Json Store::delivery_window(const std::string &stream) {
  auto rows = query(
      "SELECT received,received_bytes,slots,bytes FROM delivery_streams WHERE stream=?", {stream});
  if (rows.empty())
    throw Error("NOT_FOUND", "Unknown delivery stream");
  const auto &state = rows[0];
  auto used = query("SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes "
                    "FROM delivery_commands WHERE stream=? AND phase!='finished'",
                    {stream});
  const auto sent = query("SELECT COALESCE(MAX(seq),0) AS seq FROM delivery_commands WHERE "
                          "stream=? AND phase='finished'",
                          {stream})[0]["seq"];
  const auto received = state["received"].get<int64_t>();
  const auto received_bytes = state["received_bytes"].get<int64_t>();
  return {{"stream", stream},
          {"instance", delivery_instance_},
          {"sent", sent},
          {"received", received},
          {"receivedBytes", received_bytes},
          {"credit", std::min(sequence_max, received + state["slots"].get<int64_t>() -
                                                used[0]["count"].get<int64_t>())},
          {"byteCredit", std::min(sequence_max, received_bytes + state["bytes"].get<int64_t>() -
                                                    used[0]["bytes"].get<int64_t>())}};
}
Json Store::delivery_record(const std::string &stream, int64_t seq) {
  auto rows =
      query("SELECT end_bytes,body,phase,result FROM delivery_commands WHERE stream=? AND seq=?",
            {stream, seq});
  if (rows.empty())
    return nullptr;
  auto record = rows[0];
  if (!record["result"].is_null())
    record["result"] = Json::parse(record["result"].get<std::string>());
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
    auto previous = delivery_record(stream, seq);
    if (!previous.is_null()) {
      if (previous["body"] != body || previous["end_bytes"] != end)
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
    run("INSERT INTO delivery_commands(stream,seq,end_bytes,body,phase) VALUES(?,?,?,?,'received')",
        {stream, seq, end, body});
    run("UPDATE delivery_streams SET received=?,received_bytes=? WHERE stream=?",
        {seq, end, stream});
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
  return {{"accepted", true}, {"window", delivery_window(stream)}};
}
bool Store::delivery_start(const std::string &stream, int64_t seq) {
  run("UPDATE delivery_commands SET phase='started' WHERE stream=? AND seq=? AND phase='received'",
      {stream, seq});
  return sqlite3_changes(db_) == 1;
}
void Store::delivery_finish(const std::string &stream, int64_t seq, const Json &result) {
  run("UPDATE delivery_commands SET phase='finished',result=? WHERE stream=? AND seq=? AND "
      "phase!='finished'",
      {result.dump(), stream, seq});
}
Json Store::delivery_heads(const std::string &session) {
  const auto history =
      query("SELECT MAX(0,COALESCE(MAX(seq),0)) AS head FROM events WHERE session=?", {session});
  const auto output = query("SELECT published FROM delivery_output_heads WHERE stream=?",
                            {"rpc-output:" + session});
  return {{"agent", history[0]["head"]},
          {"rpc", output.empty() ? Json(0) : output[0]["published"]}};
}
Json Store::output_state(const std::string &stream) {
  run("INSERT OR IGNORE INTO delivery_output_heads(stream) VALUES(?)", {stream});
  return query("SELECT sent,sent_bytes,published,acked,acked_bytes FROM delivery_output_heads "
               "WHERE stream=?",
               {stream})
      .at(0);
}
Json Store::output_append(const std::string &stream, const Json &payload) {
  const auto body = payload.dump();
  if (Json(body).dump().size() > max_frame - 4096)
    throw Error("MESSAGE_TOO_LARGE", "Reliable output exceeds frame budget");
  run("BEGIN IMMEDIATE");
  try {
    auto head = output_state(stream);
    const auto seq = head.at("sent").get<int64_t>() + 1;
    const auto end = head.at("sent_bytes").get<int64_t>() + int64_t(body.size());
    positive_sequence(seq);
    positive_sequence(end);
    run("INSERT INTO delivery_outputs VALUES(?,?,?,?)", {stream, seq, end, body});
    run("UPDATE delivery_output_heads SET sent=?,sent_bytes=? WHERE stream=?", {seq, end, stream});
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
      auto rows = query("SELECT end_bytes FROM delivery_outputs WHERE stream=? AND seq=?",
                        {stream, received});
      if (rows.empty())
        throw Error("STORAGE_ERROR", "Output receipt range is missing");
      const auto bytes = rows[0]["end_bytes"].get<int64_t>();
      if (byte_credit != -1 && (byte_credit < bytes || byte_credit - bytes > int64_t(max_queue) ||
                                byte_credit > sequence_max))
        throw Error("INVALID_REQUEST", "Invalid output byte credit");
      run("UPDATE delivery_output_heads SET acked=?,acked_bytes=? WHERE stream=?",
          {received, rows[0]["end_bytes"], stream});
      run("DELETE FROM delivery_outputs WHERE stream=? AND seq<=?", {stream, received});
    }
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
  run("UPDATE delivery_output_heads SET published=MAX(published,?) WHERE stream=?", {sent, stream});
}
Json Store::output_page(const std::string &stream, int64_t after) {
  auto state = output_state(stream);
  if (after < state.at("acked").get<int64_t>())
    throw Error("DELIVERY_STATE_MISMATCH", "Local receiver lost acknowledged output state");
  return query("SELECT seq,end_bytes AS 'end',body FROM delivery_outputs WHERE stream=? AND seq>? "
               "ORDER BY seq LIMIT 32",
               {stream, after});
}
} // namespace coc
