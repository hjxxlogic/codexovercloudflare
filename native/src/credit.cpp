#include "coc/credit.hpp"
#include "coc/delivery.hpp"
#include "coc/store.hpp"
namespace coc {
namespace {
std::string history_subscription_key(const Json &d) {
  for (const auto &field : {"sessionId", "owner", "stream", "instance", "exchangeId"})
    if (!d.contains(field) || !d.at(field).is_string() || d.at(field).get<std::string>().empty() ||
        d.at(field).get<std::string>().size() > 128)
      throw Error("INVALID_REQUEST", "Invalid history subscription identity");
  return delivery_digest(
      Json::array({d.at("sessionId"), d.at("owner"), d.at("stream"), d.at("instance")}).dump());
}
} // namespace
Json Store::history_hint(const Json &d) {
  const auto key = history_subscription_key(d);
  const auto rows = query("SELECT * FROM transport2_history_subscriptions WHERE key=?", {key});
  if (rows.empty() || rows.at(0).at("closed") == 1)
    throw Error("STREAM_CLOSED", "History subscription has retired");
  const auto &row = rows.at(0);
  const auto head = history_head(d.at("sessionId"));
  if (head < row.at("published").get<int64_t>())
    throw Error("DELIVERY_STATE_MISMATCH", "Authoritative history has rolled back");
  if (head > row.at("published").get<int64_t>())
    run("UPDATE transport2_history_subscriptions SET published=? WHERE key=?", {head, key});
  return {{"stream", d.at("stream")},
          {"instance", d.at("instance")},
          {"agentInstance", delivery_instance_},
          {"exchangeId", d.at("exchangeId")},
          {"streamSerial", row.at("serial")},
          {"creditGeneration", row.at("generation")},
          {"receivedRevision", row.at("received")},
          {"maxRevision", head}};
}
Json Store::history_subscription(const Json &d) {
  const auto key = history_subscription_key(d);
  const auto operation = d.value("operation", "");
  if (operation != "subscribe" && operation != "ack" && operation != "retire")
    throw Error("INVALID_REQUEST", "Invalid history subscription operation");
  if (d.contains("agentInstance") && d.at("agentInstance") != delivery_instance_)
    throw Error("DELIVERY_STATE_MISMATCH", "History Agent storage instance changed");
  const auto received = d.value("receivedRevision", int64_t(-1));
  const auto floor = d.value("acknowledgedRevision", int64_t(-1));
  if (received < 0 || received > 9007199254740991LL || floor < 0 || floor > received)
    throw Error("INVALID_REQUEST", "Invalid durable history checkpoint");
  run("BEGIN IMMEDIATE");
  try {
    get(d.at("sessionId"));
    auto rows = query("SELECT * FROM transport2_history_subscriptions WHERE key=?", {key});
    if (rows.empty()) {
      if (operation != "subscribe" || d.contains("streamSerial") || floor > 0)
        throw Error("DELIVERY_STATE_MISMATCH", "History subscription state is missing");
      if (query("SELECT COUNT(*) AS count FROM transport2_history_subscriptions")
              .at(0)
              .at("count") >= credit::flow_limit)
        throw Error("BACKPRESSURE", "History subscription metadata budget exhausted");
      const auto serial = query("SELECT COALESCE(MAX(serial),0)+1 AS serial FROM "
                                "transport2_history_subscriptions")
                              .at(0)
                              .at("serial");
      run("INSERT INTO "
          "transport2_history_subscriptions(key,session,owner,stream,instance,serial,generation) "
          "VALUES(?,?,?,?,?,?,?)",
          {key, d.at("sessionId"), d.at("owner"), d.at("stream"), d.at("instance"), serial,
           uuid()});
      rows = query("SELECT * FROM transport2_history_subscriptions WHERE key=?", {key});
    }
    const auto &row = rows.at(0);
    if (row.at("closed") == 1)
      throw Error("STREAM_CLOSED", "History subscription has retired");
    if ((d.contains("streamSerial") && d.at("streamSerial") != row.at("serial")) ||
        (d.contains("creditGeneration") && d.at("creditGeneration") != row.at("generation")))
      throw Error("DELIVERY_STATE_MISMATCH", "History allocation identity changed");
    if (operation != "subscribe" && (!d.contains("agentInstance") || !d.contains("streamSerial") ||
                                     !d.contains("creditGeneration")))
      throw Error("INVALID_REQUEST", "History acknowledgement requires its allocation identity");
    if (operation == "ack" && received > row.at("published").get<int64_t>())
      throw Error("INVALID_ACK", "History acknowledgement exceeds its published boundary");
    const auto state = history_hint(d);
    if (received > state.at("maxRevision").get<int64_t>() ||
        (operation == "subscribe" && (received < row.at("received").get<int64_t>() ||
                                      floor > row.at("received").get<int64_t>())))
      throw Error("DELIVERY_STATE_MISMATCH", "History durable checkpoint has rolled back");
    if (operation == "ack" && received > row.at("received").get<int64_t>())
      run("UPDATE transport2_history_subscriptions SET received=? WHERE key=?", {received, key});
    if (operation == "retire")
      run("UPDATE transport2_history_subscriptions SET closed=1 WHERE key=?", {key});
    auto result = state;
    if (operation == "ack")
      result["receivedRevision"] = std::max(received, row.at("received").get<int64_t>());
    result["closed"] = operation == "retire";
    run("COMMIT");
    return result;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::cache_uncharge(const std::string &key) {
  const auto rows = query("SELECT scope,bytes FROM transport2_cache_entries WHERE key=?", {key});
  if (rows.empty())
    return;
  run("UPDATE transport2_cache_budget SET bytes=bytes-?,records=records-1 WHERE scope=?",
      {rows.at(0).at("bytes"), rows.at(0).at("scope")});
  run("DELETE FROM transport2_cache_entries WHERE key=?", {key});
  run("DELETE FROM transport2_cache_budget WHERE scope=? AND records=0", {rows.at(0).at("scope")});
}
void Store::cache_forget(const std::string &key) {
  if (!query("SELECT 1 FROM transport2_local_credit WHERE key=?", {key}).empty())
    throw Error("STREAM_CLOSED", "A reliable local reservation requires explicit retirement");
  cache_uncharge(key);
  run("DELETE FROM cache WHERE key=?", {key});
}
void Store::cache_put(const std::string &raw_key, const Json &value) {
  const auto key = cache_namespace_ + raw_key;
  if (key.empty() || key.size() > 2048)
    throw Error("INVALID_REQUEST", "Local cache identity exceeds its metadata budget");
  const auto body = value.dump();
  const bool transaction = sqlite3_get_autocommit(db_) != 0;
  if (transaction)
    run("BEGIN IMMEDIATE");
  try {
    const auto allocation =
        query("SELECT reserved FROM transport2_local_credit WHERE key=?", {key});
    if (!allocation.empty()) {
      if (int64_t(body.size() + key.size() * 6 + 4096) >
          allocation.at(0).at("reserved").get<int64_t>())
        throw Error("BACKPRESSURE", "Durable local transport reservation is full");
    } else {
      const auto previous = query("SELECT bytes FROM transport2_cache_entries WHERE key=?", {key});
      const int64_t cost = body.size() + key.size() * 4 + 2048;
      const int64_t delta =
          cost - (previous.empty() ? 0 : previous.at(0).at("bytes").get<int64_t>());
      const auto usage =
          query("SELECT COALESCE(SUM(bytes),0) AS bytes,"
                "COALESCE(SUM(records),0) AS records,COUNT(*) AS scopes,"
                "COALESCE(SUM(CASE WHEN scope=? THEN bytes ELSE 0 END),0) AS own_bytes,"
                "COALESCE(SUM(CASE WHEN scope=? THEN records ELSE 0 END),0) AS own_records "
                "FROM transport2_cache_budget",
                {cache_namespace_, cache_namespace_})
              .at(0);
      const int64_t record = previous.empty() ? 1 : 0;
      if (usage.at("bytes").get<int64_t>() + delta > credit::cache_budget ||
          usage.at("own_bytes").get<int64_t>() + delta > credit::cache_scope ||
          usage.at("records").get<int64_t>() + record > credit::cache_records ||
          usage.at("own_records").get<int64_t>() + record > credit::cache_scope_records ||
          (usage.at("own_records") == 0 && usage.at("scopes") >= credit::flow_limit))
        throw Error("BACKPRESSURE", "Global or identity local cache quota exhausted");
      run("INSERT OR IGNORE INTO transport2_cache_budget VALUES(?,0,0)", {cache_namespace_});
      run("UPDATE transport2_cache_budget SET bytes=bytes+?,records=records+? WHERE scope=?",
          {delta, record, cache_namespace_});
      run("INSERT OR REPLACE INTO transport2_cache_entries VALUES(?,?,?)",
          {key, cache_namespace_, cost});
    }
    run("INSERT OR REPLACE INTO cache VALUES(?,?)", {key, body});
    if (transaction)
      run("COMMIT");
  } catch (...) {
    if (transaction)
      run("ROLLBACK");
    throw;
  }
}
void Store::local_reserve(const std::string &raw_key, const std::string &kind) {
  const auto key = cache_namespace_ + raw_key;
  if (key.empty() || key.size() > 1024 || (kind != "command" && kind != "output"))
    throw Error("INVALID_REQUEST", "Invalid local transport reservation");
  run("BEGIN IMMEDIATE");
  try {
    const auto existing = query("SELECT kind FROM transport2_local_credit WHERE key=?", {key});
    if (!existing.empty()) {
      if (existing.at(0).at("kind") != kind)
        throw Error("IDEMPOTENCY_CONFLICT", "Local transport reservation changed kind");
      run("COMMIT");
      return;
    }
    const auto capacity =
        kind == "command" ? credit::local_command_reservation : credit::local_output_reservation;
    const auto limit =
        kind == "command" ? credit::local_command_budget : credit::local_output_budget;
    if (query("SELECT COALESCE(SUM(reserved),0) AS used FROM transport2_local_credit WHERE kind=?",
              {kind})
                    .at(0)
                    .at("used")
                    .get<int64_t>() +
                capacity >
            limit ||
        query("SELECT COUNT(*) AS count FROM transport2_local_credit").at(0).at("count") >=
            credit::flow_limit)
      throw Error("BACKPRESSURE", "Global local transport reservations exhausted");
    const auto present =
        query("SELECT length(CAST(value AS BLOB)) AS bytes FROM cache WHERE key=?", {key});
    if (!present.empty() &&
        present.at(0).at("bytes").get<int64_t>() + int64_t(key.size() * 6) + 4096 > capacity)
      throw Error("BACKPRESSURE", "Existing local record exceeds its transport reservation");
    run("INSERT INTO transport2_local_credit VALUES(?,?,?)", {key, kind, capacity});
    cache_uncharge(key);
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::local_budget() {
  Json value = Json::object();
  for (const auto &kind : {"command", "output"}) {
    auto budget =
        query("SELECT COUNT(*) AS flows,COALESCE(SUM(b.reserved),0) AS reserved,"
              "COALESCE(SUM(COALESCE(length(CAST(c.value AS "
              "BLOB)),0)+COALESCE(o.bytes,0)+length(CAST(b.key AS "
              "BLOB))*6+4096),0) "
              "AS occupied FROM transport2_local_credit b LEFT JOIN cache c ON c.key=b.key "
              "LEFT JOIN (SELECT allocation,SUM(length(CAST(value AS BLOB))+8192) AS bytes "
              "FROM transport2_local_operations GROUP BY allocation) o ON o.allocation=b.key "
              "WHERE b.kind=?",
              {kind})
            .at(0);
    budget["unusedReserved"] =
        budget.at("reserved").get<int64_t>() - budget.at("occupied").get<int64_t>();
    value[kind] = budget;
  }
  value["cache"] =
      query("SELECT COALESCE(SUM(bytes),0) AS bytes,COALESCE(SUM(records),0) AS records,"
            "COUNT(*) AS scopes FROM transport2_cache_budget")
          .at(0);
  return value;
}
void Store::delivery_reserve(const std::string &stream, const std::string &session,
                             const std::string &lane, int64_t slots, int64_t bytes) {
  const auto existing = query("SELECT lane FROM transport2_credit WHERE stream=?", {stream});
  if (!existing.empty()) {
    if (existing.at(0).at("lane") != lane)
      throw Error("IDEMPOTENCY_CONFLICT", "Delivery lane changed");
    return;
  }
  if (lane != "normal" && lane != "priority")
    throw Error("INVALID_REQUEST", "Invalid delivery budget lane");
  const int64_t reservation =
      bytes + slots * credit::result_bytes + credit::record_limit * credit::record_bytes;
  const auto budget =
      query("SELECT COALESCE(SUM(reserved),0) AS total,"
            "COALESCE(SUM(CASE WHEN session=? THEN reserved ELSE 0 END),0) AS scope "
            "FROM transport2_credit WHERE lane=?",
            {session, lane})
          .at(0);
  if (budget.at("total").get<int64_t>() + reservation >
          (lane == "normal" ? credit::normal_budget : credit::priority_budget) ||
      budget.at("scope").get<int64_t>() + reservation >
          (lane == "normal" ? credit::normal_session : credit::priority_session))
    throw Error("BACKPRESSURE", "Global or session delivery reservation exhausted");
  if (query("SELECT COUNT(*) AS count FROM transport2_credit").at(0).at("count") >=
      credit::flow_limit)
    throw Error("BACKPRESSURE", "Closed-flow metadata cannot be compacted; new flows stopped");
  const auto control = control_state(session);
  const auto scope =
      session + ":" + (control.is_null() ? "local" : control.at("owner").get<std::string>());
  run("INSERT OR IGNORE INTO transport2_namespaces(scope) VALUES(?)", {scope});
  const auto allocation =
      query("SELECT allocated FROM transport2_namespaces WHERE scope=?", {scope})
          .at(0)
          .at("allocated")
          .get<int64_t>();
  if (allocation >= 9007199254740991LL)
    throw Error("BACKPRESSURE", "Stream serial exhausted");
  run("UPDATE transport2_namespaces SET allocated=? WHERE scope=?", {allocation + 1, scope});
  run("INSERT INTO transport2_credit(stream,session,lane,scope,serial,generation,reserved) "
      "VALUES(?,?,?,?,?,?,?)",
      {stream, session, lane, scope, allocation + 1, uuid(), reservation});
}
void Store::delivery_release(const std::string &stream) {
  const auto rows = query("SELECT closed,reserved FROM transport2_credit WHERE stream=?", {stream});
  if (rows.empty() || rows.at(0).at("closed") == 0 || rows.at(0).at("reserved") == 0)
    return;
  const auto head = delivery_result_state(stream);
  if (head.at("acked") != head.at("sent") ||
      !query("SELECT 1 FROM transport2_commands WHERE stream=? AND phase!='finished' LIMIT 1",
             {stream})
           .empty() ||
      !query("SELECT 1 FROM sessions WHERE json_extract(value,'$.activeTask.stream')=? AND "
             "json_extract(value,'$.running')=1 LIMIT 1",
             {stream})
           .empty())
    return;
  // Result ACK does not resolve an unknown external queue side effect. Its
  // original command evidence must survive closing/revoking this flow.
  for (const auto &command :
       query("SELECT c.seq,s.session FROM transport2_commands c "
             "JOIN transport2_streams s ON s.stream=c.stream WHERE c.stream=?",
             {stream})) {
    const auto owner =
        "command:" + delivery_digest(Json::array({stream, command.at("seq")}).dump());
    if (!query("SELECT 1 FROM transport2_history_entries WHERE key=?",
               {"reservation:" + Json::array({command.at("session"), owner}).dump()})
             .empty())
      return;
  }
  // A closed flow still has a permanent bounded tombstone and namespace boundary.
  // All results were acknowledged, so its per-command bodies and identity index may go.
  for (const auto &table :
       {"transport2_commands", "transport2_command_keys", "transport2_command_digests",
        "transport2_results", "transport2_result_content", "transport2_cancel"})
    run(std::string("DELETE FROM ") + table + " WHERE stream=?", {stream});
  run("UPDATE transport2_credit SET reserved=0 WHERE stream=?", {stream});
}
void Store::delivery_close(const std::string &stream) {
  const bool transaction = sqlite3_get_autocommit(db_) != 0;
  if (transaction)
    run("BEGIN IMMEDIATE");
  try {
    const auto rows = query("SELECT 1 FROM transport2_credit WHERE stream=?", {stream});
    if (rows.empty())
      throw Error("NOT_FOUND", "Unknown delivery allocation");
    // Fence first. No outstanding unused promise can be accepted after this commit.
    run("UPDATE transport2_credit SET closed=1 WHERE stream=?", {stream});
    run("UPDATE transport2_flow_control SET closed=1 WHERE stream=?", {stream});
    for (const auto &command :
         query("SELECT seq,body FROM transport2_commands WHERE stream=? AND phase='received'",
               {stream})) {
      delivery_finish(
          stream, command.at("seq"),
          delivery_failure(Json::parse(command.at("body").get<std::string>()), "STREAM_CLOSED",
                           "The original flow was explicitly retired before execution"));
    }
    run("DELETE FROM transport2_cancel WHERE stream=?", {stream});
    delivery_release(stream);
    if (transaction)
      run("COMMIT");
  } catch (...) {
    if (transaction)
      run("ROLLBACK");
    throw;
  }
}
void Store::delivery_retire_session(const std::string &session) {
  const bool transaction = sqlite3_get_autocommit(db_) != 0;
  if (transaction)
    run("BEGIN IMMEDIATE");
  try {
    for (const auto &flow :
         query("SELECT stream FROM transport2_credit WHERE session=? AND closed=0", {session}))
      delivery_close(flow.at("stream"));
    if (transaction)
      run("COMMIT");
  } catch (...) {
    if (transaction)
      run("ROLLBACK");
    throw;
  }
}
Json Store::delivery_budget() {
  Json value = {{"normalLimit", credit::normal_budget},
                {"priorityLimit", credit::priority_budget},
                {"controlReserve", credit::control_budget},
                {"recordLimit", credit::record_limit},
                {"flowLimit", credit::flow_limit}};
  for (const auto &lane : {"normal", "priority"}) {
    auto usage = query("SELECT COALESCE(SUM(reserved),0) AS reserved,COUNT(*) AS flows,"
                       "COALESCE(SUM(CASE WHEN closed=1 THEN 1 ELSE 0 END),0) AS closed "
                       "FROM transport2_credit WHERE lane=?",
                       {lane})
                     .at(0);
    const auto streams = " IN (SELECT stream FROM transport2_credit WHERE lane=?)";
    int64_t occupied = query(std::string("SELECT COALESCE(SUM(length(CAST(body AS "
                                         "BLOB))+COALESCE(length(CAST(result AS BLOB)),0)+") +
                                 std::to_string(credit::record_bytes) +
                                 "),0) AS bytes FROM transport2_commands WHERE stream" + streams,
                             {lane})
                           .at(0)
                           .at("bytes");
    for (const auto &table : {"transport2_results", "transport2_result_content"})
      occupied +=
          query(std::string("SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM ") +
                    table + " WHERE stream" + streams,
                {lane})
              .at(0)
              .at("bytes")
              .get<int64_t>();
    usage["occupied"] = occupied;
    usage["unusedReserved"] = usage.at("reserved").get<int64_t>() - occupied;
    value[lane] = usage;
  }
  value["namespaces"] =
      query("SELECT scope,allocated,COALESCE((SELECT MIN(serial)-1 FROM "
            "transport2_credit c WHERE c.scope=n.scope AND c.closed=0),"
            "n.allocated) AS closedThrough FROM transport2_namespaces n ORDER BY scope");
  return value;
}
} // namespace coc
