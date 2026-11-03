#include "coc/history_subscription.hpp"
#include "coc/recovery.hpp"
namespace coc {
namespace {
bool history_revision(const Json &d, const std::string &field) {
  return d.contains(field) && d.at(field).is_number_integer() && d.at(field).get<int64_t>() >= 0 &&
         d.at(field).get<int64_t>() <= 9007199254740991LL;
}
} // namespace
HistorySubscription::HistorySubscription(asio::io_context &io, Store &store, std::string key,
                                         std::function<int64_t()> durable,
                                         std::function<void(int64_t)> dirty,
                                         std::function<void()> ready,
                                         std::function<void(const Json &)> failed)
    : store_(store), key_(std::move(key)), retry_(io), durable_(std::move(durable)),
      dirty_(std::move(dirty)), ready_(std::move(ready)), failed_(std::move(failed)) {
  saved_ = store_.cache_get(key_);
  if (saved_.is_null()) {
    saved_ = {{"stream", uuid()}, {"instance", uuid()}, {"acknowledgedRevision", 0}};
    store_.cache_put(key_, saved_);
  }
  if (!history_revision(saved_, "acknowledgedRevision") ||
      saved_.at("acknowledgedRevision").get<int64_t>() > std::max(int64_t(0), durable_()))
    mismatch("Local history confirmation checkpoint rolled back");
}
HistorySubscription::~HistorySubscription() { disconnect(); }
[[noreturn]] void HistorySubscription::mismatch(const std::string &message) {
  stop();
  throw Error("DELIVERY_STATE_MISMATCH", message);
}
void HistorySubscription::disconnect() {
  retry_.cancel();
  exchange_.clear();
  send_ = {};
  pending_ = -1;
  opened_ = false;
  released_ = -1;
}
void HistorySubscription::stop() {
  stopped_ = true;
  disconnect();
}
void HistorySubscription::connect(std::function<void(Json)> send) {
  disconnect();
  if (stopped_)
    return;
  send_ = std::move(send);
  exchange_ = uuid();
  request_ = uuid();
  pending_ = published_ = std::max(int64_t(0), durable_());
  attempts_ = 0;
  transmit();
}
void HistorySubscription::transmit() {
  retry_.cancel();
  if (!send_ || stopped_ || pending_ < 0)
    return;
  if (store_.cache_get(key_) != saved_)
    mismatch("History subscription was cleared or changed by another process");
  auto frame = saved_;
  frame["operation"] = opened_ ? "ack" : "subscribe";
  frame["exchangeId"] = exchange_;
  frame["requestId"] = request_;
  frame["receivedRevision"] = pending_;
  if (opened_ && released_ >= 0)
    frame["releasedRevision"] = pending_;
  published_ = std::max(published_, pending_);
  send_(frame);
  const auto delay = recovery_delay(attempts_);
  attempts_ = std::min(attempts_ + 1, 3);
  retry_.expires_after(std::chrono::milliseconds(delay));
  retry_.async_wait([this](auto ec) {
    if (ec)
      return;
    try {
      transmit();
    } catch (const std::exception &error) {
      stop();
      failed_(error_data(error));
    }
  });
}
void HistorySubscription::commit() {
  if (!opened_ || !send_ || stopped_)
    return;
  if (store_.cache_get(key_) != saved_)
    mismatch("History subscription was cleared or changed by another process");
  const auto durable = std::min(std::max(int64_t(0), durable_()), maximum_);
  if ((durable <= saved_.at("acknowledgedRevision").get<int64_t>() &&
       (released_ < 0 || durable <= released_)) ||
      durable <= pending_)
    return;
  pending_ = durable;
  request_ = uuid();
  attempts_ = 0;
  transmit();
}
bool HistorySubscription::receive(const Json &d) {
  const auto type = d.value("type", "");
  if (type == "error") {
    if (d.value("error", Json::object()).value("code", "") == "HISTORY_SUBSCRIPTION_EXPIRED" &&
        send_ &&
        (d.value("requestId", "") == request_ ||
         (d.value("stream", "") == saved_.at("stream") &&
          d.value("instance", "") == saved_.at("instance")))) {
      const Json next = {{"stream", uuid()}, {"instance", uuid()}, {"acknowledgedRevision", 0}};
      if (!store_.cache_replace(key_, saved_, next))
        mismatch("History subscription changed while replacing an expired identity");
      saved_ = next;
      auto send = send_;
      connect(std::move(send));
      return true;
    }
    if (d.value("requestId", "") == request_ && d.contains("error")) {
      const auto code = d.at("error").value("code", "");
      if (code == "DELIVERY_STATE_MISMATCH" || code == "STREAM_CLOSED" || code == "UNAUTHORIZED" ||
          code == "FORBIDDEN") {
        stop();
        failed_(d.at("error"));
      }
    }
    return false;
  }
  if (type != "history-window" && type != "history-dirty")
    return false;
  if (stopped_ || exchange_.empty() || d.value("exchangeId", "") != exchange_ ||
      d.value("stream", "") != saved_.at("stream") ||
      d.value("instance", "") != saved_.at("instance"))
    return true;
  if (d.dump().size() > 4096 || !history_revision(d, "streamSerial") || d.at("streamSerial") == 0 ||
      !history_revision(d, "receivedRevision") || !history_revision(d, "maxRevision") ||
      !d.contains("agentInstance") || !d.at("agentInstance").is_string() ||
      !d.contains("creditGeneration") || !d.at("creditGeneration").is_string())
    throw Error("INVALID_REQUEST", "Invalid history subscription window");
  for (const auto &field : {"agentInstance", "streamSerial", "creditGeneration"})
    if (saved_.contains(field) && saved_.at(field) != d.at(field))
      mismatch("History storage instance or allocation identity changed");
  if (type == "history-dirty") {
    if (opened_) {
      maximum_ = std::max(maximum_, d.at("maxRevision").get<int64_t>());
      dirty_(maximum_);
      commit();
    }
    return true;
  }
  if (!opened_ && d.value("requestId", "") != request_)
    return true;
  const auto received = d.at("receivedRevision").get<int64_t>();
  const auto maximum = d.at("maxRevision").get<int64_t>();
  if ((!opened_ &&
       (received < saved_.at("acknowledgedRevision").get<int64_t>() || maximum < pending_)) ||
      received > published_ || received > std::max(int64_t(0), durable_()) || received > maximum)
    mismatch("History durable checkpoint rolled back or exceeded its published boundary");
  if (d.contains("releasedRevision")) {
    if (!history_revision(d, "releasedRevision") || d.at("releasedRevision") > received)
      mismatch("Invalid history reference release boundary");
    released_ = std::max(released_, d.at("releasedRevision").get<int64_t>());
  }
  auto next = saved_;
  for (const auto &field : {"agentInstance", "streamSerial", "creditGeneration"})
    next[field] = d.at(field);
  next["acknowledgedRevision"] =
      std::max(received, saved_.at("acknowledgedRevision").get<int64_t>());
  if (!store_.cache_replace(key_, saved_, next))
    mismatch("History subscription was cleared or changed by another process");
  saved_ = std::move(next);
  maximum_ = std::max(maximum_, maximum);
  const bool opening = !opened_;
  opened_ = true;
  if (opening ||
      (pending_ >= 0 && received >= pending_ && (released_ < 0 || released_ >= pending_))) {
    pending_ = -1;
    retry_.cancel();
  }
  if (opening)
    ready_();
  if (maximum_ > std::max(int64_t(0), durable_()))
    dirty_(maximum_);
  commit();
  return true;
}
} // namespace coc
