#include "coc/delivery.hpp"
namespace coc {
std::string rpc_delivery_lane(const Json &message) {
  static const std::set<std::string> reads = {"account/read",       "account/rateLimits/read",
                                              "model/list",         "thread/list",
                                              "thread/loaded/list", "thread/read",
                                              "thread/turns/list",  "thread/queue/list",
                                              "config/read",        "skills/list"};
  const auto method = message.value("method", "");
  if (reads.count(method))
    return "";
  return method.empty() || method == "turn/interrupt" ? "priority" : "normal";
}
CommandDelivery::CommandDelivery(Store &store, std::string key, std::function<void(Json)> result)
    : store_(store), key_(std::move(key)), result_(std::move(result)) {
  state_ = store_.cache_get(key_);
  if (state_.is_null()) {
    const Json lane = {{"next", 0}, {"bytes", 0}, {"received", 0}, {"entries", Json::array()}};
    state_ = {{"version", 1}, {"stream", uuid()}, {"normal", lane}, {"priority", lane}};
    save();
  }
  if (state_.value("version", 0) != 1 || !valid_id(state_.at("stream")))
    throw Error("STORAGE_ERROR", "Invalid command outbox");
}
int64_t CommandDelivery::received_results(const std::string &lane) const {
  const auto &state = state_.at(lane);
  return state.at("entries").empty() ? state.at("next").get<int64_t>()
                                     : state.at("entries").front().at("seq").get<int64_t>() - 1;
}
Json CommandDelivery::opening() const {
  return {{"type", "delivery-open"},
          {"stream", stream()},
          {"received",
           {{"normal", received_results("normal")}, {"priority", received_results("priority")}}}};
}
void CommandDelivery::save() { store_.cache_put(key_, state_); }
bool CommandDelivery::pending() const {
  return !state_["normal"]["entries"].empty() || !state_["priority"]["entries"].empty();
}
void CommandDelivery::connect(std::function<void(Json)> send) {
  send_ = std::move(send);
  windows_ = Json::object();
  attempted_.clear();
  send_(opening());
}
void CommandDelivery::disconnect() {
  send_ = {};
  windows_ = Json::object();
  attempted_.clear();
}
void CommandDelivery::submit(const Json &message) {
  const auto lane = rpc_delivery_lane(message);
  if (lane.empty()) {
    if (!send_)
      throw Error("HOST_OFFLINE", "Read transport unavailable; retry the request");
    send_(message);
    return;
  }
  const auto body = message.dump();
  if (Json(body).dump().size() > max_frame - 4096)
    throw Error("MESSAGE_TOO_LARGE", "Command exceeds delivery frame budget");
  size_t count = 0, bytes = body.size();
  for (const auto &name : {"normal", "priority"})
    for (const auto &entry : state_[name]["entries"]) {
      if (lane == name) {
        ++count;
        bytes += entry["body"].get<std::string>().size();
      }
      if (message.contains("id") &&
          Json::parse(entry["body"].get<std::string>()).value("id", Json()) == message["id"]) {
        if (entry["body"] != body)
          throw Error("IDEMPOTENCY_CONFLICT", "Pending RPC identity reused");
        flush();
        return;
      }
    }
  if (count >= (lane == "priority" ? 4U : 96U) ||
      bytes > (lane == "priority" ? 512U * 1024 : 1536U * 1024))
    throw Error("BACKPRESSURE", "Local command outbox is full");
  auto previous = state_;
  auto &window = state_[lane];
  const auto seq = window["next"].get<int64_t>() + 1;
  const auto end = window["bytes"].get<int64_t>() + int64_t(body.size());
  if (seq > 9007199254740991LL || end > 9007199254740991LL)
    throw Error("BACKPRESSURE", "Delivery sequence exhausted");
  window["next"] = seq;
  window["bytes"] = end;
  window["entries"].push_back({{"seq", seq}, {"end", end}, {"body", body}});
  try {
    save();
  } catch (...) {
    state_ = previous;
    throw;
  }
  flush();
}
bool CommandDelivery::receive(const Json &frame) {
  const auto type = frame.value("type", "");
  if (type != "delivery-window" && type != "delivery-result")
    return false;
  const auto lane = frame.value("lane", "");
  if (lane != "normal" && lane != "priority")
    throw Error("INVALID_REQUEST", "Invalid delivery lane");
  auto window = frame.at("window");
  auto &state = state_[lane];
  for (const auto &key : {"received", "receivedBytes", "credit", "byteCredit"})
    if (!window.at(key).is_number_integer() || window.at(key).get<int64_t>() < 0 ||
        window.at(key).get<int64_t>() > 9007199254740991LL)
      throw Error("INVALID_REQUEST", "Invalid delivery credit");
  if (window["received"] > state["next"] || window["receivedBytes"] > state["bytes"] ||
      window["credit"] < window["received"] || window["byteCredit"] < window["receivedBytes"])
    throw Error("INVALID_REQUEST", "Inconsistent receiver progress");
  if ((state.contains("receiver") && state["receiver"] != window.at("instance")) ||
      (!windows_.contains(lane) &&
       (window["received"] < state["received"] ||
        window["receivedBytes"].get<int64_t>() < state.value("receivedBytes", int64_t(0)))))
    throw Error("DELIVERY_STATE_MISMATCH", "Receiver journal changed or lost confirmed commands");
  auto old_state = state_, old_windows = windows_;
  state["receiver"] = window.at("instance");
  state["receivedBytes"] =
      std::max(state.value("receivedBytes", int64_t(0)), window["receivedBytes"].get<int64_t>());
  if (windows_.contains(lane)) {
    if (windows_[lane]["stream"] != window["stream"])
      throw Error("INVALID_REQUEST", "Receiver stream changed");
    for (const auto &key : {"received", "receivedBytes", "credit", "byteCredit"})
      window[key] = std::max(window[key].get<int64_t>(), windows_[lane][key].get<int64_t>());
  }
  windows_[lane] = window;
  state["received"] = std::max(state["received"].get<int64_t>(), window["received"].get<int64_t>());
  Json result;
  bool complete = false;
  auto &entries = state["entries"];
  for (auto it = entries.begin(); it != entries.end(); ++it) {
    if ((*it)["seq"] != frame.value("seq", Json()))
      continue;
    const auto record = frame.value("record", Json::object());
    if (type != "delivery-result" &&
        (!record.is_object() || record.value("phase", "") != "finished"))
      break;
    result = type == "delivery-result" ? frame.at("payload") : record.at("result");
    const auto original = Json::parse((*it)["body"].get<std::string>());
    if (result.is_object() && result.contains("error") && !result.contains("id") &&
        original.contains("id"))
      result = {{"id", original["id"]},
                {"error",
                 {{"code", -32001},
                  {"message", result["error"].value("code", "ERROR") + ": " +
                                  result["error"].value("message", "Command failed")}}}};
    entries.erase(it);
    complete = true;
    break;
  }
  try {
    save();
  } catch (...) {
    state_ = old_state;
    windows_ = old_windows;
    throw;
  }
  if (complete) {
    if (!result.is_null())
      result_(result);
    if (send_)
      send_({{"type", "delivery-receipt"},
             {"stream", stream()},
             {"lane", lane},
             {"received", received_results(lane)}});
  }
  flush();
  return true;
}
void CommandDelivery::retry() {
  if (!send_)
    return;
  attempted_.clear();
  send_(opening());
  flush();
}
void CommandDelivery::flush() {
  if (!send_)
    return;
  for (const auto &lane : {"priority", "normal"}) {
    if (!windows_.contains(lane))
      continue;
    const auto &window = windows_[lane];
    for (const auto &entry : state_[lane]["entries"]) {
      const bool query = entry["seq"] <= window["received"];
      if (!query && (entry["seq"] > window["credit"] || entry["end"] > window["byteCredit"]))
        break;
      const auto key = std::string(lane) + ":" + entry["seq"].dump() + (query ? ":query" : ":send");
      if (attempted_.count(key))
        continue;
      Json frame = {{"type", query ? "delivery-query" : "delivery-command"},
                    {"stream", stream()},
                    {"lane", lane},
                    {"seq", entry["seq"]}};
      if (!query) {
        frame["end"] = entry["end"];
        frame["body"] = entry["body"];
      }
      send_(frame);
      attempted_.insert(key);
    }
  }
}
} // namespace coc
