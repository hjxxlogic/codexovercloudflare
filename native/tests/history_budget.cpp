#include "coc/credit.hpp"
#include "coc/store.hpp"
#include <iostream>
using namespace coc;
namespace {
void check(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class F> void backpressure(F fn) {
  try {
    fn();
  } catch (const Error &error) {
    check(error.code == "BACKPRESSURE", error.what());
    return;
  }
  throw std::runtime_error("Expected history backpressure");
}
struct Temp {
  std::string path = (std::filesystem::temp_directory_path() / ("coc-history-" + uuid())).string();
  ~Temp() { std::filesystem::remove_all(path); }
};
struct Database {
  sqlite3 *db = nullptr;
  explicit Database(const std::string &dir) {
    check(sqlite3_open((dir + "/agent.db").c_str(), &db) == SQLITE_OK, "Open fixture database");
  }
  ~Database() { sqlite3_close(db); }
  void sql(const std::string &value) {
    check(sqlite3_exec(db, value.c_str(), nullptr, nullptr, nullptr) == SQLITE_OK,
          sqlite3_errmsg(db));
  }
  void legacy_schema() {
    sqlite3_stmt *query = nullptr;
    sqlite3_prepare_v2(db,
                       "SELECT name FROM sqlite_master WHERE type='trigger' AND "
                       "name LIKE 'transport2_history_%'",
                       -1, &query, nullptr);
    std::vector<std::string> names;
    while (sqlite3_step(query) == SQLITE_ROW)
      names.emplace_back(reinterpret_cast<const char *>(sqlite3_column_text(query, 0)));
    sqlite3_finalize(query);
    for (const auto &name : names)
      sql("DROP TRIGGER " + name);
    sql("DROP TABLE transport2_history_entries");
    sql("DROP TABLE transport2_history_budget");
    sql("DROP TABLE transport2_history_meta");
  }
};
void legacy_packing() {
  Temp temp;
  Json reference, snapshot, before;
  {
    Store journal(temp.path);
    journal.save({{"id", "h~legacy"}, {"state", "closed"}});
    std::string text;
    for (int i = 0; i < 1000; ++i)
      text += "你🙂";
    const auto event =
        journal.event("h~legacy", "item/agentMessage/delta", {{"itemId", "a"}, {"delta", text}});
    const auto seq = event.at("seq").get<int64_t>();
    Database fixture(temp.path);
    fixture.sql("BEGIN IMMEDIATE");
    fixture.sql("DELETE FROM chunks");
    fixture.sql("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<999) "
                "INSERT INTO chunks SELECT " +
                std::to_string(seq) + ",i*2,'你🙂' FROM n");
    fixture.sql("COMMIT");
    reference = journal.history_reference("h~legacy", seq);
    snapshot = journal.history("h~legacy");
    journal.history_reserve("h~legacy", 65536, 16);
    before = journal.history_budget();
    check(journal.history_compact().at("merged") == 0 && journal.history_budget() == before,
          "Packing cannot consume an active durable reservation");
    journal.history_release("h~legacy");
    before = journal.history_budget();
    fixture.sql("CREATE TRIGGER fail_pack BEFORE UPDATE ON chunks BEGIN "
                "SELECT RAISE(ABORT,'injected packing failure'); END");
    bool failed = false;
    try {
      journal.history_compact();
    } catch (const Error &) {
      failed = true;
    }
    check(failed && journal.history_budget() == before &&
              journal.history_reference("h~legacy", seq) == reference,
          "Packing failure restores deleted chunks, reference and accounting");
    fixture.sql("CREATE TEMP TABLE guard_check(n INTEGER CHECK(n=1))");
    fixture.sql("INSERT INTO guard_check SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' "
                "AND name='transport2_history_capacity'");
    fixture.sql("DROP TRIGGER fail_pack");
    fixture.sql("CREATE TRIGGER inflate_pack AFTER UPDATE ON chunks BEGIN "
                "UPDATE transport2_history_budget SET bytes=bytes+100000000 WHERE scope='@global'; "
                "END");
    failed = false;
    try {
      journal.history_compact();
    } catch (const Error &) {
      failed = true;
    }
    check(failed && journal.history_budget() == before &&
              journal.history_reference("h~legacy", seq) == reference,
          "Final net-growth verification rejects and rolls back an invalid migration");
    fixture.sql("INSERT INTO guard_check SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' "
                "AND name='transport2_history_capacity'");
    fixture.sql("DROP TRIGGER inflate_pack");
    const auto batch = journal.history_compact();
    check(batch.at("scanned") == 128 && batch.at("merged").get<int>() > 0,
          "Packing migration has a fixed per-transaction row budget");
  }
  {
    Store journal(temp.path, true, "", {{"maxBytes", 4096}, {"maxSessionBytes", 4096}});
    check(journal.history_budget().at("global").at("bytes") > 4096,
          "Migration fixture starts above the configured quota");
    for (int i = 0; i < 10; ++i)
      journal.history_compact();
    check(journal.history_reference("h~legacy", reference.at("seq")) == reference &&
              journal.history("h~legacy") == snapshot,
          "Restarted migration preserves digest, revision, snapshot and public cursors");
    const auto after = journal.history_budget();
    check(after.at("global").at("records").get<int64_t>() ==
                  before.at("global").at("records").get<int64_t>() - 998 &&
              after.at("global").at("bytes") < before.at("global").at("bytes"),
          "Legacy packing refunds only redundant chunk records and overhead");
    journal.history_compact();
    check(journal.history_budget() == after, "Packing an already packed body is idempotent");
  }
  {
    Store journal(temp.path, true, "", {{"maxBytes", 4096}, {"maxSessionBytes", 4096}});
    const auto budget = journal.history_budget();
    check(journal.history_compact().at("merged") == 0 && journal.history_budget() == budget,
          "Finished packing remains idempotent above the configured quota");
    backpressure([&] { journal.event("h~legacy", "record", "still forbidden"); });
    check(journal.history_budget() == budget, "Packing restores quota enforcement before commit");
  }
}
void inline_transition() {
  Temp temp;
  Json original;
  int64_t seq = 0;
  {
    Store store(temp.path);
    store.save({{"id", "host~inline"}});
    std::string prefix;
    for (int i = 0; i < 1714; ++i)
      prefix += "你🙂";
    const auto event = store.event("host~inline", "item/agentMessage/delta",
                                   {{"turnId", "turn"}, {"itemId", "item"}, {"delta", prefix}});
    seq = event.at("seq");
    original = store.history_reference("host~inline", seq);
    Database fixture(temp.path);
    fixture.sql("CREATE TEMP TABLE assertion(n INTEGER CHECK(n=1)); "
                "INSERT INTO assertion SELECT COUNT(*)=0 FROM chunks");
    check(store.content("host~inline", seq, 1).at("text").get<std::string>() == prefix.substr(3),
          "Inline-only body remains readable at Unicode offsets");
    const auto before = store.history_budget();
    fixture.sql("CREATE TRIGGER fail_transition BEFORE INSERT ON chunks "
                "BEGIN SELECT RAISE(ABORT,'injected transition failure'); END");
    bool failed = false;
    try {
      store.event("host~inline", "item/agentMessage/delta",
                  {{"turnId", "turn"}, {"itemId", "item"}, {"delta", "你🙂"}});
    } catch (const Error &) {
      failed = true;
    }
    check(failed && store.history_budget() == before &&
              store.history_reference("host~inline", seq) == original,
          "Failed inline-to-chunk conversion restores body, revision and accounting");
    fixture.sql("DROP TRIGGER fail_transition");
    const auto next = store.event("host~inline", "item/agentMessage/delta",
                                  {{"turnId", "turn"}, {"itemId", "item"}, {"delta", "你🙂"}});
    check(next.at("seq") == seq && store.content("host~inline", seq, 3427).at("text") == "🙂你🙂",
          "Conversion preserves stream identity and multibyte chunk boundary");
    fixture.sql(
        "INSERT INTO assertion SELECT MAX(length(CAST(text AS BLOB)))<=4096 FROM chunks; "
        "INSERT INTO assertion SELECT json_extract(value,'$.data.delta') IS NULL FROM history");
    original = store.history_reference("host~inline", seq);
  }
  Store reopened(temp.path);
  check(reopened.history_reference("host~inline", seq) == original,
        "Converted stream remains identical after restart");
}
void external_inline_transition() {
  Temp temp;
  Store store(temp.path);
  const std::string session = "host~external-inline";
  store.save({{"id", session}, {"external", true}});
  Json item = {{"id", "answer"}, {"type", "agentMessage"}, {"text", std::string(5000, 'a')}};
  const auto initial = store.external_item(session, "turn", item);
  const auto seq = initial.at("seq");
  const auto reference = store.history_reference(session, seq);
  Database fixture(temp.path);
  fixture.sql("CREATE TEMP TABLE assertion(n INTEGER CHECK(n=1)); "
              "INSERT INTO assertion SELECT COUNT(*)=0 FROM chunks");
  const auto before = store.history_budget();
  check(store.external_item(session, "turn", item).is_null() && store.history_budget() == before,
        "Inline external duplicate is still deduplicated");
  item["text"] = std::string(20000, 'a');
  fixture.sql("CREATE TRIGGER fail_external_transition BEFORE INSERT ON chunks "
              "BEGIN SELECT RAISE(ABORT,'injected external transition failure'); END");
  bool failed = false;
  try {
    store.external_item(session, "turn", item);
  } catch (const Error &) {
    failed = true;
  }
  check(failed && store.history_budget() == before &&
            store.history_reference(session, seq) == reference,
        "External conversion failure restores fingerprint, revision, body and accounting");
  fixture.sql("DROP TRIGGER fail_external_transition");
  check(store.external_item(session, "turn", item).at("seq") == seq,
        "External growth keeps item identity");
  fixture.sql(
      "INSERT INTO assertion SELECT json_extract(value,'$.data.append')=1 AND "
      "length(json_extract(value,'$.data.text'))=15000 FROM events ORDER BY seq DESC LIMIT 1");
  item["text"] = "short";
  const auto shrunk = store.external_item(session, "turn", item);
  check(shrunk.at("seq") == seq && store.content(session, seq, 0).at("text") == "short",
        "External replacement returns to a single inline copy");
  fixture.sql("INSERT INTO assertion SELECT COUNT(*)=0 FROM chunks");
  Json tool = {{"id", "tool"},
               {"type", "commandExecution"},
               {"status", "completed"},
               {"aggregatedOutput", "output"},
               {"command", "echo output"}};
  const auto tool_event = store.external_item(session, "turn", tool);
  check(store.content(session, tool_event.at("seq"), 0).at("text") == tool.dump(),
        "Generic external inline body retains item JSON, not only command output");
}
void scoped_queue_reservations() {
  Temp temp;
  const std::string session = "host~queue-reservation";
  Json remaining;
  {
    Store store(temp.path);
    store.save({{"id", session}, {"running", false}});
    store.history_reserve(session, 65536, 16);
    const auto ordinary = store.history_budget().at("global");
    store.history_reserve(session, 16384, 8, "runtime-terminal");
    check(store.history_budget().at("global").at("bytes").get<int64_t>() ==
                  ordinary.at("bytes").get<int64_t>() + 16384 &&
              store.history_budget().at("global").at("records").get<int64_t>() ==
                  ordinary.at("records").get<int64_t>() + 8,
          "Terminal capacity is independently charged and cannot consume ordinary headroom");
    store.history_reserve(session, 65536, 16, "first");
    store.history_reserve(session, 65536, 16, "second");
    const auto all = store.history_budget();
    store.history_reserve(session, 65536, 16, "first");
    check(store.history_budget() == all, "Scoped promise replay does not allocate twice");
    store.event(session, "observation", {{"text", "unrelated history"}});
    Database fixture(temp.path);
    fixture.sql("CREATE TEMP TABLE assertion(n INTEGER CHECK(n=1)); "
                "INSERT INTO assertion SELECT COUNT(*)=2 FROM transport2_history_entries "
                "WHERE key GLOB 'reservation:[[]*' AND bytes=65536 AND records=16; "
                "CREATE TEMP TABLE original_turn AS SELECT * FROM transport2_history_entries "
                "WHERE key NOT GLOB 'reservation:[[]*' AND key GLOB 'reservation:*'");
    const auto before = store.history_budget(), history = store.history(session);
    fixture.sql("CREATE TRIGGER fail_queue_receipt BEFORE INSERT ON history BEGIN "
                "SELECT RAISE(ABORT,'injected receipt projection failure'); END");
    bool failed = false;
    try {
      store.history_queue_accept(session, "first", {{"requestId", "first"}, {"text", "queued"}});
    } catch (const Error &) {
      failed = true;
    }
    check(failed && store.history_budget() == before && store.history(session) == history,
          "Receipt failure restores its promise and every unrelated reservation");
    fixture.sql("DROP TRIGGER fail_queue_receipt");
    const auto event =
        store.history_queue_accept(session, "first", {{"requestId", "first"}, {"text", "queued"}});
    check(event.at("type") == "queueAccepted" && event.at("data").at("requestId") == "first",
          "Accepted queue receipt retains its original request identity");
    fixture.sql("INSERT INTO assertion SELECT COUNT(*)=0 FROM (SELECT * FROM original_turn "
                "EXCEPT SELECT * FROM transport2_history_entries); "
                "INSERT INTO assertion SELECT COUNT(*)=1 FROM transport2_history_entries "
                "WHERE key GLOB 'reservation:[[]*' AND bytes=65536 AND records=16");
    store.history_release(session);
    check(store.history_journal_compact().at("removedEvents") == 0,
          "Unresolved queue promise is honored by idle history maintenance");
    remaining = store.history_budget();
  }
  Store reopened(temp.path, false);
  check(reopened.history_budget() == remaining,
        "Unresolved queue resource promise survives process restart");
  reopened.history_release(session, "second");
  check(reopened.history_budget().at("global").at("bytes").get<int64_t>() ==
                remaining.at("global").at("bytes").get<int64_t>() - 65536 &&
            reopened.history_journal_compact().at("removedEvents") > 0,
        "Resolving one queue promise refunds only its capacity and unpins maintenance");
}
void atomic_turn_admission() {
  Temp temp;
  const std::string session = "host~atomic-admission";
  Json committed, snapshot, budget;
  const Json task = {{"requestId", "original"}, {"stream", "commands"}, {"seq", 1}};
  {
    Store store(temp.path);
    store.save({{"id", session}, {"state", "ready"}, {"running", false}});
    const auto original = store.get(session), empty = store.history_budget();
    Database fixture(temp.path);
    fixture.sql("CREATE TRIGGER fail_admission BEFORE INSERT ON history BEGIN "
                "SELECT RAISE(ABORT,'injected user projection failure'); END");
    bool failed = false;
    try {
      store.history_turn_admit(session, {{"text", "input"}}, {{"text", "input"}}, task, true);
    } catch (const Error &) {
      failed = true;
    }
    check(failed && store.get(session) == original && store.history_budget() == empty &&
              store.history(session).at("events").empty(),
          "Failed user projection rolls back task identity, running state, title and reservation");
    fixture.sql("DROP TRIGGER fail_admission");
    const auto event = store.history_turn_admit(
        session, {{"text", "input"}}, {{"text", "input"}, {"requestId", "original"}}, task, true);
    check(store.get(session).at("running") == true && store.get(session).at("activeTask") == task &&
              store.get(session).at("title") == "input" &&
              event.at("data").at("requestId") == "original",
          "Successful admission atomically retains task identity and original user history");
    auto state = store.get(session);
    state["turnId"] = "active-turn";
    store.save(state);
    state = store.get(session);
    snapshot = store.history(session);
    budget = store.history_budget();
    fixture.sql("CREATE TRIGGER fail_steer BEFORE INSERT ON history BEGIN "
                "SELECT RAISE(ABORT,'injected steer projection failure'); END");
    failed = false;
    try {
      store.history_turn_admit(
          session, {{"expectedTurnId", "active-turn"}, {"text", std::string(260000, 'x')}},
          {{"text", "steer"}}, nullptr, false);
    } catch (const Error &) {
      failed = true;
    }
    check(failed && store.history_budget() == budget && store.history(session) == snapshot &&
              store.get(session) == state,
          "Failed steering restores increased reservations without retiring the active turn");
    fixture.sql("DROP TRIGGER fail_steer");
    committed = store.get(session);
  }
  Store reopened(temp.path, false);
  check(reopened.get(session) == committed && reopened.history_budget() == budget &&
            reopened.history(session) == snapshot,
        "Atomic admission and original task evidence survive reopening");
  Temp limited;
  Store small(limited.path, true, "", {{"maxBytes", 32768}, {"maxSessionBytes", 32768}});
  small.save({{"id", session}, {"state", "ready"}, {"running", false}});
  const auto original = small.get(session), empty = small.history_budget();
  backpressure([&] {
    small.history_turn_admit(session, {{"text", "input"}}, {{"text", "input"}}, task, true);
  });
  check(small.get(session) == original && small.history_budget() == empty &&
            small.history(session).at("events").empty(),
        "Capacity rejection cannot leave a submitted task or partial user history");
}
void journal_cleanup() {
  Temp temp;
  const std::string session = "host~journal-cleanup";
  Json reference, snapshot, expected_budget;
  {
    Store store(temp.path);
    store.save({{"id", session}, {"running", false}, {"state", "closed"}});
    for (int i = 0; i < 270; ++i)
      store.event(session, "item/agentMessage/delta",
                  {{"turnId", "turn"}, {"itemId", "answer"}, {"delta", "你🙂"}});
    store.archive_event(session, "user", {{"text", "archived"}});
    store.external_item(session, "external-turn",
                        {{"id", "tool"}, {"type", "commandExecution"}, {"aggregatedOutput", "old"}},
                        true);
    const auto external = store.external_item(
        session, "external-turn",
        {{"id", "tool"}, {"type", "commandExecution"}, {"aggregatedOutput", "new"}});
    reference = store.history_reference(session, external.at("seq"));
    // This request's unknown execution evidence is unrelated to display logs.
    const Json intent = {{"requestId", "unknown"},
                         {"owner", std::string(64, 'a')},
                         {"instance", store.delivery_instance()}};
    store.operation_begin(intent, "stop", {{"sessionId", session}});
    Database fixture(temp.path);
    fixture.sql("INSERT INTO events(session,value,time) VALUES('" + session +
                "','{\"type\":\"orphan\",\"data\":{}}',1)");
    store.event(session, "user", {{"text", "later projected event"}});
    snapshot = store.history(session);
    const auto before = store.history_budget();
    store.history_reserve(session, 65536, 16);
    check(store.history_journal_compact().at("removedEvents") == 0,
          "Raw cleanup does not consume or refund active history promises");
    store.history_release(session);
    auto state = store.get(session);
    state["running"] = true;
    store.save(state);
    check(store.history_journal_compact().at("removedEvents") == 0,
          "Raw cleanup skips running sessions");
    while (store.history_journal_compact().at("scanned") == 128) {
    }
    state["running"] = false;
    store.save(state);
    fixture.sql("CREATE TRIGGER fail_journal BEFORE DELETE ON events WHEN OLD.seq=2 "
                "BEGIN SELECT RAISE(ABORT,'injected journal cleanup failure'); END");
    bool failed = false;
    for (int i = 0; i < 4 && !failed; ++i) {
      try {
        store.history_journal_compact();
      } catch (const Error &) {
        failed = true;
      }
    }
    check(failed && store.history_budget() == before && store.history(session) == snapshot,
          "Raw journal failure rolls back preceding deletes, ledger and scan position");
    fixture.sql("DROP TRIGGER fail_journal");
    int64_t removed = 0, reclaimed = 0;
    for (int i = 0; i < 6; ++i) {
      const auto batch = store.history_journal_compact();
      check(batch.at("scanned") <= 128 && batch.at("removedEvents") <= 128,
            "Raw journal reclamation has a fixed per-transaction bound");
      removed += batch.at("removedEvents").get<int64_t>();
      reclaimed += batch.at("reclaimedBytes").get<int64_t>();
    }
    check(removed == 275 && store.history(session) == snapshot &&
              store.history_reference(session, external.at("seq")) == reference &&
              store.history_budget().at("global").at("bytes").get<int64_t>() ==
                  before.at("global").at("bytes").get<int64_t>() - reclaimed,
          "Projected deltas and superseded snapshots are reclaimed with exact accounting");
    fixture.sql("CREATE TEMP TABLE assertion(n INTEGER CHECK(n=1)); "
                "INSERT INTO assertion SELECT COUNT(*)=1 FROM events; "
                "INSERT INTO assertion SELECT json_extract(value,'$.type')='orphan' FROM events; "
                "INSERT INTO assertion SELECT COUNT(*)=1 FROM transport2_operations "
                "WHERE request_id='unknown'");
    expected_budget = store.history_budget();
  }
  Store reopened(temp.path, false);
  check(reopened.history_journal_compact().at("removedEvents") == 0 &&
            reopened.history(session) == snapshot && reopened.history_budget() == expected_budget &&
            reopened.history_reference(session, reference.at("seq")) == reference,
        "Reopening raw journal reclamation is idempotent and retains original projected history");
}
void projected_history_heads() {
  Temp temp;
  const std::string session = "host~projected-head";
  Json snapshot, reference, negative, identity;
  Json request = {{"sessionId", session},     {"owner", "reader"},
                  {"stream", "subscription"}, {"instance", "client-storage"},
                  {"exchangeId", "exchange"}, {"operation", "subscribe"},
                  {"receivedRevision", 0},    {"acknowledgedRevision", 0}};
  int64_t head = 0;
  {
    Store store(temp.path);
    store.save({{"id", session}, {"state", "closed"}});
    store.event(session, "item/agentMessage/delta", {{"itemId", "a"}, {"delta", "first"}});
    store.event(session, "item/agentMessage/delta", {{"itemId", "a"}, {"delta", "second"}});
    negative = store.archive_event(session, "user", {{"text", "archive"}});
    const auto external = store.external_item(
        session, "turn", {{"id", "external"}, {"type", "agentMessage"}, {"text", "external"}},
        true);
    store.external_item(session, "turn",
                        {{"id", "external"}, {"type", "agentMessage"}, {"text", "updated"}});
    snapshot = store.history(session);
    head = snapshot.at("snapshotSeq");
    reference = store.history_reference(session, external.at("seq"));
    identity = store.history_subscription(request);
    for (const auto &field : {"agentInstance", "streamSerial", "creditGeneration"})
      request[field] = identity.at(field);
    request["operation"] = "ack";
    request["receivedRevision"] = head;
    store.history_subscription(request);
    Database fixture(temp.path);
    fixture.sql("DELETE FROM events");
    check(store.history(session) == snapshot && store.delivery_heads(session).at("agent") == head &&
              store.history_hint(request).at("maxRevision") == head &&
              store.history_reference(session, external.at("seq")) == reference,
          "Removing raw journal copies cannot rewind projections, heads or original references");
    check(store.replay(session, 0).at("events") == store.history(session, 0, 0).at("events"),
          "Offline replay still reads the complete projected view without raw events");
  }
  Store restored(temp.path);
  check(restored.history(session) == snapshot,
        "Restart with an empty event journal retains history");
  request["operation"] = "subscribe";
  request["acknowledgedRevision"] = head;
  check(restored.history_subscription(request).at("receivedRevision") == head,
        "Confirmed history subscription survives empty-journal restart");
  const auto archive = restored.archive_event(session, "user", {{"text", "next archive"}});
  check(archive.at("seq") < reference.at("seq") && archive.at("seq") < negative.at("seq") &&
            restored.history(session).at("snapshotSeq") == head,
        "Negative archive allocation cannot reuse a retained projection identity or alter head");
  const auto next = restored.event(session, "user", {{"text", "next live"}});
  check(next.at("revision") > head &&
            restored.delivery_heads(session).at("agent") == next.at("revision"),
        "SQLite allocation and projected high watermark remain monotonic after journal removal");
  const auto before = restored.history(session);
  Database fixture(temp.path);
  fixture.sql("CREATE TRIGGER fail_projection BEFORE INSERT ON history BEGIN "
              "SELECT RAISE(ABORT,'injected projection failure'); END");
  bool failed = false;
  try {
    restored.event(session, "user", {{"text", "not committed"}});
  } catch (const Error &) {
    failed = true;
  }
  check(failed && restored.history(session) == before &&
            restored.delivery_heads(session).at("agent") == next.at("revision"),
        "Failed projection cannot publish an allocated but uncommitted event revision");
}
void legacy_inline_dedup() {
  Temp temp;
  Json reference, snapshot, tool_reference;
  const std::string session = "host~legacy-inline";
  {
    Store store(temp.path);
    store.save({{"id", session}, {"running", false}, {"external", true}});
    const auto event = store.event(session, "item/agentMessage/delta",
                                   {{"turnId", "turn"}, {"itemId", "answer"}, {"delta", "甲🙂乙"}});
    const auto seq = event.at("seq").get<int64_t>();
    const Json item = {{"id", "tool"}, {"type", "commandExecution"}, {"aggregatedOutput", "body"}};
    const auto tool = store.external_item(session, "turn", item);
    const auto mismatch =
        store.event(session, "item/agentMessage/delta",
                    {{"turnId", "turn"}, {"itemId", "mismatch"}, {"delta", "original"}});
    const auto partial =
        store.event(session, "item/agentMessage/delta",
                    {{"turnId", "turn"}, {"itemId", "partial"}, {"delta", "甲🙂乙"}});
    Database fixture(temp.path);
    fixture.sql("INSERT INTO chunks VALUES(" + std::to_string(seq) + ",0,'甲🙂'),(" +
                std::to_string(seq) + ",2,'乙')");
    fixture.sql("INSERT INTO chunks SELECT seq,0,json_extract(value,'$.data.item') FROM history "
                "WHERE seq=" +
                tool.at("seq").dump());
    fixture.sql("INSERT INTO chunks VALUES(" + mismatch.at("seq").dump() + ",0,'modified')");
    fixture.sql("INSERT INTO chunks VALUES(" + partial.at("seq").dump() + ",2,'乙')");
    reference = store.history_reference(session, seq);
    tool_reference = store.history_reference(session, tool.at("seq"));
    snapshot = store.history(session);
    auto state = store.get(session);
    state["running"] = true;
    store.save(state);
    check(store.history_inline_compact().at("removedChunks") == 0,
          "Inline migration skips running sessions");
    state["running"] = false;
    store.save(state);
    store.history_reserve(session, 65536, 16);
    check(store.history_inline_compact().at("removedChunks") == 0,
          "Inline migration skips active promises");
    store.history_release(session);
    const auto before = store.history_budget();
    fixture.sql(
        "CREATE TRIGGER fail_inline BEFORE DELETE ON chunks WHEN OLD.seq=" + tool.at("seq").dump() +
        " BEGIN SELECT RAISE(ABORT,'injected inline migration failure'); END");
    bool failed = false;
    try {
      store.history_inline_compact();
    } catch (const Error &) {
      failed = true;
    }
    check(failed && store.history_budget() == before &&
              store.history_reference(session, seq) == reference,
          "Later migration failure restores earlier removals and accounting");
    fixture.sql("DROP TRIGGER fail_inline");
    const auto result = store.history_inline_compact();
    check(
        result.at("removedChunks") == 4 &&
            store.history_budget().at("global").at("bytes").get<int64_t>() ==
                before.at("global").at("bytes").get<int64_t>() -
                    result.at("reclaimedBytes").get<int64_t>() &&
            store.history_reference(session, seq) == reference &&
            store.history(session) == snapshot &&
            store.history_reference(session, tool.at("seq")) == tool_reference &&
            store.content(session, partial.at("seq"), 0).at("text") == "甲🙂乙",
        "Only matching copies are refunded; incomplete matching fragments use intact inline body");
    fixture.sql("CREATE TEMP TABLE assertion(n INTEGER CHECK(n=1)); "
                "INSERT INTO assertion SELECT COUNT(*)=1 FROM chunks; "
                "INSERT INTO assertion SELECT text='modified' FROM chunks");
  }
  Store reopened(temp.path);
  check(reopened.history_inline_compact().at("removedChunks") == 0 &&
            reopened.history_reference(session, reference.at("seq")) == reference &&
            reopened.history(session) == snapshot,
        "Migration is idempotent across restart and does not erase conflicting evidence");
}
void packed_deltas() {
  Temp temp;
  int64_t seq = 0, revision = 0;
  const std::string unit = "你🙂";
  {
    Store journal(temp.path);
    journal.save({{"id", "packed"}, {"state", "closed"}, {"running", false}});
    for (int i = 0; i < 3000; ++i) {
      const auto event = journal.event("packed", "item/agentMessage/delta",
                                       {{"itemId", "answer"}, {"delta", unit}});
      seq = event.at("seq");
      revision = event.at("revision");
    }
    Database fixture(temp.path);
    fixture.sql("CREATE TEMP TABLE assertion(n INTEGER CHECK(n=1))");
    fixture.sql("INSERT INTO assertion SELECT COUNT(*)=6 FROM chunks");
    fixture.sql("INSERT INTO assertion SELECT MAX(length(CAST(text AS BLOB)))<=4096 FROM chunks");
    const auto budget = journal.history_budget();
    fixture.sql("CREATE TRIGGER reject_projection BEFORE UPDATE ON history BEGIN "
                "SELECT RAISE(ABORT,'injected projection failure'); END");
    bool failed = false;
    try {
      journal.event("packed", "item/agentMessage/delta",
                    {{"itemId", "answer"}, {"delta", "must roll back"}});
    } catch (const Error &) {
      failed = true;
    }
    check(failed && journal.history_budget() == budget,
          "Failed projection restores packed tail and accounting atomically");
    fixture.sql("DROP TRIGGER reject_projection");
  }
  Store reopened(temp.path);
  const auto read = [&](int64_t offset) {
    std::string text;
    for (;;) {
      const auto page = reopened.content("packed", seq, offset, revision);
      text += page.at("text").get<std::string>();
      check(page.at("nextOffset").get<int64_t>() >= offset, "Content cursor never retreats");
      offset = page.at("nextOffset");
      if (!page.at("more").get<bool>())
        break;
    }
    check(offset == 6000, "Packed body retains Unicode length");
    return text;
  };
  std::string expected;
  for (int i = 0; i < 3000; ++i)
    expected += unit;
  check(read(0) == expected, "Packed Unicode body survives restart and rollback");
  for (const int offset : {1, 1169, 1170, 2339, 4095, 4096, 5999, 6000}) {
    std::string suffix;
    for (int i = offset; i < 6000; ++i)
      suffix += i % 2 == 0 ? "你" : "🙂";
    check(read(offset) == suffix,
          "Random character offsets cross packed byte boundaries correctly");
  }
}
void configurable_policy() {
  for (const auto &fixture :
       read_json(std::filesystem::path(COC_SOURCE_DIR) / "tests/history-policy-fixtures.json")) {
    bool valid = true;
    try {
      history_storage_config(fixture.at("input"));
    } catch (const Error &error) {
      check(error.code == "CONFIG_ERROR", "Policy error category");
      valid = false;
    }
    check(valid == fixture.at("valid").get<bool>(), fixture.at("name").get<std::string>().c_str());
  }
  Temp temp;
  Json policy = {{"maxBytes", 32768},
                 {"maxSessionBytes", 16384},
                 {"maxRecords", 20},
                 {"maxSessionRecords", 10}};
  Json before;
  {
    Store journal(temp.path, true, "", policy);
    journal.save({{"id", "one"}, {"state", "closed"}});
    journal.event("one", "record", "small");
    before = journal.history_budget();
    Store auxiliary(temp.path, false);
    check(auxiliary.history_budget() == before, "Auxiliary store preserves configured policy");
    backpressure([&] { journal.event("one", "record", std::string(20000, 'x')); });
  }
  {
    Database fixture(temp.path);
    fixture.sql("CREATE TRIGGER history_policy_fault BEFORE INSERT ON transport2_history_policy "
                "BEGIN SELECT RAISE(ABORT,'injected policy failure'); END");
  }
  bool rejected = false;
  try {
    Store failed(temp.path, true, "", {{"maxBytes", 131072}, {"maxSessionBytes", 65536}});
  } catch (const Error &) {
    rejected = true;
  }
  check(rejected, "Injected policy migration failure is reported");
  {
    Database fixture(temp.path);
    fixture.sql("DROP TRIGGER history_policy_fault");
  }
  {
    Store unchanged(temp.path, false);
    check(unchanged.history_budget() == before,
          "Failed policy transaction preserves quota and ledger");
  }
  policy["maxBytes"] = 262144;
  policy["maxSessionBytes"] = 131072;
  {
    Store raised(temp.path, true, "", policy);
    raised.event("one", "record", std::string(20000, 'x'));
    check(raised.history_budget()["global"]["bytes"] > before["global"]["bytes"],
          "Changed JSON replaces existing database trigger quota");
    before = raised.history_budget();
  }
  policy["maxBytes"] = 4096;
  policy["maxSessionBytes"] = 4096;
  {
    Store lowered(temp.path, true, "", policy);
    check(lowered.history_budget()["global"] == before["global"] &&
              lowered.history("one")["events"].size() == 2,
          "Lower quota preserves existing authority and reads");
    bool storage_failure = false;
    lowered.on_failure([&] { storage_failure = true; });
    backpressure([&] { lowered.history_require_capacity("one", 4096, 2); });
    check(!storage_failure, "Pre-execution capacity rejection does not stop the Agent");
    backpressure([&] { lowered.event("one", "record", "extra"); });
    check(lowered.history_budget()["global"] == before["global"], "Rejected growth is atomic");
  }
}
void durable_reservations() {
  Temp temp;
  const Json policy = {{"maxBytes", 32768}, {"maxSessionBytes", 32768}, {"minFreeDiskBytes", 1}};
  Json saved;
  {
    Store journal(temp.path, true, "", policy);
    journal.history_reserve("one", 20000);
    saved = journal.history_budget();
    journal.history_reserve("one", 4096);
    check(journal.history_budget() == saved, "Repeated admission never shrinks a promise");
    bool failed = false;
    journal.on_failure([&] { failed = true; });
    backpressure([&] { journal.history_reserve("two", 20000); });
    check(!failed && journal.history_budget() == saved,
          "Concurrent session reservation cannot oversubscribe or stop the Agent");
    journal.save({{"id", "two"}, {"state", "closed"}});
    backpressure([&] { journal.event("two", "record", std::string(10000, 'x')); });
    check(journal.history_budget() == saved, "Unreserved writes cannot steal promised space");
  }
  {
    Store journal(temp.path, true, "", policy);
    check(journal.history_budget() == saved, "Crash/reopen retains unused promises");
    journal.history_release("one");
    journal.history_release("one");
    check(journal.history_budget()["global"]["bytes"] == 0 &&
              journal.history_budget()["global"]["records"] == 0,
          "Explicit safe retirement refunds reservation exactly once");
    journal.history_reserve("two", 20000);
  }
}
void reservation_conversion() {
  Temp temp;
  Json checkpoint;
  const Json policy = {{"maxBytes", 65536}, {"maxSessionBytes", 65536}, {"minFreeDiskBytes", 1}};
  {
    Store journal(temp.path, true, "", policy);
    journal.save({{"id", "one"}, {"state", "closed"}});
    journal.history_reserve("one", 60000);
    const auto start = journal.history_budget();
    journal.event("one", "item/agentMessage/delta", {{"itemId", "a"}, {"delta", "你好"}});
    journal.event("one", "item/agentMessage/delta", {{"itemId", "a"}, {"delta", " world"}});
    check(journal.history_budget()["global"]["bytes"] == start["global"]["bytes"],
          "Raw events, projection and chunk growth consume reserved bytes exactly once");
    checkpoint = journal.history_budget();
    const auto page = journal.history("one");
    backpressure([&] { journal.event("one", "record", std::string(60000, 'x')); });
    check(journal.history_budget() == checkpoint && journal.history("one") == page,
          "Failure after consuming a reservation rolls back promise and body together");
  }
  {
    Store journal(temp.path, true, "", policy);
    check(journal.history_budget() == checkpoint, "Converted reservation survives restart");
    journal.history_release("one");
    const auto actual = journal.history_budget()["global"]["bytes"].get<int64_t>();
    check(actual > 0 && actual < 60000,
          "Retirement only refunds unused bytes, retaining actual body");
    journal.history_release("one");
    check(journal.history_budget()["global"]["bytes"] == actual,
          "Retirement cannot refund body twice");
  }
}
void record_reservations() {
  Temp temp;
  const Json policy = {{"maxBytes", 65536},
                       {"maxSessionBytes", 65536},
                       {"maxRecords", 8},
                       {"maxSessionRecords", 8},
                       {"minFreeDiskBytes", 1}};
  Json saved;
  {
    Store journal(temp.path, true, "", policy);
    journal.save({{"id", "one"}, {"state", "closed"}});
    journal.history_reserve("one", 40000, 8);
    saved = journal.history_budget();
    backpressure([&] { journal.history_reserve("two", 4096, 1); });
    check(journal.history_budget() == saved, "Record promises prevent another session admission");
    for (int n = 0; n < 4; ++n) {
      journal.event("one", "record", "small");
      check(journal.history_budget()["global"]["records"] == 8,
            "Each event and projection consume promised record capacity");
    }
    saved = journal.history_budget();
    backpressure([&] { journal.event("one", "record", "overflow"); });
    check(journal.history_budget() == saved,
          "Record overflow rolls back byte and record consumption");
  }
  {
    Store journal(temp.path, true, "", policy);
    check(journal.history_budget() == saved, "Record promises and consumption survive restart");
    journal.history_release("one");
    check(journal.history_budget()["global"]["records"] == 8,
          "Refunding leftover bytes cannot refund already consumed records");
  }
}
void accounting() {
  Temp temp;
  Json saved;
  {
    Store journal(temp.path);
    journal.save({{"id", "session"}, {"state", "closed"}, {"running", false}});
    journal.event("session", "item/agentMessage/delta",
                  {{"itemId", "one"}, {"delta", std::string(20000, 'x')}});
    const auto first = journal.history_budget();
    journal.event("session", "item/agentMessage/delta", {{"itemId", "one"}, {"delta", "tail"}});
    check(journal.history_budget()["global"]["bytes"] > first["global"]["bytes"],
          "Append charges raw event, chunk and projection metadata");
    Json item = {{"id", "external"}, {"type", "agentMessage"}, {"text", std::string(65536, 'y')}};
    journal.external_item("session", "turn", item);
    const auto large = journal.history_budget();
    check(journal.external_item("session", "turn", item).is_null() &&
              journal.history_budget() == large,
          "Duplicate external history does not acquire capacity twice");
    item["text"] = "replacement";
    journal.external_item("session", "turn", item);
    check(journal.history_budget()["global"]["bytes"] < large["global"]["bytes"],
          "Replacement refunds old chunks while retaining original events");
    saved = journal.history_budget();
    const auto snapshot = journal.history("session");
    journal.cache_clear();
    journal.cleanup();
    check(journal.history("session") == snapshot &&
              journal.history_budget().at("global").at("bytes") < saved.at("global").at("bytes"),
          "Maintenance refunds raw journal copies while retaining authoritative history");
    saved = journal.history_budget();
  }
  {
    Store restored(temp.path);
    check(restored.history_budget() == saved,
          "Restart recovers the exact persisted history ledger");
  }
  {
    Database fixture(temp.path);
    fixture.legacy_schema();
  }
  {
    Store imported(temp.path);
    check(imported.history_budget() == saved, "Bootstrap accounts existing events and chunks once");
    Database fixture(temp.path);
    // Simulate explicit offline removal, in an order that loses source lookup
    // information. Refunds must use the original accounting entry's scope.
    fixture.sql("BEGIN");
    for (const auto &table : {"events", "history", "chunks", "bodies", "external_items", "streams"})
      fixture.sql(std::string("DELETE FROM ") + table);
    fixture.sql("COMMIT");
    const auto empty = imported.history_budget();
    check(empty["global"]["bytes"] == 0 && empty["global"]["records"] == 0 &&
              empty["sessions"].empty(),
          "Removal refunds all body, index and scope records without orphan accounting");
  }
}
void capacity() {
  Temp temp;
  Store journal(temp.path);
  bool stopped = false;
  journal.on_failure([&] { stopped = true; });
  const std::string text(1024 * 1024, 'x');
  size_t first_count = 0, last_count = 0;
  for (size_t scope = 0; scope < 5; ++scope) {
    const auto session = "scope-" + std::to_string(scope);
    journal.save({{"id", session}, {"state", "closed"}, {"running", false}});
    size_t count = 0;
    for (; count < 40; ++count) {
      const auto before = journal.history_budget();
      const auto revision = journal.history(session).at("snapshotSeq");
      try {
        stopped = false;
        journal.event(session, "record", {{"text", text}});
      } catch (const Error &error) {
        check(error.code == "BACKPRESSURE", error.what());
        check(stopped, "History exhaustion invokes the Agent's stop-side-effects callback");
        check(journal.history_budget() == before &&
                  journal.history(session).at("snapshotSeq") == revision,
              "Rejected event rolls back body, ledger, projection and published revision");
        break;
      }
    }
    check(count > 0 && count < 40, "Finite real byte quota stops history growth");
    if (!scope)
      first_count = count;
    last_count = count;
  }
  const auto full = journal.history_budget();
  check(last_count < first_count && full["global"]["bytes"] <= credit::history_budget,
        "Additional sessions cannot multiply the global history budget");
  for (const auto &scope : full["sessions"])
    check(scope["bytes"] <= credit::history_session, "Session history stays within its quota");
  // Terminal/control records have separately reserved capacity even when
  // historical output cannot grow. No old output is deleted to make room.
  journal.delivery_open("emergency", "scope-0", 4, 512 * 1024, "priority");
  journal.delivery_receive("emergency", 1, 2, "{}");
  journal.delivery_finish("emergency", 1, {{"error", "BACKPRESSURE"}});
  check(journal.delivery_results("emergency", 0).size() == 1,
        "History exhaustion does not consume reserved terminal result capacity");
  check(journal.history_budget() == full, "Control result does not change authoritative history");
}
void namespaces() {
  Temp temp;
  Store journal(temp.path);
  for (int i = 0; i < credit::history_scopes; ++i)
    journal.event("scope-" + std::to_string(i), "record", "small");
  const auto full = journal.history_budget();
  journal.save({{"id", "overflow"}, {"state", "closed"}, {"running", false}});
  backpressure([&] { journal.archive_event("overflow", "record", "must not survive"); });
  check(journal.history_budget() == full && journal.history("overflow")["events"].empty(),
        "Scope exhaustion atomically refuses standalone archive writes");
  journal.event("scope-0", "record", "existing scope remains usable");
}
void oversized_legacy() {
  Temp temp;
  {
    Store journal(temp.path);
    journal.save({{"id", "legacy"}, {"state", "closed"}, {"running", false}});
  }
  {
    Database fixture(temp.path);
    fixture.legacy_schema();
    const auto value =
        Json{{"type", "record"}, {"data", std::string(12 * 1024 * 1024, 'x')}, {"time", 1}}.dump();
    for (int seq = 1; seq <= 3; ++seq) {
      const auto prefix = std::to_string(seq) + ",'legacy','" + value + "',";
      fixture.sql("INSERT INTO events VALUES(" + prefix + "1)");
      fixture.sql("INSERT INTO history(seq,session,value,revision) VALUES(" + prefix +
                  std::to_string(seq) + ")");
    }
  }
  Store journal(temp.path);
  const auto imported = journal.history_budget();
  check(imported["sessions"][0]["bytes"] > credit::history_session &&
            !journal.history("legacy")["events"].empty(),
        "Existing oversized authority remains available after accounting bootstrap");
  backpressure([&] { journal.event("legacy", "record", "no new capacity"); });
  check(journal.history_budget() == imported, "Import never silently deletes or forgives history");
}
} // namespace
int main() {
  try {
    legacy_packing();
    legacy_inline_dedup();
    projected_history_heads();
    journal_cleanup();
    atomic_turn_admission();
    scoped_queue_reservations();
    inline_transition();
    external_inline_transition();
    packed_deltas();
    configurable_policy();
    durable_reservations();
    reservation_conversion();
    record_reservations();
    accounting();
    capacity();
    namespaces();
    oversized_legacy();
    std::cout << "PASS: authoritative history accounting, real global/session quotas, atomic "
                 "rollback, control capacity, namespace bounds, replacement/refunds and legacy "
                 "bootstrap\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "FAIL: " << error.what() << '\n';
    return 1;
  }
}
