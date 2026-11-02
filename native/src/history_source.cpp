#include "coc/delivery.hpp"
#include "coc/history_projection.hpp"
#include "coc/store.hpp"
#include <vector>
namespace coc {
namespace {
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
                                    const Json &entry) {
  validate_origin(origin);
  const bool outer = sqlite3_get_autocommit(db_) != 0;
  run(outer ? "BEGIN IMMEDIATE" : "SAVEPOINT history_source_registration");
  try {
    const auto state = get(session);
    const auto rows =
        query("SELECT value,revision FROM history WHERE session=? AND seq=?", {session, seq});
    if (rows.empty() || !state.contains("threadId") || !state.contains("projectId"))
      throw Error("CONTENT_UNAVAILABLE", "History source has no original session association");
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
    const Json value = {{"origin", origin},
                        {"projectId", state.at("projectId")},
                        {"threadId", state.at("threadId")},
                        {"turnId", turn},
                        {"itemId", item},
                        {"projection", projection},
                        {"event", minimal},
                        {"offset", offset},
                        {"length", reference.at("length")},
                        {"digest", reference.at("digest")}};
    const auto encoded = value.dump();
    if (encoded.size() > 16384)
      throw Error("BACKPRESSURE", "History source metadata exceeds bounded record size");
    const auto existing = query("SELECT value FROM transport2_history_sources WHERE seq=?", {seq});
    if (!existing.empty() &&
        Json::parse(existing.at(0).at("value").get<std::string>()).at("origin") != origin)
      throw Error("DELIVERY_STATE_MISMATCH", "History source cannot be rebound implicitly");
    if (existing.empty() || existing.at(0).at("value") != encoded) {
      if (!query("SELECT key FROM transport2_history_entries WHERE key=?",
                 {"reservation:" + session})
               .empty())
        throw Error("BACKPRESSURE", "History source registration cannot borrow task reservation");
      const auto key = "transport2_history_sources:" + Json::array({seq}).dump();
      const int64_t cost =
          int64_t(encoded.size()) + 2048 + 6 * int64_t(key.size() + session.size());
      const auto charged = query("SELECT bytes FROM transport2_history_entries WHERE key=?", {key});
      const auto previous = charged.empty() ? int64_t(0) : charged.at(0).at("bytes").get<int64_t>();
      history_require_capacity(session, std::max(int64_t(0), cost - previous),
                               existing.empty() ? 1 : 0);
      run("INSERT INTO transport2_history_sources VALUES(?,?,?,?) ON CONFLICT(seq) DO UPDATE SET "
          "session=excluded.session,revision=excluded.revision,value=excluded.value",
          {seq, session, reference.at("revision"), encoded});
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
  const auto rows =
      query("SELECT s.value,s.revision FROM transport2_history_sources s JOIN history h "
            "ON h.seq=s.seq AND h.session=s.session AND h.revision=s.revision "
            "WHERE s.session=? AND s.seq=?",
            {session, seq});
  if (rows.empty())
    throw Error("CONTENT_UNAVAILABLE", "Original history source association is unavailable");
  auto value = Json::parse(rows.at(0).at("value").get<std::string>());
  if (value.at("origin") != origin || value.at("projectId") != state.value("projectId", "") ||
      value.at("threadId") != state.value("threadId", ""))
    throw Error("DELIVERY_STATE_MISMATCH", "History source origin or session association changed");
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
std::string Store::history_source_recover(const std::string &session, int64_t seq,
                                          const Json &origin, const Json &entry) {
  const auto source = history_source(session, seq, origin);
  validate_entry(entry, source.at("turnId"), source.at("itemId"));
  return recover_history_content(source.at("event"), entry.at("item"), source.at("projection"),
                                 source.at("reference"), source.at("offset").get<size_t>());
}
} // namespace coc
