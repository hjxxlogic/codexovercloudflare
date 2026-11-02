#include "coc/history_projection.hpp"
#include "coc/delivery.hpp"
namespace coc {
HistoryItemProjection project_history_item(Json item, const std::string &turn, int version) {
  if (version != 1)
    throw Error("CONTENT_UNAVAILABLE", "Unsupported history projection version");
  item = redact(std::move(item));
  if (!item.is_object() || !item.contains("id") || !item.at("id").is_string() ||
      item.at("id").get<std::string>().empty() || item.at("id").get<std::string>().size() > 200 ||
      turn.size() > 200)
    throw Error("INVALID_FRAME", "Invalid external item identity");
  const auto id = item.at("id").get<std::string>();
  const auto kind = item.value("type", "");
  const auto serialized = item.dump();
  HistoryItemProjection result{item,
                               {{"turnId", turn}, {"itemId", id}, {"item", item}},
                               item.value("status", "") == "inProgress" ? "item/started"
                                                                        : "item/completed",
                               serialized,
                               delivery_digest(serialized)};
  if (kind == "agentMessage") {
    result.type = "item/agentMessage/delta";
    result.text = item.value("text", "");
    result.data = {{"turnId", turn}, {"itemId", id}, {"delta", result.text}};
  } else if (kind == "userMessage") {
    result.type = "user";
    result.text.clear();
    for (const auto &part : item.value("content", Json::array()))
      if (part.value("type", "") == "text")
        result.text += part.value("text", "");
    result.data = {{"turnId", turn}, {"itemId", id}, {"text", result.text}};
  }
  return result;
}
std::string recover_history_text(const Json &event, Json item, const std::string &projection) {
  if (projection != "external-v1" && projection != "event-v1")
    throw Error("CONTENT_UNAVAILABLE", "Unsupported history projection version");
  if (!event.is_object() || !event.contains("data") || !event.at("data").is_object() ||
      !item.is_object() || !item.contains("id") || !item.at("id").is_string())
    throw Error("INVALID_FRAME", "Invalid history reconstruction input");
  const auto &data = event.at("data");
  if ((data.contains("item") && !data.at("item").is_object() && !data.at("item").is_null()) ||
      (data.contains("itemId") && !data.at("itemId").is_string()) || !item.contains("type") ||
      !item.at("type").is_string())
    throw Error("INVALID_FRAME", "Invalid history reconstruction item shape");
  const auto original_item =
      data.contains("item") && data.at("item").is_object() ? data.at("item") : Json::object();
  const auto expected_id = data.value("itemId", original_item.value("id", ""));
  if (expected_id.empty() || item.at("id") != expected_id)
    throw Error("CONTENT_UNAVAILABLE", "History reconstruction item identity mismatch");
  item = redact(std::move(item));
  const auto kind = item.value("type", "");
  const auto type = event.value("type", "");
  if ((!original_item.value("type", "").empty() && original_item.at("type") != kind) ||
      (type == "item/agentMessage/delta" && kind != "agentMessage") ||
      (type == "item/commandExecution/outputDelta" && kind != "commandExecution") ||
      (type == "user" && kind != "userMessage"))
    throw Error("CONTENT_UNAVAILABLE", "History reconstruction item type mismatch");
  if (projection == "external-v1")
    return project_history_item(std::move(item), data.value("turnId", "")).text;
  const auto body_field = [&](const char *field) {
    if (!item.contains(field) || !item.at(field).is_string())
      throw Error("CONTENT_UNAVAILABLE", "Persisted item lacks original text field");
    return item.at(field).get<std::string>();
  };
  if (type == "item/agentMessage/delta")
    return body_field("text");
  if (type == "item/commandExecution/outputDelta")
    return body_field("aggregatedOutput");
  if (type == "item/started" || type == "item/completed") {
    // Store::content prefers aggregatedOutput for ordinary event projections.
    if (original_item.contains("aggregatedOutput") &&
        original_item.at("aggregatedOutput").is_string())
      return body_field("aggregatedOutput");
    // Persisted Codex entries add producer timestamps absent from the original
    // live item. Restore that original field shape rather than treating added
    // metadata as changed content. The caller still verifies the old byte digest.
    for (const auto *key : {"startedAtMs", "completedAtMs"})
      if (!original_item.contains(key))
        item.erase(key);
    // A file-change start event records the proposed diff before execution.
    // Its lifecycle status is derivable from the retained event type; only a
    // completed source with exactly the original body digest can replace it.
    if (kind == "fileChange" && type == "item/started" && item.value("status", "") == "completed" &&
        original_item.value("status", "inProgress") == "inProgress")
      item["status"] = "inProgress";
    auto rebuilt = event;
    // contentSeq is a local cache representation marker, never part of the
    // original structured event body produced by Store::event.
    rebuilt.erase("contentSeq");
    rebuilt["data"]["item"] = item;
    return rebuilt.dump();
  }
  throw Error("CONTENT_UNAVAILABLE", "History event has no deterministic item projection");
}
bool history_text_matches(const std::string &text, const Json &input) {
  const auto reference = history_reference_descriptor(input);
  return reference.at("length") == text.size() && reference.at("digest") == delivery_digest(text);
}
std::string recover_history_content(const Json &event, Json item, const std::string &projection,
                                    const Json &input, size_t source_byte_offset) {
  const auto reference = history_reference_descriptor(input);
  if (!event.contains("seq") || event.at("seq") != reference.at("seq") ||
      !event.contains("revision") || event.at("revision") != reference.at("revision"))
    throw Error("CONTENT_UNAVAILABLE", "History reconstruction requires the original revision");
  auto text = recover_history_text(event, std::move(item), projection);
  if (history_text_matches(text, reference))
    return text;
  const auto type = event.value("type", "");
  const auto &data = event.at("data");
  const auto original_item =
      data.contains("item") && data.at("item").is_object() ? data.at("item") : Json::object();
  const bool plain_text = type == "item/agentMessage/delta" ||
                          type == "item/commandExecution/outputDelta" ||
                          (projection == "external-v1" && type == "user") ||
                          (projection == "event-v1" && original_item.contains("aggregatedOutput") &&
                           original_item.at("aggregatedOutput").is_string());
  const auto length = reference.at("length").get<size_t>();
  if (plain_text && length <= text.size() && source_byte_offset <= text.size() - length) {
    const auto span = text.substr(source_byte_offset, length);
    if (history_text_matches(span, reference))
      return span;
  }
  throw Error("CONTENT_UNAVAILABLE", "Original history content cannot be reconstructed");
}
} // namespace coc
