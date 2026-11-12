#include "coc/credit.hpp"
#include "coc/delivery.hpp"
#include "coc/store.hpp"

namespace coc {
void Store::retention_init() {
  run("CREATE TABLE IF NOT EXISTS transport2_retention(id INTEGER PRIMARY KEY CHECK(id=1),"
      "operation_instance TEXT NOT NULL,"
      "secret TEXT NOT NULL)");
  run("INSERT OR IGNORE INTO transport2_retention(id,operation_instance,secret) VALUES(1,?,?)",
      {delivery_instance_ + "_" + uuid(), uuid() + uuid()});
  for (const auto *table :
       {"history", "transport2_operations", "transport2_uploads", "transport2_credit",
        "transport2_output_heads", "transport2_history_subscriptions", "transport2_history_entries",
        "transport2_control"}) {
    run(std::string("CREATE INDEX IF NOT EXISTS retention_age_") + table + " ON " + table +
        "(retained_at)");
    run(std::string("CREATE TRIGGER IF NOT EXISTS retention_age_") + table + " AFTER INSERT ON " +
        table + " WHEN NEW.retained_at=0 BEGIN UPDATE " + table +
        " SET retained_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) "
        "WHERE rowid=NEW.rowid; END");
  }
}

std::string Store::operation_instance() {
  return query("SELECT operation_instance FROM transport2_retention WHERE id=1")
      .at(0)
      .at("operation_instance")
      .get<std::string>();
}

Json Store::retention_cleanup(int64_t time) {
  if (!authoritative_ || cleaning_)
    return {{"removed", 0}};
  if (time < 0) {
    time = now();
    if (time < next_retention_cleanup_)
      return {{"removed", 0}};
    next_retention_cleanup_ = time + 1000;
  }
  cleaning_ = true;
  struct Reset {
    bool &flag;
    ~Reset() { flag = false; }
  } reset{cleaning_};
  const auto cutoff = time - history_policy_.at("retentionSeconds").get<int64_t>() * 1000;
  const auto threshold = history_policy_.at("cleanupThresholdPercent").get<int64_t>();
  const auto target = history_policy_.at("cleanupTargetPercent").get<int64_t>();
  const auto above = [](int64_t used, int64_t limit, int64_t percent) {
    // Division avoids multiplication overflow for supported JSON safe integers.
    return used > 0 &&
           used >= std::max(int64_t(1), (limit / 100) * percent + (limit % 100) * percent / 100);
  };
  const auto storage_pressure = [&](int64_t percent) {
    const auto pages = query("PRAGMA page_count").at(0).at("page_count").get<int64_t>();
    const auto free = query("PRAGMA freelist_count").at(0).at("freelist_count").get<int64_t>();
    const auto size = query("PRAGMA page_size").at(0).at("page_size").get<int64_t>();
    return above((pages - free) * size, history_policy_.at("storageMaxBytes"), percent);
  };
  const bool storage_full = storage_pressure(threshold);
  const auto history_pressure = [&](int64_t percent) {
    return !query(
                "SELECT 1 FROM transport2_history_budget WHERE (bytes>0 AND bytes>=CASE WHEN scope="
                "'@global' THEN ? ELSE ? END OR records>=CASE WHEN scope='@global' THEN ? "
                "ELSE ? END) LIMIT 1",
                {std::max(int64_t(1),
                          history_policy_.at("maxBytes").get<int64_t>() / 100 * percent),
                 std::max(int64_t(1),
                          history_policy_.at("maxSessionBytes").get<int64_t>() / 100 * percent),
                 std::max(int64_t(1),
                          history_policy_.at("maxRecords").get<int64_t>() * percent / 100),
                 std::max(int64_t(1),
                          history_policy_.at("maxSessionRecords").get<int64_t>() * percent / 100)})
                .empty() ||
           above(history_budget().at("sessions").size(), history_policy_.at("maxSessions"),
                 percent);
  };
  int64_t removed = 0;
  bool fenced = false;
  run("SAVEPOINT retention_cleanup");
  try {
    // A generation fence replaces per-request tombstones. Every surviving
    // operation retains its original instance; an absent old request can never
    // become a new dispatch after its body/identity has been reclaimed.
    const auto fence = [&] {
      if (!fenced) {
        run("UPDATE transport2_retention SET operation_instance=? WHERE id=1",
            {delivery_instance_ + "_" + uuid()});
        fenced = true;
      }
    };
    const bool history_full = history_pressure(threshold) || storage_full;
    const auto global = history_budget().at("global");
    const bool global_history_full =
        above(global.at("bytes"), history_policy_.at("maxBytes"), threshold) ||
        above(global.at("records"), history_policy_.at("maxRecords"), threshold) ||
        above(history_budget().at("sessions").size(), history_policy_.at("maxSessions"), threshold);
    for (const auto &row :
         query("SELECT h.seq,h.session,h.revision,h.retained_at FROM history h "
               "LEFT JOIN sessions s ON s.id=h.session WHERE "
               "COALESCE(json_extract(s.value,'$.running'),0)=0 AND h.seq!=? AND "
               "(h.retained_at<=? OR ? OR h.session IN (SELECT scope FROM "
               "transport2_history_budget WHERE scope!='@global' AND "
               "(bytes>=? OR records>=?))) ORDER BY "
               "CASE WHEN h.retained_at<=? THEN 0 WHEN h.recovery IS NOT NULL "
               "THEN 1 WHEN NOT EXISTS(SELECT 1 FROM "
               "transport2_history_subscriptions r WHERE r.session=h.session "
               "AND r.received<h.revision) THEN 2 ELSE 3 END,"
               "h.retained_at,h.seq LIMIT 128",
               {protected_history_seq_, cutoff, global_history_full || storage_full ? 1 : 0,
                std::max(int64_t(1),
                         history_policy_.at("maxSessionBytes").get<int64_t>() / 100 * threshold),
                std::max(int64_t(1),
                         history_policy_.at("maxSessionRecords").get<int64_t>() * threshold / 100),
                cutoff})) {
      if (row.at("retained_at") > cutoff && !history_pressure(target) && !storage_pressure(target))
        break;
      if (row.at("retained_at") > cutoff && !storage_pressure(target)) {
        const auto global_now = history_budget().at("global");
        const auto local =
            query("SELECT bytes,records FROM transport2_history_budget WHERE scope=?",
                  {row.at("session")})
                .at(0);
        if (!above(global_now.at("bytes"), history_policy_.at("maxBytes"), target) &&
            !above(global_now.at("records"), history_policy_.at("maxRecords"), target) &&
            !above(local.at("bytes"), history_policy_.at("maxSessionBytes"), target) &&
            !above(local.at("records"), history_policy_.at("maxSessionRecords"), target) &&
            !above(history_budget().at("sessions").size(), history_policy_.at("maxSessions"),
                   target))
          continue;
      }
      const auto seq = row.at("seq");
      for (const auto *table : {"chunks", "bodies", "streams", "external_items"})
        run(std::string("DELETE FROM ") + table + " WHERE seq=?", {seq});
      run("DELETE FROM events WHERE seq=? AND session=?", {seq, row.at("session")});
      run("DELETE FROM history WHERE seq=? AND session=?", {seq, row.at("session")});
      run("UPDATE transport2_history_heads SET retired_revision=MAX(retired_revision,?),"
          "generation=generation+1 WHERE session=?",
          {row.at("revision"), row.at("session")});
      ++removed;
    }
    const auto operation_usage = [&] {
      return query("SELECT COUNT(*) AS records,COALESCE(SUM(reserved),0) AS bytes "
                   "FROM transport2_operations")
          .at(0);
    };
    const auto operation_pressure = [&](int64_t percent) {
      const auto usage = operation_usage();
      return above(usage.at("records"), credit::operation_records, percent) ||
             above(usage.at("bytes"), credit::operation_budget, percent) ||
             !query("SELECT 1 FROM transport2_operations GROUP BY owner HAVING SUM(reserved)>=? "
                    "LIMIT 1",
                    {credit::operation_owner * percent / 100})
                  .empty();
    };
    const bool operations_full = operation_pressure(threshold) || storage_full;
    for (const auto &row : query("SELECT key,instance,retained_at FROM transport2_operations "
                                 "WHERE key NOT IN(SELECT key FROM transport2_thread_jobs) AND "
                                 "(retained_at<=? OR (phase!='started' AND ?)) "
                                 "ORDER BY retained_at,key LIMIT 128",
                                 {cutoff, operations_full ? 1 : 0})) {
      if (row.at("retained_at") > cutoff && !operation_pressure(target) &&
          !storage_pressure(target))
        break;
      fence();
      const auto owner = "operation:" + row.at("key").get<std::string>();
      // Release only this operation's promises. A live turn's independent
      // output and terminal reserve is never taken away by this cleanup.
      run("DELETE FROM transport2_history_entries WHERE key GLOB 'reservation:*' AND "
          "json_valid(substr(key,13)) AND json_extract(substr(key,13),'$[1]')=?",
          {owner});
      run("DELETE FROM transport2_operations WHERE key=?", {row.at("key")});
      ++removed;
    }

    const auto flow_pressure = [&](int64_t percent) {
      const auto count = query("SELECT COUNT(*) AS n FROM transport2_credit").at(0).at("n");
      return above(count, credit::flow_limit, percent) ||
             !query(
                  "SELECT 1 FROM transport2_credit GROUP BY lane HAVING SUM(reserved)>=CASE "
                  "WHEN lane='normal' THEN ? ELSE ? END LIMIT 1",
                  {credit::normal_budget * percent / 100, credit::priority_budget * percent / 100})
                  .empty() ||
             !query("SELECT 1 FROM transport2_credit GROUP BY session,lane HAVING SUM(reserved)"
                    ">=CASE WHEN lane='normal' THEN ? ELSE ? END LIMIT 1",
                    {credit::normal_session * percent / 100,
                     credit::priority_session * percent / 100})
                  .empty();
    };
    const bool flows_full = flow_pressure(threshold) || storage_full;
    for (const auto &row : query(
             "SELECT c.stream,c.session,c.retained_at,c.closed FROM transport2_credit c "
             "LEFT JOIN sessions s ON s.id=c.session WHERE "
             "COALESCE(json_extract(s.value,'$.running'),0)=0 AND "
             "(c.retained_at<=? OR (? AND NOT EXISTS(SELECT 1 FROM transport2_commands q WHERE "
             "q.stream=c.stream AND q.phase='started'))) ORDER BY c.retained_at,c.stream LIMIT 128",
             {cutoff, flows_full ? 1 : 0})) {
      if (row.at("retained_at") > cutoff && !flow_pressure(target) && !storage_pressure(target))
        break;
      const auto stream = row.at("stream").get<std::string>();
      // A ready session can still have an active command connection between turns.
      // Give validated traffic a bounded grace period under capacity pressure.
      const auto activity = delivery_activity_.find(stream);
      if (row.at("closed") == 0 && row.at("retained_at") > cutoff &&
          activity != delivery_activity_.end() && time - activity->second < 60000)
        continue;
      for (const auto &command :
           query("SELECT seq FROM transport2_commands WHERE stream=?", {stream}))
        history_release(row.at("session"),
                        "command:" +
                            delivery_digest(Json::array({stream, command.at("seq")}).dump()));
      // Namespace allocation is monotonic and survives. Reopening an old stream
      // receives a fresh generation, so delayed allocation proofs are rejected.
      for (const auto *table :
           {"transport2_commands", "transport2_command_keys", "transport2_command_digests",
            "transport2_results", "transport2_result_content", "transport2_cancel",
            "transport2_result_heads", "transport2_streams", "transport2_flow_control",
            "transport2_flow_owner", "transport2_credit"})
        run(std::string("DELETE FROM ") + table + " WHERE stream=?", {stream});
      delivery_activity_.erase(stream);
      ++removed;
    }

    const auto uploads_pressure = [&](int64_t percent) {
      const auto usage = query("SELECT COUNT(*) AS n,COALESCE(SUM(reserved),0) AS bytes "
                               "FROM transport2_uploads")
                             .at(0);
      return above(usage.at("n"), credit::upload_records, percent) ||
             above(usage.at("bytes"), credit::upload_budget, percent) ||
             !query("SELECT 1 FROM transport2_uploads GROUP BY owner HAVING COUNT(*)>=? "
                    "LIMIT 1",
                    {credit::upload_owner_records * percent / 100})
                  .empty();
    };
    const bool uploads_full = uploads_pressure(threshold) || storage_full;
    for (const auto &row : query("SELECT key,retained_at FROM transport2_uploads WHERE "
                                 "(active=0 OR phase IN('unknown','retired')) "
                                 "AND (retained_at<=? OR ?) ORDER BY retained_at,key LIMIT 128",
                                 {cutoff, uploads_full ? 1 : 0})) {
      if (row.at("retained_at") > cutoff && !uploads_pressure(target) && !storage_pressure(target))
        break;
      // begin is protected by the original operation fence; chunk/finish cannot
      // create a missing upload. Disk staging cleanup remains WorkspaceFiles' job.
      fence();
      run("DELETE FROM transport2_uploads WHERE key=?", {row.at("key")});
      ++removed;
    }

    const auto outputs_pressure = [&](int64_t percent) {
      const auto usage = query("SELECT COALESCE(SUM(bytes),0) AS bytes,COALESCE(SUM(records),0) "
                               "AS records FROM transport2_output_budget")
                             .at(0);
      return above(usage.at("bytes"), credit::output_budget, percent) ||
             above(usage.at("records"), credit::output_records, percent) ||
             !query("SELECT 1 FROM transport2_output_budget WHERE bytes>=? OR records>=? LIMIT 1",
                    {credit::output_session * percent / 100,
                     credit::output_session_records * percent / 100})
                  .empty();
    };
    const bool outputs_full = outputs_pressure(threshold) || storage_full;
    for (const auto &row :
         query("SELECT h.stream,h.sent,h.retained_at FROM transport2_output_heads h "
               "LEFT JOIN sessions s ON s.id=substr(h.stream,12) WHERE "
               "COALESCE(json_extract(s.value,'$.running'),0)=0 AND "
               "EXISTS(SELECT 1 FROM transport2_outputs o WHERE o.stream=h.stream) "
               "AND (h.retained_at<=? OR ?) ORDER BY h.retained_at,h.stream LIMIT 128",
               {cutoff, outputs_full ? 1 : 0})) {
      if (row.at("retained_at") > cutoff && !outputs_pressure(target) && !storage_pressure(target))
        break;
      run("DELETE FROM transport2_outputs WHERE stream=?", {row.at("stream")});
      run("UPDATE transport2_output_budget SET bytes=0,records=0 WHERE stream=?",
          {row.at("stream")});
      run("UPDATE transport2_output_heads SET retired=sent,retained_at=? WHERE stream=?",
          {time, row.at("stream")});
      ++removed;
    }
    // Orphaned reservations must not pin the history domain forever. Active
    // execution keeps its own output/terminal promises until it finishes.
    for (const auto &row :
         query("SELECT e.key,e.session,e.retained_at FROM transport2_history_entries e LEFT JOIN "
               "sessions s ON s.id=e.session WHERE (e.key GLOB 'reservation:*' "
               "OR (e.key GLOB 'control-reservation:*' AND "
               "json_extract(s.value,'$.state')='closed')) "
               "AND (e.retained_at<=? OR ?) "
               "AND COALESCE(json_extract(s.value,'$.running'),0)=0 "
               "ORDER BY e.retained_at,e.key LIMIT 128",
               {cutoff, history_full ? 1 : 0})) {
      if (row.at("retained_at") > cutoff && !history_pressure(target) && !storage_pressure(target))
        break;
      const auto key = row.at("key").get<std::string>();
      const auto identity = Json::parse(key.substr(12), nullptr, false);
      if (identity.is_array() && identity.size() == 2 && identity.at(1).is_string()) {
        const auto owner = identity.at(1).get<std::string>();
        if (owner.rfind("operation:", 0) == 0) {
          const auto op =
              query("SELECT phase FROM transport2_operations WHERE key=?", {owner.substr(10)});
          if (row.at("retained_at") > cutoff && !op.empty() && op.at(0).at("phase") == "started")
            continue;
          fence();
          run("DELETE FROM transport2_operations WHERE key=?", {owner.substr(10)});
        }
      }
      run("DELETE FROM transport2_history_entries WHERE key=?", {row.at("key")});
      ++removed;
    }
    for (const auto &row :
         query("SELECT e.seq FROM events e JOIN transport2_history_entries b ON "
               "b.key='events:'||json_array(e.seq) LEFT JOIN sessions s ON s.id=e.session WHERE "
               "COALESCE(json_extract(s.value,'$.running'),0)=0 AND (b.retained_at<=? OR ?) AND "
               "NOT EXISTS(SELECT 1 FROM history h WHERE h.seq=e.seq) AND "
               "NOT EXISTS(SELECT 1 FROM bodies x WHERE x.seq=e.seq) AND "
               "NOT EXISTS(SELECT 1 FROM chunks x WHERE x.seq=e.seq) AND "
               "NOT EXISTS(SELECT 1 FROM streams x WHERE x.seq=e.seq) AND "
               "NOT EXISTS(SELECT 1 FROM external_items x WHERE x.seq=e.seq) "
               "ORDER BY b.retained_at,e.seq LIMIT 128",
               {cutoff, history_full ? 1 : 0})) {
      run("DELETE FROM events WHERE seq=?", {row.at("seq")});
      ++removed;
    }
    const auto subscriptions = query("SELECT COUNT(*) AS n FROM transport2_history_subscriptions")
                                   .at(0)
                                   .at("n")
                                   .get<int64_t>();
    run("DELETE FROM transport2_history_subscriptions WHERE key IN (SELECT key FROM "
        "transport2_history_subscriptions WHERE retained_at<=? OR ? ORDER BY retained_at,key "
        "LIMIT 128)",
        {cutoff, above(subscriptions, credit::flow_limit, threshold) || storage_full ? 1 : 0});
    removed += sqlite3_changes(db_);
    const auto control_count = query("SELECT COUNT(*) AS n FROM transport2_control").at(0).at("n");
    for (const auto &row :
         query("SELECT c.session,c.epoch,c.control_id,c.owner FROM transport2_control c "
               "JOIN sessions s ON s.id=c.session WHERE "
               "COALESCE(json_extract(s.value,'$.running'),0)=0 AND "
               "NOT EXISTS(SELECT 1 FROM transport2_credit f WHERE f.session=c.session) AND "
               "(c.retained_at<=? OR ?) ORDER BY c.retained_at,c.session LIMIT 128",
               {cutoff,
                above(control_count, credit::flow_limit, threshold) || storage_full ? 1 : 0})) {
      run("UPDATE sessions SET value=json_set(value,'$.controlCoverage',json(?)) WHERE id=?",
          {Json{{"controlEpoch", row.at("epoch")},
                {"controlId", row.at("control_id")},
                {"owner", row.at("owner")},
                {"instance", delivery_instance_}}
               .dump(),
           row.at("session")});
      run("DELETE FROM transport2_control WHERE session=?", {row.at("session")});
      ++removed;
    }
    const auto output_count =
        query("SELECT COUNT(*) AS n FROM transport2_output_heads").at(0).at("n");
    for (const auto &row :
         query("SELECT h.stream,substr(h.stream,12) AS session,h.sent,h.sent_bytes,h.published,"
               "h.acked,h.acked_bytes,h.retired FROM transport2_output_heads h JOIN sessions s "
               "ON s.id=substr(h.stream,12) WHERE h.stream GLOB 'rpc-output:*' AND "
               "COALESCE(json_extract(s.value,'$.running'),0)=0 AND NOT EXISTS "
               "(SELECT 1 FROM transport2_outputs o WHERE o.stream=h.stream) AND "
               "(h.retained_at<=? OR ?) ORDER BY h.retained_at,h.stream LIMIT 128",
               {cutoff,
                above(output_count, credit::flow_limit, threshold) || storage_full ? 1 : 0})) {
      auto compact = row;
      compact.erase("stream");
      compact.erase("session");
      run("UPDATE sessions SET value=json_set(value,'$.outputCoverage',json(?)) WHERE id=?",
          {compact.dump(), row.at("session")});
      run("DELETE FROM transport2_output_budget WHERE stream=?", {row.at("stream")});
      run("DELETE FROM transport2_output_heads WHERE stream=?", {row.at("stream")});
      ++removed;
    }
    // Empty history scopes must refund their metadata as well. Keep just the
    // monotonic coverage counters in the existing session catalogue, so old
    // checkpoints still report a gap and a later import cannot reuse revisions.
    for (const auto &row :
         query("SELECT h.session,h.revision,h.retired_revision,h.generation FROM "
               "transport2_history_heads h JOIN sessions s ON s.id=h.session WHERE "
               "COALESCE(json_extract(s.value,'$.running'),0)=0 AND NOT EXISTS "
               "(SELECT 1 FROM history WHERE session=h.session) AND NOT EXISTS "
               "(SELECT 1 FROM transport2_history_entries e WHERE e.session=h.session "
               "AND e.key NOT GLOB 'transport2_history_heads:*' AND e.key NOT GLOB "
               "'sessions-source:*') "
               "AND (? OR EXISTS(SELECT 1 FROM transport2_history_entries e WHERE "
               "e.session=h.session AND e.retained_at<=?)) ORDER BY h.session LIMIT 128",
               {history_full ? 1 : 0, cutoff})) {
      const Json coverage = {{"revision", row.at("revision")},
                             {"retired_revision", row.at("retired_revision")},
                             {"generation", row.at("generation")}};
      run("UPDATE sessions SET source=NULL,value=json_set(value,'$.historyCoverage',json(?)) "
          "WHERE id=?",
          {coverage.dump(), row.at("session")});
      run("DELETE FROM transport2_history_heads WHERE session=?", {row.at("session")});
      ++removed;
    }
    run("RELEASE retention_cleanup");
    return {{"removed", removed},
            {"historyPressure", history_full},
            {"storagePressure", storage_full},
            {"operationPressure", operations_full},
            {"flowPressure", flows_full}};
  } catch (...) {
    run("ROLLBACK TO retention_cleanup");
    run("RELEASE retention_cleanup");
    throw;
  }
}
} // namespace coc
