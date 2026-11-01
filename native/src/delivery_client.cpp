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
  return method.empty() || method == "turn/interrupt" || method == "coc/cancel" ? "priority"
                                                                                : "normal";
}
CommandDelivery::CommandDelivery(Store &store, std::string key, std::function<void(Json)> result)
    : store_(store), key_(std::move(key) + ":v2"), result_(std::move(result)) {
  store_.local_reserve(key_, "command");
  state_ = store_.cache_get(key_);
  if (state_.is_null()) {
    const Json lane = {
        {"next", 0},
        {"bytes", 0},
        {"received", 0},
        {"entries", Json::array()},
        {"results",
         {{"received", 0}, {"bytes", 0}, {"buffer", Json::object()}, {"cache", Json::array()}}}};
    state_ = {{"version", 2}, {"stream", uuid()}, {"normal", lane}, {"priority", lane}};
    save();
  }
  if (state_.value("version", 0) != 2 || !valid_id(state_.at("stream")))
    throw Error("STORAGE_ERROR", "Invalid command outbox");
}
int64_t CommandDelivery::received_results(const std::string &lane) const {
  return state_.at(lane).at("results").at("received");
}
Json CommandDelivery::opening() const {
  Json open = {
      {"type", "delivery-open"},
      {"stream", stream()},
      {"exchangeId", exchange_id_},
      {"received",
       {{"normal", received_results("normal")}, {"priority", received_results("priority")}}},
      {"receivedBytes",
       {{"normal", state_["normal"]["results"]["bytes"]},
        {"priority", state_["priority"]["results"]["bytes"]}}}};
  if (state_["normal"].contains("receiver"))
    open["instance"] = state_["normal"]["receiver"];
  else if (state_["priority"].contains("receiver"))
    open["instance"] = state_["priority"]["receiver"];
  return open;
}
void CommandDelivery::begin_recovery() {
  transfers_ = Json::object();
  exchange_id_ = uuid();
  windows_ = Json::object();
  snapshots_.clear();
  attempted_.clear();
  for (const auto &lane : {"normal", "priority"})
    baseline_[lane] = {{"received", state_[lane]["received"]},
                       {"bytes", state_[lane].value("receivedBytes", int64_t(0))},
                       {"resultReceived", state_[lane]["results"]["received"]},
                       {"resultBytes", state_[lane]["results"]["bytes"]}};
}
void CommandDelivery::save() { store_.cache_put(key_, state_); }
bool CommandDelivery::pending() const {
  for (const auto &lane : {"normal", "priority"}) {
    const auto &state = state_.at(lane);
    if (!state.at("results").at("buffer").empty())
      return true;
    for (const auto &entry : state.at("entries"))
      if (state.value("closed", false)
              ? entry.at("seq") > 0 && entry.at("seq") <= state.at("received")
              : !state.value("exhausted", false) || entry.at("seq") > 0)
        return true;
  }
  return false;
}
void CommandDelivery::connect(std::function<void(Json)> send, const Json &control) {
  disconnect();
  if (frozen_)
    throw Error("DELIVERY_STATE_MISMATCH", "Automatic replay stopped");
  if (!control.is_null()) {
    for (const auto &key : {"controlEpoch", "connectionGeneration"}) {
      const auto value = control.at(key).get<int64_t>();
      if (value <= 0 || value > 9007199254740991LL)
        throw Error("INVALID_REQUEST", "Invalid control generation");
    }
    if (!valid_id(control.at("controlId")) || !valid_id(control.at("owner")))
      throw Error("INVALID_REQUEST", "Invalid control identity");
    if (state_.contains("control") && state_["control"]["controlId"] != control["controlId"])
      throw Error("STREAM_CLOSED", "A new controller cannot replay the previous command flow");
    if (state_.contains("control")) {
      const auto &prior = state_.at("control");
      if (control.at("controlEpoch") != prior.at("controlEpoch") ||
          control.at("owner") != prior.at("owner") ||
          control.at("connectionGeneration").get<int64_t>() <
              prior.at("connectionGeneration").get<int64_t>())
        throw Error("STALE_CONTROLLER", "Control proof conflicts with durable controller identity");
    }
    auto previous = state_;
    state_["control"] = control;
    try {
      save();
    } catch (...) {
      state_ = previous;
      throw;
    }
  }
  control_ = control;
  send_ = std::move(send);
  begin_recovery();
  send_(opening());
}
void CommandDelivery::disconnect() {
  transfers_ = Json::object();
  send_ = {};
  snapshots_.clear();
  exchange_id_.clear();
  windows_ = Json::object();
  attempted_.clear();
}
bool CommandDelivery::cancel_unpublished(const Json &id) {
  for (const auto &lane : {"normal", "priority"}) {
    auto &entries = state_[lane]["entries"];
    for (auto entry = entries.begin(); entry != entries.end(); ++entry) {
      const auto original = Json::parse(entry->at("body").get<std::string>());
      if (!original.contains("method") || !original.contains("id") || original.at("id") != id ||
          entry->at("seq") != 0)
        continue;
      if (state_.value("cancelledKeys", Json::array()).size() >= 1024)
        throw Error("BACKPRESSURE", "Local cancellation identity budget exhausted");
      auto previous = state_;
      if (!state_.contains("cancelledKeys"))
        state_["cancelledKeys"] = Json::array();
      state_["cancelledKeys"].push_back(delivery_digest(delivery_request_key(original)));
      if (!state_.contains("cancelled"))
        state_["cancelled"] = Json::array();
      state_["cancelled"].push_back({{"id", id}, {"body", entry->at("body")}});
      if (state_["cancelled"].size() > 64)
        state_["cancelled"].erase(state_["cancelled"].begin());
      while (state_["cancelled"].dump().size() > 512 * 1024)
        state_["cancelled"].erase(state_["cancelled"].begin());
      entries.erase(entry);
      try {
        save();
      } catch (...) {
        state_ = previous;
        throw;
      }
      return true;
    }
  }
  return false;
}
void CommandDelivery::observe(const Json &payload) {
  if (!payload.contains("coc"))
    return;
  const auto &metadata = payload.at("coc");
  const auto instance =
      state_["normal"].value("receiver", state_["priority"].value("receiver", ""));
  auto previous = state_;
  try {
    if (metadata.contains("task")) {
      const auto target = command_target(metadata.at("task"));
      if (target.at("instance") != instance)
        throw Error("DELIVERY_STATE_MISMATCH", "Task metadata belongs to another Agent instance");
      state_["activeTask"] = target;
    }
    if (metadata.contains("approval")) {
      const auto &proof = metadata.at("approval");
      for (const auto &key : {"instance", "runtimeId", "approvalVersion"})
        if (!proof.contains(key) || !proof.at(key).is_string() || !valid_id(proof.at(key)))
          throw Error("INVALID_REQUEST", "Invalid approval proof");
      if (proof.at("instance") != instance || proof.at("requestId") != payload.at("id"))
        throw Error("DELIVERY_STATE_MISMATCH",
                    "Approval metadata names another instance or request");
      if (!state_.contains("approvals"))
        state_["approvals"] = Json::object();
      state_["approvals"][payload.at("id").dump()] = proof;
      if (state_["approvals"].size() > 128 || state_["approvals"].dump().size() > 64 * 1024)
        throw Error("BACKPRESSURE", "Approval metadata budget exhausted");
    }
    save();
  } catch (...) {
    state_ = previous;
    throw;
  }
}
void CommandDelivery::submit(const Json &message) {
  if (frozen_)
    throw Error("DELIVERY_STATE_MISMATCH", "Automatic replay stopped");
  if (message.value("method", "") == "$/cancelRequest") {
    const auto request = message.at("params").at("requestId");
    if (cancel_unpublished(request)) {
      result_({{"id", request},
               {"error",
                {{"code", -32800},
                 {"message", "Cancelled locally before publication"},
                 {"data", {{"code", "CANCELLED_BEFORE_START"}}}}}});
      return;
    }
    Json target;
    const auto key = "rpc:" + request.dump();
    if (state_.contains("activeTask") && state_.at("activeTask").at("requestId") == key)
      target = state_.at("activeTask");
    for (const auto &entry : state_["normal"]["entries"]) {
      const auto original = Json::parse(entry.at("body").get<std::string>());
      if (target.is_null() && original.value("method", "") == "turn/start" &&
          original.value("id", Json()) == request && entry.at("seq") != 0 &&
          state_.contains("control") && state_["normal"].contains("receiverStream"))
        target = {{"stream", state_["normal"].at("receiverStream")},
                  {"instance", state_["normal"].at("receiver")},
                  {"controlEpoch", state_.at("control").at("controlEpoch")},
                  {"owner", state_.at("control").at("owner")},
                  {"requestId", key}};
    }
    if (target.is_null())
      throw Error("TARGET_NOT_FOUND", "No original task matches this cancellation");
    submit({{"method", "coc/cancel"}, {"params", {{"target", command_target(target)}}}});
    return;
  }
  for (const auto &cancelled : state_.value("cancelled", Json::array()))
    if (message.contains("method") && message.contains("id") &&
        cancelled.at("id") == message.at("id"))
      throw Error("CANCELLED_BEFORE_START", "This original request was cancelled locally");
  if (message.contains("method") && message.contains("id"))
    for (const auto &key : state_.value("cancelledKeys", Json::array()))
      if (key == delivery_digest(delivery_request_key(message)))
        throw Error("CANCELLED_BEFORE_START", "This original request was cancelled locally");
  const auto lane = rpc_delivery_lane(message);
  if (lane.empty()) {
    if (!send_)
      throw Error("HOST_OFFLINE", "Read transport unavailable; retry the request");
    send_(message);
    return;
  }
  auto outgoing = message;
  if (message.value("method", "") == "turn/interrupt") {
    if (!state_.contains("activeTask"))
      throw Error("TARGET_NOT_FOUND",
                  "The active task identity is unavailable; refresh before interruption");
    const auto target = command_target(state_.at("activeTask"));
    if (target.value("turnId", "") != message.at("params").value("turnId", ""))
      throw Error("TARGET_NOT_FOUND", "The interruption names a different original turn");
    outgoing["coc"] = {{"target", target}};
  }
  if (message.contains("id") && !message.contains("method")) {
    const auto key = message.at("id").dump();
    if (!state_.contains("approvals") || !state_["approvals"].contains(key))
      throw Error("TARGET_NOT_FOUND", "The original approval identity is unavailable");
    outgoing["coc"] = {{"approval", state_["approvals"].at(key)}};
  }
  const auto body = outgoing.dump();
  if (Json(body).dump().size() > max_frame - 4096)
    throw Error("MESSAGE_TOO_LARGE", "Command exceeds delivery frame budget");
  size_t count = 0, bytes = body.size();
  for (const auto &name : {"normal", "priority"})
    for (const auto &entry : state_[name]["entries"]) {
      if (lane == name) {
        ++count;
        bytes += entry["body"].get<std::string>().size();
      }
      if (!delivery_request_key(outgoing).empty() &&
          delivery_request_key(Json::parse(entry["body"].get<std::string>())) ==
              delivery_request_key(outgoing)) {
        if (entry["body"] != body)
          throw Error("IDEMPOTENCY_CONFLICT", "Pending RPC identity reused");
        flush();
        return;
      }
    }
  if (count >= (lane == "priority" ? 4U : 96U) ||
      bytes > (lane == "priority" ? 512U * 1024 : 1536U * 1024))
    throw Error("BACKPRESSURE", "Local command outbox is full");
  if (state_[lane].value("closed", false) || state_[lane].value("exhausted", false))
    throw Error("STREAM_CLOSED", "Reconcile original results before starting a new command flow");
  auto previous = state_;
  auto &window = state_[lane];
  window["entries"].push_back({{"seq", 0}, {"end", 0}, {"body", body}});
  try {
    save();
  } catch (...) {
    state_ = previous;
    throw;
  }
  flush();
}
Json CommandDelivery::receive_result(const std::string &lane, const Json &frame,
                                     const Json &window) {
  const auto seq = frame.at("seq").get<int64_t>();
  const auto result_seq = frame.at("resultSeq").get<int64_t>();
  const auto end = frame.at("resultEnd").get<int64_t>();
  const auto body = frame.at("resultBody").get<std::string>();
  const auto digest = frame.at("resultDigest").get<std::string>();
  if (seq <= 0 || seq > 9007199254740991LL || result_seq <= 0 || end <= 0 ||
      result_seq > window.value("sent", int64_t(0)) ||
      end > window.value("resultBytes", int64_t(0)) ||
      frame.at("resultStream") != window.at("stream").get<std::string>() + "_r")
    throw Error("INVALID_REQUEST", "Result exceeds published stream");
  if (body.size() > max_frame - 8192 || delivery_digest(body) != digest)
    throw Error("IDEMPOTENCY_CONFLICT", "Result digest mismatch");
  auto &state = state_[lane];
  auto &journal = state["results"];
  const auto key = std::to_string(result_seq);
  Json known;
  if (journal["buffer"].contains(key))
    known = journal["buffer"][key];
  else
    for (const auto &cached : journal["cache"])
      if (cached.at("seq") == result_seq)
        known = cached;
  if (!known.is_null() && (known.at("command") != seq || known.at("end") != end ||
                           known.at("digest") != digest || known.at("body") != body))
    throw Error("IDEMPOTENCY_CONFLICT", "Result identity changed");
  if (!known.is_null() || result_seq <= journal.at("received").get<int64_t>())
    return nullptr;
  auto &entries = state["entries"];
  auto pending = std::find_if(entries.begin(), entries.end(),
                              [&](const Json &entry) { return entry.at("seq") == seq; });
  if (pending == entries.end())
    throw Error("INVALID_REQUEST", "Result has no pending command");
  const auto original = Json::parse(pending->at("body").get<std::string>());
  auto payload = Json::parse(body);
  std::string content;
  if (payload.is_object() && payload.value("type", "") == "delivery-content") {
    if (payload.value("retention", "") != "transfer" || payload.value("revision", 0) != 1 ||
        !payload.at("length").is_number_integer() || payload.at("length").get<int64_t>() <= 0 ||
        payload.at("length").get<int64_t>() > 2 * 1024 * 1024 ||
        payload.at("contentId") != payload.at("digest"))
      throw Error("INVALID_REQUEST", "Invalid transfer result descriptor");
    if (!frame.contains("resultContent")) {
      const auto key = lane + ":" + std::to_string(result_seq);
      if (!transfers_.contains(key)) {
        if (transfers_.size() >= 2)
          throw Error("BACKPRESSURE", "Result content reads are busy");
        transfers_[key] = {{"frame", frame}, {"window", window}, {"content", ""}};
        send_({{"type", "delivery-content"},
               {"stream", stream()},
               {"lane", lane},
               {"instance", window.at("instance")},
               {"resultSeq", result_seq},
               {"offset", 0}});
      }
      return nullptr;
    }
    content = frame.at("resultContent").get<std::string>();
    if (content.size() != payload.at("length").get<size_t>() ||
        delivery_digest(content) != payload.at("digest"))
      throw Error("IDEMPOTENCY_CONFLICT", "Transfer result content verification failed");
    payload = Json::parse(content);
  }
  if (original.contains("id") && payload.is_object() && payload.contains("id") &&
      original.at("id") != payload.at("id"))
    throw Error("IDEMPOTENCY_CONFLICT", "Result request identity changed");
  Json record = {
      {"seq", result_seq}, {"command", seq}, {"end", end}, {"body", body}, {"digest", digest}};
  if (!content.empty())
    record["content"] = content;
  journal["buffer"][key] = record;
  size_t bytes = 0;
  for (const auto &buffered : journal["buffer"])
    bytes += buffered.at("body").get<std::string>().size() + buffered.value("content", "").size();
  if (journal["buffer"].size() > 100 || bytes > 2 * 1024 * 1024)
    throw Error("BACKPRESSURE", "Result receive buffer is full");
  journal["cache"].push_back(record);
  bytes = 0;
  for (const auto &cached : journal["cache"])
    bytes += cached.at("body").get<std::string>().size() + cached.value("content", "").size();
  while (journal["cache"].size() > 64 || bytes > 2 * 1024 * 1024) {
    bytes -= journal["cache"].front().at("body").get<std::string>().size() +
             journal["cache"].front().value("content", "").size();
    journal["cache"].erase(journal["cache"].begin());
  }
  if (!original.contains("method") && original.contains("id") && original.contains("coc") &&
      original.at("coc").contains("approval") && state_.contains("approvals")) {
    const auto approval_key = original.at("id").dump();
    if (state_["approvals"].contains(approval_key) &&
        state_["approvals"].at(approval_key) == original.at("coc").at("approval"))
      state_["approvals"].erase(approval_key);
  }
  entries.erase(pending);
  for (;;) {
    const auto next = std::to_string(journal.at("received").get<int64_t>() + 1);
    if (!journal["buffer"].contains(next))
      break;
    const auto value = journal["buffer"][next];
    const auto bytes =
        journal.at("bytes").get<int64_t>() + int64_t(value.at("body").get<std::string>().size());
    if (value.at("end") != bytes)
      throw Error("INVALID_REQUEST", "Non-continuous result byte boundary");
    journal["received"] = journal.at("received").get<int64_t>() + 1;
    journal["bytes"] = bytes;
    journal["buffer"].erase(next);
  }
  if (payload.is_object() && payload.contains("error") && !payload.contains("id") &&
      original.contains("id"))
    payload = {{"id", original.at("id")},
               {"error",
                {{"code", -32001},
                 {"message", payload["error"].value("code", "ERROR") + ": " +
                                 payload["error"].value("message", "Command failed")}}}};
  return {{"payload", original.value("method", "") == "coc/cancel" ? Json() : payload}};
}
bool CommandDelivery::receive(const Json &frame) {
  const auto type = frame.value("type", "");
  if (type != "delivery-window" && type != "delivery-result" && type != "delivery-reset")
    return false;
  if (!send_ || (frame.contains("exchangeId") && frame.at("exchangeId") != exchange_id_))
    return true;
  if (type == "delivery-reset") {
    if (frame.value("exchangeId", "") != exchange_id_)
      return true;
    frozen_ = true;
    disconnect();
    throw Error("DELIVERY_STATE_MISMATCH",
                "Receiver refused recovery: " + frame.at("error").value("code", "ERROR"));
  }
  const auto lane = frame.value("lane", "");
  if (lane != "normal" && lane != "priority")
    throw Error("INVALID_REQUEST", "Invalid delivery lane");
  if (!snapshots_.count(lane) && frame.value("exchangeId", "") != exchange_id_)
    return true;
  if (!snapshots_.count(lane) && !control_.is_null()) {
    const auto ready = frame.value("controlReady", Json::object());
    if (ready.value("exchangeId", "") != exchange_id_ ||
        ready.value("instance", Json()) != frame.at("window").at("instance"))
      throw Error("STALE_CONTROLLER", "Agent has not confirmed the current control claim");
    for (const auto &key : {"controlEpoch", "connectionGeneration", "controlId", "owner"})
      if (!ready.contains(key) || ready.at(key) != control_.at(key))
        throw Error("STALE_CONTROLLER", "Agent control confirmation identity changed");
  }
  auto window = frame.at("window");
  if (frame.contains("content")) {
    const auto &chunk = frame.at("content");
    const auto result_seq = chunk.at("resultSeq").get<int64_t>();
    const auto key = lane + ":" + std::to_string(result_seq);
    if (!transfers_.contains(key))
      return true;
    auto &transfer = transfers_[key];
    const auto descriptor = Json::parse(transfer.at("frame").at("resultBody").get<std::string>());
    auto content = transfer.at("content").get<std::string>();
    const auto part = chunk.at("body").get<std::string>();
    if (window.at("stream") != transfer.at("window").at("stream") ||
        window.at("instance") != transfer.at("window").at("instance") ||
        chunk.at("length") != descriptor.at("length") || chunk.at("offset") != content.size() ||
        part.empty() || chunk.at("next") != content.size() + part.size() ||
        content.size() + part.size() > descriptor.at("length").get<size_t>())
      throw Error("INVALID_REQUEST", "Invalid result content chunk");
    content += part;
    transfer["content"] = content;
    size_t buffered = 0;
    for (const auto &item : transfers_)
      buffered += item.at("content").get<std::string>().size();
    if (buffered > 2 * 1024 * 1024)
      throw Error("BACKPRESSURE", "Result transfer receive buffer is full");
    if (content.size() == descriptor.at("length")) {
      auto complete = transfer.at("frame");
      complete["type"] = "delivery-result";
      complete["lane"] = lane;
      complete["window"] = transfer.at("window");
      complete["resultContent"] = content;
      transfers_.erase(key);
      return receive(complete);
    }
    send_({{"type", "delivery-content"},
           {"stream", stream()},
           {"lane", lane},
           {"instance", window.at("instance")},
           {"resultSeq", result_seq},
           {"offset", content.size()}});
    return true;
  }
  if (!valid_id(window.at("stream")) || !valid_id(window.at("instance")))
    throw Error("INVALID_REQUEST", "Invalid delivery identity");
  auto &state = state_[lane];
  if (state.contains("receiverStream") && state["receiverStream"] != window.at("stream"))
    throw Error("INVALID_REQUEST", "Receiver stream changed");
  for (const auto &key : {"received", "receivedBytes", "credit", "byteCredit"})
    if (!window.at(key).is_number_integer() || window.at(key).get<int64_t>() < 0 ||
        window.at(key).get<int64_t>() > 9007199254740991LL)
      throw Error("INVALID_REQUEST", "Invalid delivery credit");
  for (const auto &key : {"sent", "resultBytes"})
    if (window.contains(key) &&
        (!window.at(key).is_number_integer() || window.at(key).get<int64_t>() < 0 ||
         window.at(key).get<int64_t>() > 9007199254740991LL))
      throw Error("INVALID_REQUEST", "Invalid result publication head");
  if (window["received"] > state["next"] || window["receivedBytes"] > state["bytes"] ||
      window["credit"] < window["received"] || window["byteCredit"] < window["receivedBytes"])
    throw Error("INVALID_REQUEST", "Inconsistent receiver progress");
  if ((state.contains("receiver") && state["receiver"] != window.at("instance")) ||
      (state.contains("streamSerial") &&
       state.at("streamSerial") != window.value("streamSerial", Json())) ||
      (state.contains("creditGeneration") &&
       state.at("creditGeneration") != window.value("creditGeneration", Json())) ||
      (frame.value("exchangeId", "") == exchange_id_ && !snapshots_.count(lane) &&
       (window["received"] < baseline_[lane]["received"] ||
        window["receivedBytes"] < baseline_[lane]["bytes"] ||
        window.value("sent", int64_t(0)) < baseline_[lane]["resultReceived"].get<int64_t>() ||
        window.value("resultBytes", int64_t(0)) < baseline_[lane]["resultBytes"].get<int64_t>()))) {
    frozen_ = true;
    disconnect();
    throw Error("DELIVERY_STATE_MISMATCH", "Receiver journal changed or lost confirmed commands");
  }
  if (window["received"] == state["received"] &&
      window["receivedBytes"].get<int64_t>() != state.value("receivedBytes", int64_t(0)))
    throw Error("INVALID_REQUEST", "Same command ACK changed byte position");
  if (window["received"] > state["received"]) {
    bool found = false;
    for (const auto &entry : state["entries"])
      if (entry["seq"] == window["received"] && entry["end"] == window["receivedBytes"])
        found = true;
    if (!found)
      throw Error("INVALID_REQUEST", "ACK is not a published byte boundary");
  }
  auto old_state = state_, old_windows = windows_;
  Json completions = Json::array(), envelopes = frame.value("results", Json::array());
  if (type == "delivery-result")
    envelopes.push_back(frame);
  else if (frame.value("record", Json::object()).is_object() &&
           frame.value("record", Json::object()).value("phase", "") == "finished") {
    auto record = frame.at("record");
    record["seq"] = frame.at("seq");
    if (record.at("resultBody").is_null())
      throw Error("RESULT_UNAVAILABLE", "Result body was retired");
    envelopes.push_back(record);
  }
  try {
    for (const auto &envelope : envelopes) {
      auto completion = receive_result(lane, envelope, window);
      if (!completion.is_null())
        completions.push_back(completion);
    }
    state["receiver"] = window.at("instance");
    state["receiverStream"] = window.at("stream");
    if (window.contains("streamSerial")) {
      if (!window.at("streamSerial").is_number_integer() ||
          window.at("streamSerial").get<int64_t>() <= 0 ||
          window.at("streamSerial").get<int64_t>() > 9007199254740991LL ||
          !window.contains("creditGeneration") || !window.at("creditGeneration").is_string() ||
          !valid_id(window.at("creditGeneration")))
        throw Error("INVALID_REQUEST", "Invalid receiver credit allocation");
      state["streamSerial"] = window.at("streamSerial");
      state["creditGeneration"] = window.at("creditGeneration");
    }
    state["receivedBytes"] =
        std::max(state.value("receivedBytes", int64_t(0)), window["receivedBytes"].get<int64_t>());
    if (windows_.contains(lane)) {
      if (windows_[lane]["stream"] != window["stream"])
        throw Error("INVALID_REQUEST", "Receiver stream changed");
      for (const auto &key : {"received", "receivedBytes", "credit", "byteCredit"})
        window[key] = std::max(window[key].get<int64_t>(), windows_[lane][key].get<int64_t>());
    }
    windows_[lane] = window;
    state["closed"] = state.value("closed", false) || window.value("closed", false);
    state["exhausted"] = state.value("exhausted", false) || window.value("exhausted", false);
    state["received"] =
        std::max(state["received"].get<int64_t>(), window["received"].get<int64_t>());
    save();
  } catch (...) {
    state_ = old_state;
    windows_ = old_windows;
    throw;
  }
  const bool complete = !completions.empty();
  if (state_[lane]["received"] > old_state[lane]["received"] || complete)
    ++progress_;
  if (frame.value("exchangeId", "") == exchange_id_)
    snapshots_.insert(lane);
  if (!envelopes.empty() && send_)
    send_({{"type", "delivery-receipt"},
           {"stream", stream()},
           {"lane", lane},
           {"instance", window.at("instance")},
           {"received", received_results(lane)},
           {"receivedBytes", state_[lane]["results"]["bytes"]}});
  for (const auto &completion : completions)
    if (!completion.at("payload").is_null())
      result_(completion.at("payload"));
  flush();
  return true;
}
void CommandDelivery::retry() {
  if (!send_)
    return;
  if (ready())
    begin_recovery();
  attempted_.clear();
  send_(opening());
  flush();
}
void CommandDelivery::flush() {
  if (!send_ || !ready() || frozen_)
    return;
  for (const auto &lane : {"priority", "normal"}) {
    if (!windows_.contains(lane))
      continue;
    const auto &window = windows_[lane];
    for (auto &entry : state_[lane]["entries"]) {
      if (entry["seq"] == 0) {
        auto &state = state_[lane];
        if (state.value("closed", false) || state.value("exhausted", false))
          continue;
        const auto seq = state["next"].get<int64_t>() + 1;
        const auto end =
            state["bytes"].get<int64_t>() + int64_t(entry["body"].get<std::string>().size());
        if (seq > 9007199254740991LL || end > 9007199254740991LL)
          throw Error("BACKPRESSURE", "Delivery sequence exhausted");
        if (seq > window["credit"].get<int64_t>() || end > window["byteCredit"].get<int64_t>())
          break;
        const auto previous = state_;
        entry["seq"] = state["next"] = seq;
        entry["end"] = state["bytes"] = end;
        try {
          save();
        } catch (...) {
          state_ = previous;
          throw;
        }
      }
      const bool query = entry["seq"] <= window["received"];
      if (!query && state_[lane].value("closed", false))
        continue;
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
