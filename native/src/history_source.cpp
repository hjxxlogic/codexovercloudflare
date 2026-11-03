#include "coc/delivery.hpp"
#include "coc/history_projection.hpp"
#include "coc/store.hpp"
#include <openssl/crypto.h>
#include <openssl/hmac.h>
#include <vector>
namespace coc {
namespace {
std::string recovery_mac(const std::string &secret, const std::string &payload) {
  unsigned char bytes[EVP_MAX_MD_SIZE];
  unsigned length = 0;
  if (!HMAC(EVP_sha256(), secret.data(), static_cast<int>(secret.size()),
            reinterpret_cast<const unsigned char *>(payload.data()), payload.size(), bytes,
            &length) ||
      length != 32)
    throw Error("STORAGE_ERROR", "Cannot authenticate history recovery credential");
  static const char hex[] = "0123456789abcdef";
  std::string result;
  for (unsigned i = 0; i < length; ++i) {
    result += hex[bytes[i] >> 4];
    result += hex[bytes[i] & 15];
  }
  return result;
}
size_t source_offset(const std::string &body, const std::string &source) {
  if (body.size() > source.size())
    return std::string::npos;
  if (source.compare(0, body.size(), body) == 0)
    return 0;
  if (body.size() == source.size())
    return std::string::npos;
  // Linear-time search avoids quadratic scans of repetitive command output.
  // Registration bounds the body to 1 MiB, so this scratch table is at most 4 MiB.
  std::vector<uint32_t> prefix(body.size());
  for (size_t i = 1, matched = 0; i < body.size(); ++i) {
    while (matched && body[i] != body[matched])
      matched = prefix[matched - 1];
    if (body[i] == body[matched])
      ++matched;
    prefix[i] = static_cast<uint32_t>(matched);
  }
  for (size_t i = 0, matched = 0; i < source.size(); ++i) {
    while (matched && source[i] != body[matched])
      matched = prefix[matched - 1];
    if (source[i] == body[matched])
      ++matched;
    if (matched == body.size())
      return i + 1 - matched;
  }
  return std::string::npos;
}
void validate_origin(const Json &origin) {
  if (!origin.is_object() || origin.size() != 2 || !origin.contains("environment") ||
      !origin.at("environment").is_string() || !origin.contains("projectPath") ||
      !origin.at("projectPath").is_string())
    throw Error("INVALID_REQUEST", "Invalid history source origin");
  const auto environment = origin.at("environment").get<std::string>();
  const auto path = origin.at("projectPath").get<std::string>();
  if (environment.size() != 64 ||
      environment.find_first_not_of("0123456789abcdef") != std::string::npos || path.empty() ||
      path.size() > 4096 || path.find('\0') != std::string::npos)
    throw Error("INVALID_REQUEST", "Invalid history source origin");
  std::error_code error;
  const auto canonical = std::filesystem::canonical(std::filesystem::u8path(path), error);
  if (error || canonical.u8string() != path || !std::filesystem::is_directory(canonical, error))
    throw Error("CONTENT_UNAVAILABLE", "History source project is unavailable or not canonical");
}
void validate_entry(const Json &entry, const std::string &turn, const std::string &item) {
  if (!entry.is_object() || !entry.contains("turnId") || entry.at("turnId") != turn ||
      !entry.contains("item") || !entry.at("item").is_object() ||
      !entry.at("item").contains("id") || entry.at("item").at("id") != item)
    throw Error("CONTENT_UNAVAILABLE", "History source entry identity mismatch");
  if (entry.dump().size() > 1024 * 1024)
    throw Error("BACKPRESSURE", "History source entry exceeds verification budget");
}
Json event_template(Json event, const std::string &projection) {
  auto &data = event.at("data");
  const auto item = data.value("item", Json::object());
  const auto type = event.at("type");
  if (projection == "external-v1" || type == "item/agentMessage/delta" ||
      type == "item/commandExecution/outputDelta") {
    Json identity = {{"turnId", data.at("turnId")},
                     {"itemId", data.value("itemId", item.value("id", ""))}};
    if (item.is_object() && item.contains("type"))
      identity["item"] = {{"id", identity.at("itemId")}, {"type", item.at("type")}};
    data = std::move(identity);
  } else {
    // Retain envelope metadata, not arbitrary additional payloads. Unknown data
    // shapes remain pinned until a projection can reconstruct them explicitly.
    for (auto it = data.begin(); it != data.end(); ++it)
      if (it.key() != "item" && it.key() != "turnId" && it.key() != "threadId" &&
          it.key() != "itemId" && it.key() != "activeTask" && it.key() != "startedAtMs" &&
          it.key() != "completedAtMs")
        throw Error("CONTENT_UNAVAILABLE", "History envelope has unclassified payload fields");
    Json shape = {{"id", item.at("id")}, {"type", item.at("type")}};
    // Only presence matters to reconstruction, never retain body copies here.
    for (const auto *key : {"startedAtMs", "completedAtMs"})
      if (item.contains(key))
        shape[key] = nullptr;
    if (item.contains("aggregatedOutput") && item.at("aggregatedOutput").is_string())
      shape["aggregatedOutput"] = "";
    data["item"] = std::move(shape);
  }
  event.erase("seq");
  event.erase("revision");
  return event;
}
} // namespace
Json Store::history_source_register(const std::string &session, int64_t seq, const Json &origin,
                                    const Json &entry, const Json &expected) {
  const auto previous = protected_history_seq_;
  protected_history_seq_ = seq;
  struct Restore {
    int64_t &target;
    int64_t previous;
    ~Restore() { target = previous; }
  } restore{protected_history_seq_, previous};
  validate_origin(origin);
  const bool outer = sqlite3_get_autocommit(db_) != 0;
  run(outer ? "BEGIN IMMEDIATE" : "SAVEPOINT history_source_registration");
  try {
    const auto state = get(session);
    if (state.value("running", false))
      throw Error("BACKPRESSURE", "Running history cannot acquire optional recovery metadata");
    const auto rows =
        query("SELECT value,revision FROM history WHERE session=? AND seq=?", {session, seq});
    if (rows.empty() || !state.contains("threadId") || !state.contains("projectId"))
      throw Error("CONTENT_UNAVAILABLE", "History source has no original session association");
    if (!expected.is_null() && (expected.at("session") != session || expected.at("seq") != seq ||
                                expected.at("revision") != rows.at(0).at("revision") ||
                                expected.at("threadId") != state.at("threadId") ||
                                expected.at("projectId") != state.at("projectId")))
      throw Error("CONTENT_UNAVAILABLE", "History changed while preparing recovery proof");
    const auto event = Json::parse(rows.at(0).at("value").get<std::string>());
    const auto &data = event.at("data");
    const auto turn = data.value("turnId", "");
    const auto item = data.value("itemId", data.value("item", Json::object()).value("id", ""));
    if (turn.empty() || item.empty() || turn.size() > 200 || item.size() > 200)
      throw Error("CONTENT_UNAVAILABLE", "History has no stable source item identity");
    if ((data.contains("threadId") && data.at("threadId") != state.at("threadId")) ||
        (data.contains("item") && data.at("item").is_object() && data.at("item").contains("id") &&
         data.at("item").at("id") != item))
      throw Error("CONTENT_UNAVAILABLE", "History source identity conflicts with original event");
    validate_entry(entry, turn, item);
    if (!entry.contains("completedAtMs") || !entry.at("completedAtMs").is_number_integer() ||
        entry.at("completedAtMs") < 0 || entry.at("completedAtMs") > 9007199254740991LL ||
        entry.at("item").value("status", "") == "inProgress")
      throw Error("CONTENT_UNAVAILABLE", "History source item is not durably completed");
    const auto existing_proof =
        query("SELECT recovery FROM history WHERE seq=?", {seq}).at(0).at("recovery");
    if (!existing_proof.is_null()) {
      // A partially evicted body can still be verified from its immutable proof.
      history_source_recover(session, seq, origin, entry);
      const auto saved = history_source(session, seq, origin);
      run(outer ? "COMMIT" : "RELEASE history_source_registration");
      return saved;
    }
    const auto size =
        query("SELECT COALESCE(b.bytes,length(CAST(COALESCE("
              "json_extract(h.value,'$.data.text'),json_extract(h.value,'$.data.delta'),"
              "json_extract(h.value,'$.data.item.aggregatedOutput'),h.value) AS BLOB))) AS bytes "
              "FROM history h LEFT JOIN bodies b ON b.seq=h.seq WHERE h.seq=?",
              {seq});
    if (size.at(0).at("bytes") > 1024 * 1024)
      throw Error("BACKPRESSURE", "History verification exceeds bounded read budget");
    const auto reference = history_reference(session, seq);
    if (reference.at("length") > 1024 * 1024)
      throw Error("BACKPRESSURE", "History verification exceeds bounded read budget");
    const std::string projection = state.value("external", false) ? "external-v1" : "event-v1";
    const auto candidate = recover_history_text(event, entry.at("item"), projection);
    std::string original;
    for (int64_t offset = 0;;) {
      const auto page = content(session, seq, offset, reference.at("revision"));
      original += page.at("text").get<std::string>();
      if (!page.at("more").get<bool>())
        break;
      offset = page.at("nextOffset");
    }
    const auto offset = source_offset(original, candidate);
    if (offset == std::string::npos)
      throw Error("CONTENT_UNAVAILABLE", "Original body is absent from source projection");
    auto minimal = event_template(event, projection);
    auto verify = minimal;
    verify["seq"] = seq;
    verify["revision"] = reference.at("revision");
    if (recover_history_content(verify, entry.at("item"), projection, reference, offset) !=
        original)
      throw Error("CONTENT_UNAVAILABLE", "Source reconstruction differs from original body");
    // Content identity already lives in session.threadId and event.data.
    // Persist only non-derivable recovery proof on the original history row.
    const Json value = {{"projection", projection},
                        {"offset", offset},
                        {"length", reference.at("length")},
                        {"digest", reference.at("digest")}};
    const auto encoded = value.dump();
    const auto binding = query("SELECT source FROM sessions WHERE id=?", {session});
    const auto prior =
        query("SELECT recovery FROM history WHERE seq=?", {seq}).at(0).at("recovery");
    const auto source = binding.at(0).at("source");
    if (!source.is_null() && Json::parse(source.get<std::string>()) != origin)
      throw Error("DELIVERY_STATE_MISMATCH", "History source cannot be rebound implicitly");
    if (source.is_null() || prior != encoded) {
      if (!query("SELECT key FROM transport2_history_entries WHERE session=? AND key GLOB "
                 "'reservation:*' LIMIT 1",
                 {session})
               .empty())
        throw Error("BACKPRESSURE", "History recovery cannot borrow task reservation");
      const auto key = "sessions-source:" + Json::array({session}).dump();
      const int64_t origin_cost = source.is_null() ? int64_t(origin.dump().size()) + 2048 +
                                                         6 * int64_t(key.size() + session.size())
                                                   : 0;
      const int64_t growth = int64_t(encoded.size()) -
                             (prior.is_null() ? 0 : int64_t(prior.get<std::string>().size()));
      history_require_capacity(session, origin_cost + std::max(int64_t(0), growth),
                               source.is_null() ? 1 : 0);
      if (source.is_null())
        run("UPDATE sessions SET source=? WHERE id=?", {origin.dump(), session});
      run("UPDATE history SET recovery=? WHERE session=? AND seq=?", {encoded, session, seq});
    }
    auto saved = history_source(session, seq, origin);
    run(outer ? "COMMIT" : "RELEASE history_source_registration");
    return saved;
  } catch (...) {
    if (outer)
      run("ROLLBACK");
    else {
      run("ROLLBACK TO history_source_registration");
      run("RELEASE history_source_registration");
    }
    throw;
  }
}
Json Store::history_source(const std::string &session, int64_t seq, const Json &origin) {
  validate_origin(origin);
  const auto state = get(session);
  const auto rows = query("SELECT h.value,h.revision,h.recovery,s.source FROM history h "
                          "JOIN sessions s ON s.id=h.session WHERE h.session=? AND h.seq=?",
                          {session, seq});
  if (rows.empty() || rows.at(0).at("recovery").is_null() || rows.at(0).at("source").is_null())
    throw Error("CONTENT_UNAVAILABLE", "Original history recovery proof is unavailable");
  if (Json::parse(rows.at(0).at("source").get<std::string>()) != origin)
    throw Error("DELIVERY_STATE_MISMATCH", "History source origin changed");
  auto value = Json::parse(rows.at(0).at("recovery").get<std::string>());
  const auto event = Json::parse(rows.at(0).at("value").get<std::string>());
  const auto &data = event.at("data");
  value["origin"] = origin;
  value["threadId"] = state.at("threadId");
  value["turnId"] = data.at("turnId");
  value["itemId"] = data.value("itemId", data.value("item", Json::object()).value("id", ""));
  value["event"] = event_template(event, value.at("projection"));
  value["event"]["seq"] = seq;
  value["event"]["revision"] = rows.at(0).at("revision");
  value["reference"] = history_reference_descriptor({{"type", "delivery-content"},
                                                     {"retention", "history"},
                                                     {"agentInstance", delivery_instance_},
                                                     {"sessionId", session},
                                                     {"seq", seq},
                                                     {"revision", rows.at(0).at("revision")},
                                                     {"length", value.at("length")},
                                                     {"digest", value.at("digest")},
                                                     {"contentId", value.at("digest")}});
  return value;
}
Json Store::history_source_candidate() {
  // Scan a bounded slice of primary-key order, including ineligible rows. The
  // cursor is only a scheduling hint: restarting or wrapping cannot lose proof.
  const auto rows =
      query("SELECT h.seq,h.revision,h.session,json_extract(s.value,'$.threadId') AS threadId,"
            "json_extract(s.value,'$.projectId') AS projectId,s.source AS origin,"
            "json_extract(h.value,'$.data.turnId') AS turnId,"
            "COALESCE(json_extract(h.value,'$.data.itemId'),json_extract(h.value,'$.data.item.id'))"
            " AS itemId,EXISTS(SELECT 1 FROM chunks WHERE seq=h.seq) AS cached_chunks,"
            "COALESCE(json_extract(s.value,'$.running'),0)=0 "
            "AND COALESCE((SELECT bytes FROM bodies WHERE seq=h.seq),length(CAST(h.value AS "
            "BLOB)))<=1048576 "
            "AND (json_extract(h.value,'$.type')!='item/started' OR "
            "json_extract(h.value,'$.data.item.type')='fileChange') AND NOT EXISTS(SELECT 1 "
            "FROM transport2_history_entries WHERE session=h.session AND key GLOB 'reservation:*') "
            "AS eligible "
            "FROM history h LEFT JOIN sessions s ON s.id=h.session WHERE h.seq>? ORDER BY h.seq "
            "LIMIT 128",
            {history_prepare_seq_});
  if (rows.empty()) {
    history_prepare_seq_ = std::numeric_limits<int64_t>::min();
    return nullptr;
  }
  for (auto row : rows) {
    history_prepare_seq_ = row.at("seq");
    if (row.at("eligible") != 1)
      continue;
    bool valid = true;
    for (const auto *key : {"threadId", "projectId", "turnId", "itemId"})
      valid = valid && row.at(key).is_string() && !row.at(key).get<std::string>().empty() &&
              row.at(key).get<std::string>().size() <= 200;
    if (!valid)
      continue;
    if (row.at("cached_chunks") == 0) {
      // Examine one bounded projection at a time. Do not launch a reader or
      // persist proof for an inline shape that cannot release any body bytes.
      const auto values = query("SELECT value FROM history WHERE seq=?", {row.at("seq")});
      if (values.empty() ||
          history_cache_descriptor(Json::parse(values.at(0).at("value").get<std::string>()),
                                   row.at("seq"))
              .is_null())
        continue;
    }
    row.erase("cached_chunks");
    row.erase("eligible");
    if (!row.at("origin").is_null())
      row["origin"] = Json::parse(row.at("origin").get<std::string>());
    return row;
  }
  return nullptr;
}
Json Store::history_client_reference(const std::string &session, int64_t seq,
                                     const std::string &owner) {
  if (owner.empty() || owner.size() > 128)
    throw Error("INVALID_REQUEST", "History recovery credential requires its authenticated owner");
  const auto state = get(session);
  auto plan = history_source_plan(session, seq);
  const auto project = state.at("projectId");
  run("CREATE TABLE IF NOT EXISTS transport2_recovery_projects(project TEXT PRIMARY KEY,"
      "generation TEXT NOT NULL)");
  run("INSERT OR IGNORE INTO transport2_recovery_projects VALUES(?,?)", {project, uuid()});
  const auto generation = query("SELECT generation FROM transport2_recovery_projects WHERE "
                                "project=?",
                                {project})
                              .at(0)
                              .at("generation");
  auto reference = plan.at("reference");
  const auto payload = Json{
      {"version", 1},
      {"owner", owner},
      {"project", project},
      {"generation", generation},
      {"plan", plan}}.dump();
  if (payload.size() > 16384)
    throw Error("BACKPRESSURE", "History recovery credential exceeds its metadata budget");
  const auto secret = query("SELECT secret FROM transport2_retention WHERE id=1")
                          .at(0)
                          .at("secret")
                          .get<std::string>();
  reference["recovery"] = {{"payload", payload}, {"mac", recovery_mac(secret, payload)}};
  return reference;
}
Json Store::history_source_plan(const std::string &session, int64_t seq, const Json &input,
                                const std::string &owner) {
  if (!input.is_null() && input.contains("recovery")) {
    const auto reference = history_reference_descriptor(input);
    const auto &credential = reference.at("recovery");
    const auto payload = credential.at("payload").get<std::string>();
    const auto mac = credential.at("mac").get<std::string>();
    const auto secret = query("SELECT secret FROM transport2_retention WHERE id=1")
                            .at(0)
                            .at("secret")
                            .get<std::string>();
    const auto expected = recovery_mac(secret, payload);
    if (mac.size() != expected.size() ||
        CRYPTO_memcmp(mac.data(), expected.data(), expected.size()) != 0)
      throw Error("FORBIDDEN", "History recovery credential authentication failed");
    const auto value = Json::parse(payload);
    const auto state = get(session);
    auto base = reference;
    base.erase("recovery");
    if (reference.at("agentInstance") != delivery_instance_ ||
        reference.at("sessionId") != session || reference.at("seq") != seq ||
        value.at("version") != 1 || value.at("owner") != owner ||
        value.at("project") != state.at("projectId") || value.at("plan").at("reference") != base ||
        value.at("plan").at("threadId") != state.at("threadId"))
      throw Error("FORBIDDEN", "History recovery credential scope does not match this read");
    const auto generations = query("SELECT generation FROM transport2_recovery_projects WHERE "
                                   "project=?",
                                   {value.at("project")});
    if (generations.empty() || generations.at(0).at("generation") != value.at("generation"))
      throw Error("CONTENT_EXPIRED", "Project history recovery credentials have expired");
    auto plan = value.at("plan");
    plan["reference"] = reference;
    return plan;
  }
  const auto rows = query("SELECT source FROM sessions WHERE id=?", {session});
  if (rows.empty() || rows.at(0).at("source").is_null())
    throw Error("CONTENT_UNAVAILABLE", "History has no verified recovery source");
  // This is only a read plan. The caller must validate this expected identity
  // against the actual Codex source before obtaining any source content.
  return history_source(session, seq, Json::parse(rows.at(0).at("source").get<std::string>()));
}
Json Store::history_recovered_content(const std::string &session, const Json &input,
                                      const Json &origin, const Json &entry, int64_t offset,
                                      const std::string &owner) {
  const auto reference = history_reference_descriptor(input);
  if (reference.at("sessionId") != session)
    throw Error("FORBIDDEN", "History reference belongs to another session");
  const auto plan = reference.contains("recovery")
                        ? history_source_plan(session, reference.at("seq"), reference, owner)
                        : history_source(session, reference.at("seq"), origin);
  if (reference != plan.at("reference"))
    throw Error("CONTENT_UNAVAILABLE", "Original history reference changed during recovery");
  if (plan.at("origin") != origin)
    throw Error("DELIVERY_STATE_MISMATCH", "History source origin changed");
  validate_entry(entry, plan.at("turnId"), plan.at("itemId"));
  const auto text =
      recover_history_content(plan.at("event"), entry.at("item"), plan.at("projection"), reference,
                              plan.at("offset").get<size_t>());
  const auto page =
      query("SELECT length(?) AS size,substr(?,?+1,4096) AS text", {text, text, offset});
  const auto size = page.at(0).at("size").get<int64_t>();
  if (offset < 0 || offset > size)
    throw Error("INVALID_REQUEST", "Invalid content offset");
  const auto next = std::min(size, offset + 4096);
  return {{"seq", reference.at("seq")}, {"revision", reference.at("revision")},
          {"offset", offset},           {"text", page.at(0).at("text")},
          {"nextOffset", next},         {"more", next < size}};
}
std::string Store::history_source_recover(const std::string &session, int64_t seq,
                                          const Json &origin, const Json &entry) {
  const auto source = history_source(session, seq, origin);
  validate_entry(entry, source.at("turnId"), source.at("itemId"));
  return recover_history_content(source.at("event"), entry.at("item"), source.at("projection"),
                                 source.at("reference"), source.at("offset").get<size_t>());
}
} // namespace coc
