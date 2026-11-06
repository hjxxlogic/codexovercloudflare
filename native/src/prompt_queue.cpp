#include "coc/delivery.hpp"
#include "coc/store.hpp"
namespace coc {
Json Store::prompt_queue_command(const std::string &session, const Json &cmd, const Json &context) {
  run("BEGIN IMMEDIATE");
  try {
    const auto record = delivery_record(context.at("stream"), context.at("seq"));
    if (record.at("phase") == "finished") {
      run("COMMIT");
      return nullptr;
    }
    auto s = get(session);
    if (s.at("state") != "ready" || s.at("mode") != "web" || s.value("external", false))
      throw Error("FORBIDDEN", "Queue requires an active managed web session");
    auto queue = s.value("promptQueue", Json::array());
    const auto action = cmd.at("action").get<std::string>();
    std::string id;
    if (action == "enqueue") {
      id = delivery_digest(Json::array({context.at("stream"), context.at("seq")}).dump());
      Json entry = {{"id", id},
                    {"text", cmd.at("text")},
                    {"state", "queued"},
                    {"task", delivery_target(context.at("stream"), context.at("seq"))}};
      if (cmd.contains("model"))
        entry["model"] = cmd.at("model");
      queue.push_back(entry);
      if (queue.size() > 16 || Json(queue.dump()).dump().size() > 96 * 1024)
        throw Error("BACKPRESSURE", "Message queue is full (16 messages / 96 KiB encoded)");
    } else {
      id = cmd.at("queueId");
      auto entry =
          std::find_if(queue.begin(), queue.end(), [&](const Json &v) { return v.at("id") == id; });
      if (entry == queue.end())
        throw Error("TARGET_NOT_FOUND", "Queued message is no longer pending");
      if (entry->at("state") == "starting" || entry->at("state") == "unknown")
        throw Error("RESULT_UNKNOWN",
                    "Message may have started; it cannot be replayed or cancelled");
      auto selected = *entry;
      if (action == "queueRun" && s.value("running", false)) {
        if (!cmd.contains("target") || cmd.at("target") != s.value("activeTask", Json()))
          throw Error("TARGET_NOT_FOUND",
                      "Immediate execution must name the current original task");
      }
      queue.erase(entry);
      if (action == "queueRun") {
        selected["state"] = s.value("running", false) ? "stopping" : "queued";
        selected.erase("error");
        queue.insert(queue.begin(), selected);
      }
    }
    s["promptQueue"] = queue;
    // Charge the durable queue separately from the currently running turn.
    if (queue.empty())
      history_release(session, "prompt-queue");
    else
      history_reserve(session, 16384 + queue.dump().size() * 4, 32, "prompt-queue");
    save(s);
    const auto event = this->event(session, "promptQueueChanged", {{"queue", queue}});
    delivery_finish(
        context.at("stream"), context.at("seq"),
        {{"type", "ack"},
         {"requestId", cmd.at("requestId")},
         {"result",
          {{"state", action == "enqueue" ? "queued-local" : "queue-updated"}, {"queueId", id}}}});
    run("COMMIT");
    return event;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::prompt_queue_state(const std::string &session, const std::string &id,
                               const std::string &state, const std::string &error) {
  run("BEGIN IMMEDIATE");
  try {
    auto s = get(session);
    auto &queue = s["promptQueue"];
    auto entry =
        std::find_if(queue.begin(), queue.end(), [&](const Json &v) { return v.at("id") == id; });
    if (entry == queue.end()) {
      run("COMMIT");
      return nullptr;
    }
    if (state.empty())
      queue.erase(entry);
    else {
      (*entry)["state"] = state;
      if (!error.empty())
        (*entry)["error"] = error.substr(0, 200);
      else
        entry->erase("error");
    }
    if (queue.empty())
      history_release(session, "prompt-queue");
    save(s);
    auto event = this->event(session, "promptQueueChanged", {{"queue", queue}});
    run("COMMIT");
    return event;
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
} // namespace coc
