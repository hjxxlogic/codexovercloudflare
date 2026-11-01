#include "coc/access.hpp"
#include "coc/approvals.hpp"
#include "coc/common.hpp"
#include "coc/credit.hpp"
#include "coc/delivery.hpp"
#include "coc/external.hpp"
#include "coc/files.hpp"
#include "coc/history_subscription.hpp"
#include "coc/network.hpp"
#include "coc/process.hpp"
#include "coc/store.hpp"
#include "coc/update.hpp"
#include "external-approvals.hpp"
#include "process-proxy.hpp"
#include "proxy.hpp"
#include "remote-config.hpp"
#include <condition_variable>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <iostream>
#include <mutex>
#include <optional>
#include <sys/resource.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
namespace {
using namespace coc;
void check(bool ok, const char *message) {
  if (!ok)
    throw std::runtime_error(message);
}
template <class F> void rejects(F f, const std::string &code) {
  try {
    f();
  } catch (const Error &e) {
    check(e.code == code, "Unexpected error code");
    return;
  }
  throw std::runtime_error("Expected rejection");
}
struct Temp {
  std::string path;
  Temp() {
    char t[] = "/tmp/coc-cpp-XXXXXX";
    auto p = mkdtemp(t);
    if (!p)
      throw std::runtime_error("mkdtemp failed");
    path = p;
  }
  ~Temp() { std::filesystem::remove_all(path); }
};
struct Environment {
  std::string name;
  std::optional<std::string> previous;
  explicit Environment(std::string key) : name(std::move(key)) {
    if (const auto value = std::getenv(name.c_str()))
      previous = value;
    unsetenv(name.c_str());
  }
  ~Environment() {
    if (previous)
      setenv(name.c_str(), previous->c_str(), 1);
    else
      unsetenv(name.c_str());
  }
};
void core() {
  {
    Temp dir;
    Store journal(dir.path);
    journal.save({{"id", "archive"}});
    journal.archive_event("archive", "user", {{"text", "older history"}});
    check(journal.delivery_heads("archive")["agent"] == 0,
          "Imported negative history does not become a negative transport head");
    std::vector<Json> sent, replies;
    CommandDelivery sender(journal, "sender", [&](Json reply) { replies.push_back(reply); });
    sender.connect([&](Json frame) { sent.push_back(frame); });
    sender.submit({{"id", 1}, {"method", "turn/start"}, {"params", Json::object()}});
    check(sent.size() == 1, "No mutation is sent before receiver credit");
    const auto exchange = sent.back().at("exchangeId");
    sender.receive({{"type", "delivery-window"},
                    {"exchangeId", exchange},
                    {"lane", "priority"},
                    {"window",
                     {{"stream", "priority"},
                      {"instance", "journal"},
                      {"received", 0},
                      {"receivedBytes", 0},
                      {"credit", 4},
                      {"byteCredit", 262144}}}});
    sender.receive({{"type", "delivery-window"},
                    {"exchangeId", exchange},
                    {"lane", "normal"},
                    {"window",
                     {{"stream", "receiver"},
                      {"instance", "journal"},
                      {"received", 0},
                      {"receivedBytes", 0},
                      {"credit", 1},
                      {"byteCredit", 262144}}}});
    check(sent.back()["type"] == "delivery-command", "Native sender sends within credit");
    const auto frame = sent.back();
    const auto result_body = Json{{"id", 1}, {"result", {{"ok", true}}}}.dump();
    sender.receive({{"type", "delivery-result"},
                    {"lane", "normal"},
                    {"seq", 1},
                    {"resultStream", "receiver_r"},
                    {"resultSeq", 1},
                    {"resultEnd", result_body.size()},
                    {"resultBody", result_body},
                    {"resultDigest", delivery_digest(result_body)},
                    {"window",
                     {{"stream", "receiver"},
                      {"instance", "journal"},
                      {"received", 1},
                      {"receivedBytes", frame["end"]},
                      {"sent", 1},
                      {"resultBytes", result_body.size()},
                      {"credit", 2},
                      {"byteCredit", 262144}}}});
    check(replies.size() == 1 && !sender.pending(), "Native command completes durably");
    {
      sender.submit({{"id", 2}, {"method", "turn/start"}});
      const auto command_frame = sent.back();
      const auto content = Json{{"id", 2}, {"result", std::string(300000, 'x')}}.dump();
      const auto digest = delivery_digest(content);
      const auto descriptor =
          Json{{"type", "delivery-content"}, {"retention", "transfer"}, {"revision", 1},
               {"contentId", digest},        {"digest", digest},        {"length", content.size()}}
              .dump();
      Json result_window = {{"stream", "receiver"},
                            {"instance", "journal"},
                            {"received", 2},
                            {"receivedBytes", command_frame.at("end")},
                            {"sent", 2},
                            {"resultBytes", result_body.size() + descriptor.size()},
                            {"credit", 3},
                            {"byteCredit", 2 * 1024 * 1024}};
      Json result_frame = {{"type", "delivery-result"},
                           {"lane", "normal"},
                           {"seq", 2},
                           {"resultStream", "receiver_r"},
                           {"resultSeq", 2},
                           {"resultEnd", result_body.size() + descriptor.size()},
                           {"resultBody", descriptor},
                           {"resultDigest", delivery_digest(descriptor)},
                           {"window", result_window}};
      sender.receive(result_frame);
      const auto receipt = std::find_if(sent.rbegin(), sent.rend(), [](const Json &frame) {
        return frame.value("type", "") == "delivery-receipt";
      });
      check(sender.pending() && replies.size() == 1 && receipt != sent.rend() &&
                receipt->at("received") == 1,
            "A transfer descriptor alone cannot retire a command or acknowledge its result");
      for (size_t offset = 0; offset < content.size();) {
        const auto part = content.substr(offset, 16384);
        sender.receive({{"type", "delivery-window"},
                        {"lane", "normal"},
                        {"window", result_window},
                        {"content",
                         {{"resultSeq", 2},
                          {"offset", offset},
                          {"next", offset + part.size()},
                          {"length", content.size()},
                          {"body", part}}}});
        offset += part.size();
      }
      check(!sender.pending() && replies.size() == 2,
            "Native receiver applies a large result after the entire content is verified");
      const auto durable = journal.cache_get("sender:v2")["normal"]["results"];
      check(durable["received"] == 2 && durable["cache"][1]["content"] == content,
            "Full transfer content is durable before result acknowledgment");
      sender.receive(result_frame);
      check(replies.size() == 2 && sent.back()["received"] == 2,
            "Duplicate transfer result repeats its ACK without fetching or applying again");
    }
    {
      std::vector<Json> frames;
      CommandDelivery recovering(journal, "recovery-sender", [](Json) {});
      auto transport = [&](Json frame) { frames.push_back(frame); };
      auto snapshot = [&](const std::string &lane, const Json &exchange_id, int64_t received,
                          int64_t bytes, int64_t credit) {
        return recovering.receive({{"type", "delivery-window"},
                                   {"exchangeId", exchange_id},
                                   {"lane", lane},
                                   {"window",
                                    {{"stream", lane},
                                     {"instance", "journal"},
                                     {"received", received},
                                     {"receivedBytes", bytes},
                                     {"credit", credit},
                                     {"byteCredit", 262144}}}});
      };
      recovering.connect(transport);
      const auto old_exchange = frames.back().at("exchangeId");
      recovering.submit({{"id", 7}, {"method", "turn/start"}});
      check(journal.cache_get("recovery-sender:v2")["normal"]["next"] == 0,
            "Uncredited commands are durable without consuming a sequence");
      snapshot("normal", old_exchange, 0, 0, 1);
      check(frames.size() == 1, "Recovery freezes publication until both lanes respond");
      snapshot("priority", old_exchange, 0, 0, 4);
      const auto published = frames.back();
      check(published["type"] == "delivery-command" && published["seq"] == 1,
            "Publication uses the first sequence after credit commits");
      auto ack = Json{{"type", "delivery-window"},
                      {"lane", "normal"},
                      {"window",
                       {{"stream", "normal"},
                        {"instance", "journal"},
                        {"received", 1},
                        {"receivedBytes", published["end"]},
                        {"credit", 3},
                        {"byteCredit", 262144}}}};
      recovering.receive(ack);
      auto stale = ack;
      stale["window"]["received"] = 0;
      stale["window"]["receivedBytes"] = 0;
      recovering.receive(stale);
      check(journal.cache_get("recovery-sender:v2")["normal"]["received"] == 1,
            "Online old ACKs cannot roll back durable progress");
      auto corrupt = ack;
      corrupt["window"]["receivedBytes"] = published["end"].get<int64_t>() - 1;
      rejects([&] { recovering.receive(corrupt); }, "INVALID_REQUEST");
      recovering.disconnect();
      recovering.connect(transport);
      const auto current_exchange = frames.back().at("exchangeId");
      check(current_exchange != old_exchange, "Reconnect gets a fresh recovery identity");
      rejects(
          [&] {
            recovering.receive({{"type", "delivery-window"},
                                {"exchangeId", current_exchange},
                                {"lane", "normal"},
                                {"window",
                                 {{"stream", "foreign"},
                                  {"instance", "journal"},
                                  {"received", 1},
                                  {"receivedBytes", published["end"]},
                                  {"credit", 3},
                                  {"byteCredit", 262144}}}});
          },
          "INVALID_REQUEST");
      snapshot("normal", old_exchange, 0, 0, 1);
      recovering.receive(stale);
      check(!recovering.ready(), "Old snapshots and online ACKs cannot open a new connection");
      rejects([&] { snapshot("normal", current_exchange, 0, 0, 1); }, "DELIVERY_STATE_MISMATCH");
      rejects([&] { recovering.submit({{"id", 8}, {"method", "turn/start"}}); },
              "DELIVERY_STATE_MISMATCH");
    }
    {
      std::vector<Json> frames;
      CommandDelivery resetting(journal, "reset-sender", [](Json) {});
      resetting.connect([&](Json frame) { frames.push_back(frame); });
      auto reset = Json{{"type", "delivery-reset"},
                        {"exchangeId", "retired"},
                        {"lane", "normal"},
                        {"error", {{"code", "RESULT_UNAVAILABLE"}}}};
      resetting.receive(reset);
      reset["exchangeId"] = frames.back().at("exchangeId");
      rejects([&] { resetting.receive(reset); }, "DELIVERY_STATE_MISMATCH");
      rejects([&] { resetting.connect([](Json) {}); }, "DELIVERY_STATE_MISMATCH");
    }
    auto first =
        journal.output_append("output", {{"method", "event"}, {"params", {{"text", "one"}}}});
    journal.output_append("output", {{"method", "event"}, {"params", {{"text", "two"}}}});
    rejects([&] { journal.output_ack("output", 1); }, "INVALID_REQUEST");
    journal.output_publish("output", 2);
    check(journal.output_page("output", 0).size() == 2, "Unacknowledged outputs can replay");
    rejects([&] { journal.output_ack("output", 1, 0); }, "INVALID_REQUEST");
    check(journal.output_page("output", 0).size() == 2, "Invalid credit cannot discard output");
    journal.output_ack("output", 1);
    check(journal.output_state("output")["acked_bytes"] == first["end"],
          "Byte credit follows contiguous receipts");
    rejects([&] { journal.output_page("output", 0); }, "DELIVERY_STATE_MISMATCH");
    check(journal.output_page("output", 1).size() == 1,
          "Confirmed outputs leave the replay buffer");
  }

  {
    Temp dir;
    const std::string body = "{\"action\":\"interrupt\",\"requestId\":\"one\"}";
    const auto body2 = Json{{"action", "interrupt"}, {"requestId", "two"}}.dump();
    const auto body3 = Json{{"action", "interrupt"}, {"requestId", "six"}}.dump();
    {
      Store journal(dir.path);
      check(journal.delivery_open("stream", "session", 2, max_frame)["credit"] == 2,
            "Receiver grants a bounded initial window");
      rejects([&] { journal.delivery_receive("stream", 2, body.size(), body); }, "DELIVERY_GAP");
      check(journal.delivery_receive("stream", 1, body.size(), body)["accepted"] == true,
            "Command is durable before acknowledgment");
      check(journal.delivery_receive("stream", 1, body.size(), body)["accepted"] == false,
            "Duplicate sequence does not execute again");
      rejects([&] { journal.delivery_receive("stream", 1, body.size() + 1, body + " "); },
              "IDEMPOTENCY_CONFLICT");
      journal.delivery_receive("stream", 2, body.size() * 2, body2);
      rejects([&] { journal.delivery_receive("stream", 3, body.size() * 3, body3); },
              "BACKPRESSURE");
      check(journal.delivery_start("stream", 1), "Received command starts once");
      check(!journal.delivery_start("stream", 1), "Started command never starts twice");
    }
    {
      Store journal(dir.path);
      check(journal.delivery_record("stream", 1)["result"]["error"]["code"] == "RESULT_UNKNOWN",
            "Restart does not replay uncertain side effects");
      check(journal.delivery_record("stream", 2)["result"]["error"]["code"] == "SESSION_CLOSED",
            "Unstarted commands fail explicitly after runtime loss");
      check(journal.delivery_record("stream", 1)["result"]["requestId"] == "one" &&
                journal.delivery_record("stream", 2)["result"]["requestId"] == "two",
            "Restart terminal results preserve the original web request identity");
      check(journal.delivery_window("stream")["credit"] == 2,
            "Unacknowledged terminal results still consume their reserved slots");
      const auto completed = journal.delivery_result_state("stream");
      journal.delivery_result_ack("stream", completed.at("sent"), completed.at("sent_bytes"));
      check(journal.delivery_window("stream")["credit"] == 4,
            "Result acknowledgment releases command and result capacity");
      journal.delivery_receive("stream", 3, body.size() * 3, body3);
      journal.delivery_start("stream", 3);
      journal.delivery_finish("stream", 3, {{"ok", true}});
      check(journal.delivery_receive("stream", 3, body.size() * 3,
                                     body3)["record"]["result"]["ok"] == true,
            "Completed command result replays after lost acknowledgement");
    }
  }

  {
    Temp dir;
    Store journal(dir.path);
    const auto body = Json{{"id", 1}, {"method", "turn/start"}}.dump();
    journal.delivery_open("results", "session", 2, max_frame);
    journal.delivery_receive("results", 1, body.size(), body);
    journal.delivery_receive("results", 2, body.size() * 2,
                             Json{{"id", 2}, {"method", "turn/start"}}.dump());
    journal.delivery_finish("results", 2, {{"id", 2}, {"result", "second completed first"}});
    journal.delivery_finish("results", 1, {{"id", 1}, {"result", "first completed second"}});
    auto first = journal.delivery_record("results", 2);
    auto second = journal.delivery_record("results", 1);
    check(first["resultSeq"] == 1 && second["resultSeq"] == 2,
          "Results allocate sequence by completion order, not command sequence");
    rejects(
        [&] { journal.delivery_result_ack("results", 1, first["resultEnd"].get<int64_t>() - 1); },
        "INVALID_REQUEST");
    rejects([&] { journal.delivery_result_ack("results", 3, second["resultEnd"]); },
            "INVALID_REQUEST");
    journal.delivery_result_ack("results", 1, first["resultEnd"]);
    check(journal.delivery_record("results", 2)["resultBody"].is_null(),
          "Acknowledged result body is retired");
    check(!journal.delivery_record("results", 1)["resultBody"].is_null(),
          "Acknowledging command two does not discard command one's later completion");
    journal.delivery_finish("results", 2, {{"result", "cannot replace committed identity"}});
    check(journal.delivery_result_state("results")["sent"] == 2,
          "A duplicate completion cannot allocate another result sequence");
    check(journal.delivery_results("results", 1)[0]["seq"] == 1,
          "Result page recovers the remaining completion");
    rejects([&] { journal.delivery_results("results", 0); }, "DELIVERY_STATE_MISMATCH");
    rejects([&] { journal.delivery_scope("results", "another-session"); }, "FORBIDDEN");
  }

  {
    Temp dir;
    const auto body = Json{{"method", "event"}, {"params", "durable before TUI"}}.dump();
    const std::string key = "/ws/v1/cli/session:output:v2";
    {
      Store journal(dir.path, false);
      auto accepted = journal.output_receive(key, 1, body.size(), body, "instance");
      check(accepted["accepted"] == true && accepted["state"]["cache"][0]["body"] == body,
            "Complete output and receive prefix commit together before TUI delivery");
      rejects([&] { journal.output_receive(key, 3, body.size() * 2, body, "instance"); },
              "DELIVERY_GAP");
      rejects([&] { journal.output_receive(key, 1, body.size(), body, "replaced"); },
              "DELIVERY_STATE_MISMATCH");
      journal.cache_clear();
    }
    {
      Store journal(dir.path, false);
      check(journal.cache_get(key)["cache"][0]["body"] == body,
            "An output lost before TUI delivery survives receiver restart and cache clearing");
      check(journal.output_receive(key, 1, body.size(), body, "instance")["accepted"] == false,
            "Lost output receipt repeats ACK without delivering the output twice");
      rejects([&] { journal.output_receive(key, 1, body.size(), body + " ", "instance"); },
              "IDEMPOTENCY_CONFLICT");
      journal.output_consumed(key, 1);
      check(journal.cache_get(key)["cache"][0]["consumed"] == true,
            "TUI consumption is separate from durable receive confirmation");
    }
  }
  {
    Temp dir;
    Store journal(dir.path);
    journal.delivery_open("large-result", "session", 1, max_frame);
    journal.delivery_receive("large-result", 1, 2, "{}");
    const auto content = Json{{"id", 1}, {"result", std::string(300000, 'x')}};
    const auto full_body = content.dump();
    journal.delivery_finish("large-result", 1, content);
    auto record = journal.delivery_record("large-result", 1);
    const auto descriptor = Json::parse(record["resultBody"].get<std::string>());
    check(descriptor["retention"] == "transfer" &&
              descriptor["digest"] == delivery_digest(full_body),
          "Large results use immutable, verified content descriptors");
    std::string received;
    while (received.size() < full_body.size()) {
      const auto chunk = journal.delivery_content("large-result", 1, received.size());
      check(chunk.dump().size() < max_frame && chunk["offset"] == received.size(),
            "Content chunks stay within frame and byte boundaries");
      received += chunk["body"].get<std::string>();
    }
    check(received == full_body, "Content remains complete before result acknowledgment");
    journal.delivery_result_ack("large-result", 1, record["resultEnd"]);
    rejects([&] { journal.delivery_content("large-result", 1, 0); }, "CONTENT_UNAVAILABLE");
  }

  {
    Temp dir;
    {
      Store local(dir.path, false);
      const auto count = credit::local_command_budget / credit::local_command_reservation;
      for (int64_t i = 0; i < count; ++i) {
        local.local_reserve("command-" + std::to_string(i), "command");
        local.cache_put("command-" + std::to_string(i), {{"kept", i}});
      }
      local.local_reserve("command-0", "command");
      check(local.local_budget().at("command").at("reserved") == credit::local_command_budget,
            "Local command reservations are global and a duplicate does not charge twice");
      rejects([&] { local.local_reserve("another-command", "command"); }, "BACKPRESSURE");
      local.local_reserve("output", "output");
      check(local.local_budget().at("output").at("reserved") == credit::local_output_reservation,
            "Command exhaustion cannot consume the output receive reservation");
      rejects(
          [&] { local.cache_put("output", std::string(credit::local_output_reservation, 'x')); },
          "BACKPRESSURE");
      check(local.cache_get("output").is_null(), "An oversized local write never commits");
      local.cache_clear();
    }
    Store recovered(dir.path, false);
    check(recovered.local_budget().at("command").at("reserved") == credit::local_command_budget,
          "Restart and cache clearing cannot silently revoke an issued local reservation");
    rejects([&] { recovered.local_reserve("another-command", "command"); }, "BACKPRESSURE");
    Store other_identity(dir.path, false, "another-identity:");
    rejects([&] { other_identity.local_reserve("command-0", "command"); }, "BACKPRESSURE");
    check(other_identity.cache_get("command-0").is_null(),
          "Credentials share reservation accounting without sharing their outbox contents");
  }
  {
    Temp dir;
    Store first(dir.path, false, "first:"), second(dir.path, false, "second:");
    first.cache_put("page", {{"from", "first"}});
    second.cache_put("page", {{"from", "second"}});
    first.local_reserve("commands", "command");
    second.local_reserve("commands", "command");
    first.cache_put("commands", {{"pending", 1}});
    second.cache_put("commands", {{"pending", 2}});
    first.cache_clear();
    check(first.cache_get("page").is_null() && second.cache_get("page").at("from") == "second" &&
              first.cache_get("commands").at("pending") == 1 &&
              second.cache_get("commands").at("pending") == 2,
          "Clearing a credential's history preserves all promised outboxes and other identities");
    const auto text = std::string(3 * 1024 * 1024, 'x');
    for (int i = 0; i < 5; ++i)
      first.cache_put("large-" + std::to_string(i), text);
    rejects([&] { first.cache_put("large-5", text); }, "BACKPRESSURE");
    check(first.cache_get("large-5").is_null(), "A rejected scoped cache write never commits");
    first.cache_clear();
    for (int i = 0; i < 5; ++i)
      second.cache_put("large-" + std::to_string(i), text);
    bool full = false;
    for (int scope = 0; scope < 8 && !full; ++scope) {
      Store more(dir.path, false, "identity-" + std::to_string(scope) + ":");
      for (int i = 0; i < 5; ++i) {
        try {
          more.cache_put("large-" + std::to_string(i), text);
        } catch (const Error &error) {
          check(error.code == "BACKPRESSURE", "Ordinary caches share the real global quota");
          full = true;
          break;
        }
      }
    }
    check(full && second.local_budget().at("cache").at("bytes") <= credit::cache_budget,
          "Extra credentials cannot multiply ordinary cache storage");
    first.cache_put("commands", {{"pending", "still reserved"}});
    check(first.cache_get("commands").at("pending") == "still reserved",
          "Ordinary cache exhaustion cannot borrow a previously promised command reservation");
  }
  {
    Temp dir;
    Store local(dir.path, false);
    const auto body = Json{{"method", "notification"}}.dump();
    for (int64_t seq = 1; seq <= 32; ++seq)
      local.output_receive("slow-tui", seq, seq * body.size(), body, "instance");
    rejects([&] { local.output_receive("slow-tui", 33, 33 * body.size(), body, "instance"); },
            "BACKPRESSURE");
    local.output_consumed("slow-tui", 2);
    check(local.cache_get("slow-tui").value("consumed", 0) == 0,
          "Out-of-order consumption cannot grant credit beyond an undelivered prefix");
    local.output_consumed("slow-tui", 1);
    check(local.cache_get("slow-tui").at("consumed") == 2,
          "Only the continuous consumed prefix releases receive credit");
    local.output_receive("slow-tui", 33, 33 * body.size(), body, "instance");
    local.output_receive("slow-tui", 34, 34 * body.size(), body, "instance");
    rejects([&] { local.output_receive("slow-tui", 35, 35 * body.size(), body, "instance"); },
            "BACKPRESSURE");
  }
  {
    Temp dir;
    Store journal(dir.path);
    const Json payload = {{"method", "notification"}, {"params", std::string(240 * 1024, 'x')}};
    int count = 0;
    for (;;) {
      try {
        journal.output_append("bounded-output", payload);
        ++count;
      } catch (const Error &error) {
        check(error.code == "BACKPRESSURE", "A slow output stream ends at its durable quota");
        break;
      }
    }
    check(count > 0 && count < 40 && journal.output_state("bounded-output").at("sent") == count,
          "Rejected output does not advance its durable sequence");
    journal.output_publish("bounded-output", count);
    journal.output_ack("bounded-output", 1);
    check(journal.output_append("bounded-output", payload).at("seq") == count + 1,
          "Only the acknowledged continuous prefix releases output storage");
    for (int i = 0; i < 12; ++i) {
      try {
        for (int j = 0; j < count; ++j)
          journal.output_append("output-" + std::to_string(i), payload);
      } catch (const Error &error) {
        check(error.code == "BACKPRESSURE" && i < 12,
              "Many streams share the output budget instead of multiplying it");
        break;
      }
      check(i < 11, "The global output budget must stop new output");
    }
  }

  {
    Temp dir;
    Store journal(dir.path);
    std::vector<Json> frames;
    CommandDelivery sender(journal, "controlled-sender", [](Json) {});
    const auto proof = Json{{"controlEpoch", 2},
                            {"connectionGeneration", 9},
                            {"controlId", "claim"},
                            {"owner", "owner"}};
    sender.connect([&](Json frame) { frames.push_back(frame); }, proof);
    sender.submit({{"id", 1}, {"method", "turn/start"}, {"params", Json::object()}});
    sender.submit({{"id", 71}, {"method", "turn/start"}});
    check(sender.cancel_unpublished(71),
          "Cancel a request before an approval reuses its numeric ID");
    const auto exchange = frames.back().at("exchangeId");
    auto snapshot = Json{{"type", "delivery-window"},
                         {"exchangeId", exchange},
                         {"lane", "normal"},
                         {"window",
                          {{"stream", "normal"},
                           {"instance", "journal"},
                           {"received", 0},
                           {"receivedBytes", 0},
                           {"credit", 2},
                           {"byteCredit", 262144}}}};
    rejects([&] { sender.receive(snapshot); }, "STALE_CONTROLLER");
    auto ready = proof;
    ready["instance"] = "journal";
    ready["exchangeId"] = exchange;
    snapshot["controlReady"] = ready;
    snapshot["controlReady"]["connectionGeneration"] = 8;
    rejects([&] { sender.receive(snapshot); }, "STALE_CONTROLLER");
    snapshot["controlReady"] = ready;
    snapshot["window"]["streamSerial"] = 1;
    snapshot["window"]["creditGeneration"] = "normal-generation";
    sender.receive(snapshot);
    check(frames.size() == 1 && !sender.ready(), "One ready lane cannot publish a command");
    snapshot["lane"] = "priority";
    snapshot["window"]["stream"] = "priority";
    snapshot["window"]["streamSerial"] = 2;
    snapshot["window"]["creditGeneration"] = "priority-generation";
    sender.receive(snapshot);
    check(sender.ready() && frames.back()["type"] == "delivery-command",
          "Both matching Agent confirmations admit business publication");
    const auto task = Json{{"controlEpoch", 2},    {"instance", "journal"}, {"owner", "owner"},
                           {"requestId", "rpc:1"}, {"stream", "normal"},    {"turnId", "turn-one"}};
    auto wrong_task = task;
    wrong_task["instance"] = "other-journal";
    rejects([&] { sender.observe({{"coc", {{"task", wrong_task}}}}); }, "DELIVERY_STATE_MISMATCH");
    sender.observe({{"method", "turn/started"}, {"coc", {{"task", task}}}});
    rejects(
        [&] {
          sender.submit(
              {{"id", 2}, {"method", "turn/interrupt"}, {"params", {{"turnId", "another-turn"}}}});
        },
        "TARGET_NOT_FOUND");
    sender.submit({{"id", 2}, {"method", "turn/interrupt"}, {"params", {{"turnId", "turn-one"}}}});
    check(frames.back().at("lane") == "priority" &&
              Json::parse(frames.back().at("body").get<std::string>()).at("coc").at("target") ==
                  task,
          "Native interruptions carry the exact persisted original task and turn binding");
    const auto approval = Json{{"instance", "journal"},
                               {"runtimeId", "runtime"},
                               {"approvalVersion", "first"},
                               {"requestId", 71}};
    auto stale = approval;
    stale["instance"] = "another-journal";
    rejects([&] { sender.observe({{"id", 71}, {"coc", {{"approval", stale}}}}); },
            "DELIVERY_STATE_MISMATCH");
    rejects([&] { sender.submit({{"id", 71}, {"result", {{"decision", "accept"}}}}); },
            "TARGET_NOT_FOUND");
    sender.observe({{"id", 71}, {"coc", {{"approval", approval}}}});
    sender.submit({{"id", 71}, {"result", {{"decision", "accept"}}}});
    check(Json::parse(frames.back().at("body").get<std::string>()).at("coc").at("approval") ==
              approval,
          "CLI replies persist their exact original approval proof");
    auto next = approval;
    next["approvalVersion"] = "second";
    check(delivery_request_key({{"id", 71}, {"coc", {{"approval", approval}}}}) !=
              delivery_request_key({{"id", 71}, {"coc", {{"approval", next}}}}),
          "Reused server request IDs are separated by original approval version");
    sender.disconnect();
    CommandDelivery changed(journal, "controlled-sender", [](Json) {});
    changed.connect([&](Json frame) { frames.push_back(frame); }, proof);
    snapshot["exchangeId"] = frames.back().at("exchangeId");
    snapshot["controlReady"]["exchangeId"] = frames.back().at("exchangeId");
    snapshot["lane"] = "normal";
    snapshot["window"]["stream"] = "normal";
    snapshot["window"]["streamSerial"] = 1;
    snapshot["window"]["creditGeneration"] = "changed-generation";
    rejects([&] { changed.receive(snapshot); }, "DELIVERY_STATE_MISMATCH");
    auto takeover = proof;
    takeover["controlEpoch"] = 3;
    takeover["controlId"] = "next-claim";
    rejects([&] { sender.connect([](Json) {}, takeover); }, "STREAM_CLOSED");
  }

  for (const auto &retired : {"closed", "exhausted"}) {
    Temp dir;
    Store journal(dir.path, false);
    std::vector<Json> frames, results;
    CommandDelivery sender(journal, "retired-sender",
                           [&](Json result) { results.push_back(result); });
    auto connect = [&] {
      sender.connect([&](Json frame) { frames.push_back(frame); });
      const auto exchange = frames.back().at("exchangeId");
      for (const auto &lane : {"priority", "normal"}) {
        const auto state = journal.cache_get("retired-sender:v2").at(lane);
        sender.receive({{"type", "delivery-window"},
                        {"exchangeId", exchange},
                        {"lane", lane},
                        {"window",
                         {{"stream", lane},
                          {"instance", "journal"},
                          {"received", state.at("received")},
                          {"receivedBytes", state.value("receivedBytes", int64_t(0))},
                          {"credit", 1},
                          {"byteCredit", 262144},
                          {retired, state.value(retired, false)}}}});
      }
    };
    connect();
    sender.submit({{"id", 1}, {"method", "turn/start"}});
    const auto published = frames.back();
    auto window = Json{{"stream", "normal"}, {"instance", "journal"},
                       {"received", 1},      {"receivedBytes", published.at("end")},
                       {"credit", 1},        {"byteCredit", 262144},
                       {"sent", 1},          {"resultBytes", 4096},
                       {retired, true}};
    sender.receive({{"type", "delivery-window"}, {"lane", "normal"}, {"window", window}});
    rejects([&] { sender.submit({{"id", 2}, {"method", "turn/start"}}); }, "STREAM_CLOSED");
    check(sender.pending(), "Retiring admission does not discard an admitted pending result");
    connect();
    check(frames.back().at("type") == "delivery-query",
          "Closed or exhausted flow recovery queries the original admitted command");
    const auto body = Json{{"id", 1}, {"result", true}}.dump();
    sender.receive({{"type", "delivery-result"},
                    {"lane", "normal"},
                    {"seq", 1},
                    {"resultSeq", 1},
                    {"resultStream", "normal_r"},
                    {"resultEnd", body.size()},
                    {"resultBody", body},
                    {"resultDigest", delivery_digest(body)},
                    {"window", window}});
    check(results.size() == 1 && !sender.pending(), "Final results of a retired allocation commit "
                                                    "and acknowledge before recovery becomes idle");
  }

  {
    Temp dir;
    const auto body = Json{{"id", 71}, {"method", "turn/start"}}.dump();
    {
      Store journal(dir.path);
      journal.delivery_open("restart-rpc", "session", 2, max_frame);
      journal.delivery_receive("restart-rpc", 1, body.size(), body);
      journal.delivery_start("restart-rpc", 1);
    }
    Store journal(dir.path);
    const auto result = journal.delivery_record("restart-rpc", 1).at("result");
    check(result.at("id") == 71 && result.at("error").at("data").at("code") == "RESULT_UNKNOWN",
          "Restart terminal results preserve the original RPC identity and uncertainty");
  }

  {
    Temp dir;
    Store journal(dir.path);
    std::vector<Json> frames;
    std::vector<Json> local_results;
    CommandDelivery sender(journal, "local-cancel",
                           [&](Json result) { local_results.push_back(result); });
    sender.connect([&](Json frame) { frames.push_back(frame); });
    const auto command = Json{{"id", 5}, {"method", "turn/start"}};
    sender.submit(command);
    check(sender.cancel_unpublished(5),
          "Native local cancellation retires unpublished work without transport seq");
    check(!sender.pending() && frames.size() == 1,
          "Local cancellation emits no remote command or cancellation");
    rejects([&] { sender.submit(command); }, "CANCELLED_BEFORE_START");
    sender.submit({{"id", 6}, {"method", "turn/start"}});
    sender.submit({{"method", "$/cancelRequest"}, {"params", {{"requestId", 6}}}});
    check(local_results.size() == 1 && local_results.at(0).at("id") == 6 &&
              local_results.at(0).at("error").at("data").at("code") == "CANCELLED_BEFORE_START" &&
              journal.cache_get("local-cancel:v2")["normal"]["next"] == 0 && !sender.pending(),
          "TUI cancellation atomically retires unpublished work and resolves only that request");
    CommandDelivery restored(journal, "local-cancel", [](Json) {});
    check(!restored.pending(), "Native unpublished cancellation survives sender reconstruction");
    rejects([&] { restored.submit(command); }, "CANCELLED_BEFORE_START");
    check(delivery_request_key({{"id", 1}, {"method", "turn/start"}}) !=
                  delivery_request_key({{"id", "1"}, {"method", "turn/start"}}) &&
              delivery_request_key({{"id", 1}}) !=
                  delivery_request_key({{"id", 1}, {"method", "turn/start"}}),
          "Target identity preserves JSON id type and separates approval replies from requests");
    for (int id = 7; id < 77; ++id) {
      sender.submit({{"id", id}, {"method", "turn/start"}});
      check(sender.cancel_unpublished(id), "Cancel the original unpublished request");
    }
    const auto trimmed = journal.cache_get("local-cancel:v2");
    check(trimmed.at("cancelled").size() == 64 && trimmed.at("cancelledKeys").size() == 72,
          "Diagnostic trimming does not discard permanent cancellation identities");
    CommandDelivery after_trim(journal, "local-cancel", [](Json) {});
    rejects([&] { after_trim.submit(command); }, "CANCELLED_BEFORE_START");
    after_trim.submit({{"id", "5"}, {"method", "turn/start"}});
    check(after_trim.cancel_unpublished("5"), "Cancellation identities preserve JSON ID types");
    auto full = journal.cache_get("local-cancel:v2");
    full["cancelledKeys"] = Json::array();
    for (int i = 0; i < 1024; ++i)
      full["cancelledKeys"].push_back(delivery_digest("retired-" + std::to_string(i)));
    journal.cache_put("local-cancel:v2", full);
    CommandDelivery limited(journal, "local-cancel", [](Json) {});
    limited.submit({{"id", 9999}, {"method", "turn/start"}});
    rejects([&] { limited.cancel_unpublished(9999); }, "BACKPRESSURE");
    check(limited.pending() &&
              journal.cache_get("local-cancel:v2").at("cancelledKeys").size() == 1024,
          "Exhausted cancellation capacity refuses the change without losing queued work");
  }

  {
    Temp dir;
    Json target;
    const auto command =
        Json{{"action", "prompt"}, {"requestId", "cancelled"}, {"text", "never run"}}.dump();
    {
      Store journal(dir.path);
      journal.control_apply("session", 1, "claim", "owner");
      journal.delivery_open("normal-cancel", "session", 16, 2 * 1024 * 1024);
      journal.delivery_bind("normal-cancel", 1, "claim");
      target = {{"instance", journal.delivery_instance()},
                {"stream", "normal-cancel"},
                {"controlEpoch", 1},
                {"owner", "owner"},
                {"requestId", "web:cancelled"}};
      auto wrong = target;
      wrong["owner"] = "someone-else";
      rejects([&] { journal.delivery_cancel("session", wrong); }, "TARGET_NOT_FOUND");
      wrong = target;
      wrong["controlEpoch"] = 2;
      rejects([&] { journal.delivery_cancel("session", wrong); }, "TARGET_NOT_FOUND");
      rejects([&] { journal.delivery_cancel("other-session", target); }, "TARGET_NOT_FOUND");
      check(journal.delivery_cancel("session", target).at("state") == "pending-target",
            "Cancellation may arrive before its target command");
      check(journal.delivery_cancel("session", target).at("state") == "pending-target",
            "Duplicate cancellation consumes no additional marker");
    }
    Store journal(dir.path);
    const auto received = journal.delivery_receive("normal-cancel", 1, command.size(), command);
    check(received.at("accepted") == true && received.at("window").at("received") == 1,
          "A late cancelled command still fills its original transport prefix");
    const auto record = received.at("record");
    check(record.at("phase") == "finished" && record.at("result").at("requestId") == "cancelled" &&
              record.at("result").at("error").at("code") == "CANCELLED_BEFORE_START" &&
              !record.at("resultSeq").is_null(),
          "Restart preserves cancel-before-arrival and journals its identified terminal result "
          "atomically");
    check(!journal.delivery_start("normal-cancel", 1),
          "The late cancelled command never crosses the start boundary");
    check(journal.delivery_receive("normal-cancel", 1, command.size(), command).at("accepted") ==
              false,
          "Duplicate late commands return the immutable terminal record");
    rejects([&] { journal.delivery_receive("normal-cancel", 2, command.size() * 2, command); },
            "IDEMPOTENCY_CONFLICT");
    const auto queued = Json{{"action", "prompt"}, {"requestId", "queued"}}.dump();
    journal.delivery_receive("normal-cancel", 2, command.size() + queued.size(), queued);
    const auto queued_target = journal.delivery_target("normal-cancel", 2);
    check(journal.delivery_cancel("session", queued_target)
                  .at("record")
                  .at("result")
                  .at("error")
                  .at("code") == "CANCELLED_BEFORE_START",
          "A received command can be durably cancelled before dispatch");
    const auto started = Json{{"id", 7}, {"method", "turn/start"}}.dump();
    journal.delivery_receive("normal-cancel", 3, command.size() + queued.size() + started.size(),
                             started);
    journal.delivery_start("normal-cancel", 3);
    const auto started_target = journal.delivery_target("normal-cancel", 3);
    check(started_target.at("requestId") == "rpc:7" &&
              journal.delivery_cancel("session", started_target).at("state") == "started",
          "Cancelling started work requests exact execution-side interruption without declaring it "
          "stopped");
    check(journal.delivery_record("normal-cancel", 3).at("phase") == "started",
          "Cancellation cannot manufacture a started task's terminal result");
    journal.delivery_finish("normal-cancel", 3, {{"id", 7}, {"result", {{"actual", true}}}});
    check(journal.delivery_cancel("session", started_target)
                  .at("record")
                  .at("result")
                  .at("result")
                  .at("actual") == true,
          "Completed targets retain their actual result");
    for (int i = 0; i < 4; ++i) {
      target["requestId"] = "web:unknown-" + std::to_string(i);
      journal.delivery_cancel("session", target);
    }
    target["requestId"] = "web:overflow";
    rejects([&] { journal.delivery_cancel("session", target); }, "BACKPRESSURE");
    journal.control_apply("session", 2, "next-claim", "owner");
    rejects([&] { journal.delivery_cancel("session", target); }, "STREAM_CLOSED");
    journal.delivery_open("next-normal", "session", 2, max_frame);
    journal.delivery_bind("next-normal", 2, "next-claim");
    target["stream"] = "next-normal";
    target["controlEpoch"] = 2;
    check(journal.delivery_cancel("session", target).at("state") == "pending-target",
          "Retired flow markers release capacity only after late writes are fenced");
  }

  {
    Temp dir;
    Store journal(dir.path);
    journal.control_apply("session", 1, "claim", "owner");
    Json last;
    size_t markers = 0;
    bool bounded = false;
    std::string last_session;
    for (int flow = 0; flow < 40 && !bounded; ++flow) {
      const auto stream = "cancel-budget-" + std::to_string(flow);
      const auto session = "marker-session-" + std::to_string(flow);
      journal.control_apply(session, 1, "claim", "owner");
      journal.delivery_open(stream, session, 4, max_frame);
      journal.delivery_bind(stream, 1, "claim");
      for (int request = 0; request < 4; ++request) {
        const auto target =
            Json{{"instance", journal.delivery_instance()},
                 {"stream", stream},
                 {"controlEpoch", 1},
                 {"owner", "owner"},
                 {"requestId", "web:" + std::string(480, 'x') + std::to_string(request)}};
        try {
          journal.delivery_cancel(session, target);
          ++markers;
          last = target;
          last_session = session;
        } catch (const Error &error) {
          check(error.code == "BACKPRESSURE", "Only bounded marker exhaustion ends allocation");
          bounded = true;
          break;
        }
      }
    }
    check(bounded && markers > 4 && markers <= 128,
          "Many flows share a bounded cancellation marker count and byte pool");
    check(journal.delivery_cancel(last_session, last).at("state") == "pending-target",
          "Duplicate cancellation remains idempotent at the global budget limit");
  }

  {
    Temp dir;
    const std::string body = "{}";
    Json ready;
    {
      Store journal(dir.path);
      const auto first = journal.control_apply("controlled", 1, "claim-one", "owner-one");
      journal.delivery_open("controlled-normal", "controlled", 4, max_frame);
      journal.delivery_open("controlled-priority", "controlled", 4, max_frame);
      journal.delivery_bind("controlled-normal", 1, "claim-one");
      journal.delivery_bind("controlled-priority", 1, "claim-one");
      journal.delivery_receive("controlled-normal", 1, 2, body);
      journal.delivery_receive("controlled-normal", 2, 4, body);
      journal.delivery_receive("controlled-priority", 1, 2, body);
      check(journal.delivery_start("controlled-normal", 1),
            "Old command crossed the start boundary");
      ready = journal.control_apply("controlled", 2, "claim-two", "owner-two");
      check(ready["instance"] == first["instance"] && ready["controlEpoch"] == 2,
            "Control readiness is tied to the durable Agent instance");
      check(journal.delivery_record("controlled-normal", 1)["phase"] == "started",
            "Takeover does not claim that already started side effects were cancelled");
      for (const auto &target :
           {std::make_pair("controlled-normal", 2), std::make_pair("controlled-priority", 1)}) {
        const auto record = journal.delivery_record(target.first, target.second);
        check(record["phase"] == "finished" &&
                  record["result"]["error"]["code"] == "STALE_CONTROLLER" &&
                  !record["resultSeq"].is_null(),
              "Both lanes' received commands become durable stale-controller results");
        check(!journal.delivery_start(target.first, target.second),
              "Fenced received work cannot start later");
      }
      rejects([&] { journal.delivery_receive("controlled-normal", 3, 6, body); },
              "STALE_CONTROLLER");
      rejects([&] { journal.delivery_bind("controlled-normal", 2, "claim-two"); }, "STREAM_CLOSED");
      rejects([&] { journal.control_apply("controlled", 1, "claim-one", "owner-one"); },
              "STALE_CONTROLLER");
      rejects([&] { journal.control_apply("controlled", 2, "another-claim", "owner-two"); },
              "IDEMPOTENCY_CONFLICT");
      rejects([&] { journal.control_apply("controlled", 2, "claim-two", "other-owner"); },
              "IDEMPOTENCY_CONFLICT");
      check(journal.control_apply("controlled", 2, "claim-two", "owner-two") == ready,
            "Lost CONTROL_READY can be retried without allocating or fencing again");
      journal.delivery_finish("controlled-normal", 1, {{"ok", true}});
      check(journal.delivery_record("controlled-normal", 1)["result"]["ok"] == true,
            "Started old work can still commit its actual result after takeover");
    }
    {
      Store journal(dir.path);
      check(journal.control_state("controlled") == ready, "Control epoch survives Agent restart");
      rejects([&] { journal.control_apply("controlled", 1, "claim-one", "owner-one"); },
              "STALE_CONTROLLER");
      check(!journal.delivery_start("controlled-normal", 2),
            "Restart cannot reopen a fenced start boundary");
    }
  }

  {
    Temp dir;
    Json saved_budget;
    std::vector<std::string> streams;
    {
      Store journal(dir.path);
      bool bounded = false;
      for (int i = 0; i < 100; ++i) {
        const auto stream = "global-credit-" + std::to_string(i);
        try {
          journal.delivery_open(stream, "scope-" + std::to_string(i), 16, 2 * 1024 * 1024);
          streams.push_back(stream);
        } catch (const Error &error) {
          check(error.code == "BACKPRESSURE", "Global allocation stops with explicit backpressure");
          bounded = true;
          break;
        }
      }
      check(bounded && streams.size() > 1, "Many scopes share one reserved normal budget");
      saved_budget = journal.delivery_budget();
      check(saved_budget.at("normal").at("reserved") <= saved_budget.at("normalLimit") &&
                saved_budget.at("normal").at("occupied") <=
                    saved_budget.at("normal").at("reserved"),
            "Empty issued windows consume real global reservations");
      auto first = journal.delivery_open(streams.front(), "scope-0", 16, 2 * 1024 * 1024);
      check(journal.delivery_budget() == saved_budget, "Duplicate OPEN never charges twice");
      const auto priority =
          journal.delivery_open("emergency", "scope-0", 4, 512 * 1024, "priority");
      check(priority.at("credit") == 4, "Normal exhaustion cannot borrow priority capacity");
      journal.delivery_close(streams.front());
      rejects([&] { journal.delivery_receive(streams.front(), 1, 2, "{}"); }, "STREAM_CLOSED");
      auto closed = journal.delivery_open(streams.front(), "scope-0", 16, 2 * 1024 * 1024);
      check(closed.at("closed") == true && closed.at("streamSerial") == first.at("streamSerial") &&
                closed.at("creditGeneration") == first.at("creditGeneration"),
            "Closed OPEN keeps its serial and never creates fresh credit");
      auto next = journal.delivery_open("new-emergency-scope", "scope-0", 16, 2 * 1024 * 1024);
      check(next.at("streamSerial").get<int64_t>() > first.at("streamSerial").get<int64_t>() &&
                next.at("creditGeneration") != first.at("creditGeneration"),
            "The receiver allocates a monotonic scoped serial and fresh credit identity");
      saved_budget = journal.delivery_budget();
    }
    Store restored(dir.path, false);
    check(restored.delivery_budget() == saved_budget,
          "Restart preserves issued promises and closure boundaries");
  }
  {
    Temp dir;
    Store journal(dir.path);
    int count = 0;
    for (; count < 10; ++count) {
      try {
        journal.delivery_open("session-credit-" + std::to_string(count), "one-session", 16,
                              2 * 1024 * 1024);
      } catch (const Error &error) {
        check(error.code == "BACKPRESSURE", "Session budget is bounded");
        break;
      }
    }
    check(count > 0 && count < 10 &&
              journal.delivery_budget().at("normal").at("reserved") < credit::normal_budget,
          "A single session cannot monopolize the global reservation");
  }
  {
    Temp dir;
    Store journal(dir.path);
    journal.control_apply("results-capacity", 1, "claim", "owner");
    const auto initial = journal.delivery_open("bounded-results", "results-capacity", 2, max_frame);
    journal.delivery_bind("bounded-results", 1, "claim");
    int64_t end = 0;
    for (int i = 1; i <= 2; ++i) {
      const auto body = Json{{"id", i}, {"method", "turn/start"}}.dump();
      end += body.size();
      journal.delivery_receive("bounded-results", i, end, body);
      journal.delivery_start("bounded-results", i);
      journal.delivery_finish("bounded-results", i,
                              {{"id", i}, {"result", std::string(2 * 1024 * 1024 - 1024, 'x')}});
    }
    const auto full = journal.delivery_budget();
    check(journal.delivery_window("bounded-results").at("credit") == 2 &&
              full.at("normal").at("reserved") >= full.at("normal").at("occupied"),
          "Every unacknowledged maximum result still fits its previously committed reservation");
    const auto first = journal.delivery_record("bounded-results", 1);
    journal.delivery_result_ack("bounded-results", 1, first.at("resultEnd"));
    check(journal.delivery_window("bounded-results").at("credit") == 3 &&
              journal.delivery_record("bounded-results", 1).at("body") == "",
          "Only a durable result receipt releases its slot and original payload");
    const auto body = Json{{"id", 1}, {"method", "turn/start"}}.dump();
    check(journal.delivery_receive("bounded-results", 1, body.size(), body).at("accepted") == false,
          "Compacted command digests still reject duplicate execution");
    rejects([&] { journal.delivery_receive("bounded-results", 1, body.size(), body + " "); },
            "IDEMPOTENCY_CONFLICT");
    check(journal.delivery_target("bounded-results", 1).at("requestId") == "rpc:1",
          "Task identities survive payload compaction");
    const auto reserved = journal.delivery_budget().at("normal").at("reserved");
    journal.delivery_close("bounded-results");
    journal.delivery_bind("bounded-results", 1, "claim");
    check(journal.delivery_open("bounded-results", "results-capacity", 2, max_frame).at("closed") ==
                  true &&
              journal.delivery_results("bounded-results", 1).size() == 1,
          "A same-identity OPEN of a closed flow retains read access to the last result");
    check(journal.delivery_budget().at("normal").at("reserved") == reserved,
          "Closing cannot discard a result that the receiver has not acknowledged");
    auto last = journal.delivery_result_state("bounded-results");
    journal.delivery_result_ack("bounded-results", last.at("sent"), last.at("sent_bytes"));
    check(journal.delivery_budget().at("normal").at("reserved") == 0 &&
              journal.delivery_record("bounded-results", 1).is_null(),
          "Closed acknowledged payloads release their reservation while the tombstone remains");
  }
  {
    Temp dir;
    Store journal(dir.path);
    journal.delivery_open("running-anchor", "anchored", 1, max_frame);
    journal.delivery_receive("running-anchor", 1, 2, "{}");
    journal.delivery_start("running-anchor", 1);
    journal.delivery_finish("running-anchor", 1, {{"ok", true}});
    auto head = journal.delivery_result_state("running-anchor");
    journal.delivery_result_ack("running-anchor", head.at("sent"), head.at("sent_bytes"));
    journal.save(
        {{"id", "anchored"}, {"running", true}, {"activeTask", {{"stream", "running-anchor"}}}});
    journal.delivery_close("running-anchor");
    check(journal.delivery_budget().at("normal").at("reserved") > 0 &&
              !journal.delivery_record("running-anchor", 1).is_null(),
          "An acknowledged start result does not erase a still-running task's target anchor");
    journal.save(
        {{"id", "anchored"}, {"running", false}, {"activeTask", {{"stream", "running-anchor"}}}});
    check(journal.delivery_budget().at("normal").at("reserved") == 0,
          "The real task termination releases its retired anchor and budget");
  }
  {
    Temp dir;
    Store journal(dir.path);
    journal.delivery_open("finite-records", "finite", 1, max_frame);
    int64_t end = 0;
    for (int64_t i = 1; i <= credit::record_limit; ++i) {
      const auto body = Json{{"id", i}, {"method", "noop"}}.dump();
      end += body.size();
      journal.delivery_receive("finite-records", i, end, body);
      journal.delivery_finish("finite-records", i, {{"id", i}, {"result", true}});
      auto head = journal.delivery_result_state("finite-records");
      journal.delivery_result_ack("finite-records", head.at("sent"), head.at("sent_bytes"));
    }
    const auto closed = journal.delivery_window("finite-records");
    check(closed.at("closed") == true && closed.at("exhausted") == true &&
              journal.delivery_budget().at("normal").at("reserved") == 0,
          "Bounded identity history retires its generation after the last result receipt");
    rejects([&] { journal.delivery_receive("finite-records", 1, 2, "{}"); }, "STREAM_CLOSED");
  }
  {
    Temp dir;
    Store journal(dir.path);
    for (int64_t i = 0; i < credit::flow_limit; ++i) {
      const auto stream = "retired-" + std::to_string(i);
      journal.delivery_open(stream, "finite-names", 1, max_frame);
      journal.delivery_close(stream);
    }
    const auto before = journal.delivery_budget();
    rejects([&] { journal.delivery_open("one-too-many", "finite-names", 1, max_frame); },
            "BACKPRESSURE");
    check(journal.delivery_budget() == before &&
              before.at("namespaces").at(0).at("closedThrough") == credit::flow_limit,
          "Uncompressible tombstones stop allocation without growing or losing the final refusal "
          "boundary");
  }

  {
    Environment id_environment("CF_ACCESS_CLIENT_ID");
    Environment secret_environment("CF_ACCESS_CLIENT_SECRET");
    Environment file_environment("COC_ACCESS_CONFIG");
    Temp dir;
    const auto file = std::filesystem::path(dir.path) / "access.json";
    Json config = {{"origins", Json::array({"https://relay.example.test"})},
                   {"clientId", "test-service-id"},
                   {"clientSecret", "test-service-secret"}};
    save_private(file, config);
    configure_access(file.string());
    check(access_enabled(relay_url("https://RELAY.example.test:443")),
          "Access origin canonicalization");
    check(access_credentials(relay_url("https://relay.example.test")).second ==
              "test-service-secret",
          "Shared Access credentials");
    check(!access_enabled(relay_url("https://relay.example.test:444")) &&
              !access_enabled(relay_url("https://other.example.test")) &&
              !access_enabled(relay_url("http://localhost")),
          "Access credentials restricted to exact HTTPS origin");
    setenv("CF_ACCESS_CLIENT_ID", "environment-id", 1);
    rejects([&] { configure_access(file.string()); }, "CONFIG_ERROR");
    check(!access_enabled(relay_url("https://relay.example.test")),
          "Partial environment credentials fail closed");
    setenv("CF_ACCESS_CLIENT_SECRET", "environment-secret", 1);
    configure_access(file.string());
    check(access_credentials(relay_url("https://relay.example.test")) ==
              std::make_pair(std::string("environment-id"), std::string("environment-secret")),
          "Environment credentials override file credentials");
    check(access_credentials(relay_url("https://other.example.test")).first.empty(),
          "Environment credentials preserve the configured origin allowlist");
    configure_access("");
    check(access_credentials(relay_url("https://r.xlogic.cc")).second == "environment-secret",
          "Environment credentials override compiled defaults");
    setenv("CF_ACCESS_CLIENT_SECRET", "secret\r\nInjected: header", 1);
    rejects([&] { configure_access(""); }, "CONFIG_ERROR");
    setenv("CF_ACCESS_CLIENT_SECRET", "", 1);
    rejects([&] { configure_access(""); }, "CONFIG_ERROR");
    setenv("CF_ACCESS_CLIENT_SECRET", "environment-secret", 1);
    unsetenv("CF_ACCESS_CLIENT_ID");
    rejects([&] { configure_access(""); }, "CONFIG_ERROR");
    unsetenv("CF_ACCESS_CLIENT_SECRET");
    unsetenv("CF_ACCESS_CLIENT_ID");
    config["clientSecret"] = "secret\r\nInjected: header";
    save_private(file, config);
    rejects([&] { configure_access(file.string()); }, "CONFIG_ERROR");
    check(!access_enabled(relay_url("https://relay.example.test")),
          "Failed configuration leaves no active token");
    config["clientSecret"] = "test-service-secret";
    config["origins"] = Json::array({"http://localhost"});
    save_private(file, config);
    rejects([&] { configure_access(file.string()); }, "CONFIG_ERROR");
    config["origins"] = Json::array({"https://relay.example.test"});
    save_private(file, config);
    chmod(file.c_str(), 0644);
    rejects([&] { configure_access(file.string()); }, "CONFIG_ERROR");
    configure_access("");
  }
  for (const auto &fixture :
       read_json(std::filesystem::path(COC_SOURCE_DIR) / "tests/wake-url-fixtures.json")) {
    if (fixture.at("valid") == true)
      check(wake_url(fixture.at("value")) == fixture.at("value"), "Valid wake URL");
    else
      rejects([&] { wake_url(fixture.at("value")); }, "CONFIG_ERROR");
  }
  check(update_settings(Json::object()).enabled, "Updates enabled by default");
  for (const auto &fixture :
       read_json(std::filesystem::path(COC_SOURCE_DIR) / "tests/access-email-fixtures.json")) {
    if (fixture.value("error", false))
      rejects([&] { access_emails(fixture.at("input")); }, "CONFIG_ERROR");
    else
      check(access_emails(fixture.at("input")) == fixture.at("output"),
            "Email association normalization");
  }
  check(access_emails(std::vector<std::string>(21, "user@example.com")).size() == 1,
        "Email arrays have no count quota and still deduplicate");
  check(!update_settings({{"autoUpdate", false}}).enabled, "Boolean disables automatic update");
  check(!update_settings({{"autoUpdate", {{"enabled", false}, {"intervalHours", 24}}}}).enabled,
        "Object disables automatic update");
  for (auto value : {Json("false"), Json(nullptr), Json{{"intervalHours", 0}},
                     Json{{"enabled", "false"}}, Json{{"platform", "../other"}}})
    rejects([&] { update_settings({{"autoUpdate", value}}); }, "CONFIG_ERROR");
  check(newer_release("0.6.0", "0.5.99") && newer_release("0.5.10", "0.5.9") &&
            !newer_release("0.5.1", "0.5.2") && !newer_release("0.5.2", "0.5.2"),
        "Only numerically newer stable releases install");
  rejects([] { newer_release("1.2.3/../../bad", "0.5.2"); }, "UPDATE_FAILED");
  const auto permissions_rpc =
      Json{{"method", "item/permissions/requestApproval"},
           {"params",
            {{"permissions",
              {{"network", {{"enabled", true}}}, {"fileSystem", nullptr}, {"unexpected", true}}}}}};
  check(approval_decision(permissions_rpc, true) ==
            Json({{"permissions", {{"network", {{"enabled", true}}}}}, {"scope", "turn"}}),
        "Automatic permissions remain turn-scoped and include only requested fields");
  check(approval_decision(permissions_rpc, false) ==
            Json({{"permissions", Json::object()}, {"scope", "turn"}}),
        "Deny grants no additional permissions");
  rejects(
      [] {
        approval_decision({{"method", "item/tool/requestUserInput"}, {"params", Json::object()}},
                          true);
      },
      "UNSUPPORTED_APPROVAL");
  rejects(
      [] {
        approval_decision({{"method", "item/commandExecution/requestApproval"},
                           {"params", {{"availableDecisions", Json::array({"acceptForSession"})}}}},
                          true);
      },
      "UNSUPPORTED_APPROVAL");
  check(web_fingerprint(web_command(
            {{"action", "autoApproval"}, {"requestId", "policy"}, {"enabled", true}})) !=
            web_fingerprint(web_command(
                {{"action", "autoApproval"}, {"requestId", "policy"}, {"enabled", false}})),
        "Policy deduplication distinguishes enabling from disabling");
  for (auto &fixture :
       read_json(std::filesystem::path(COC_SOURCE_DIR) / "tests/protocol-fixtures.json")) {
    if (fixture.value("error", false))
      rejects([&] { web_command(fixture["input"]); }, "INVALID_REQUEST");
    else
      check(web_command(fixture["input"]) == fixture["output"], "Shared C++/Zod protocol example");
  }
  check(relay_url("https://r.xlogic.cc/").origin == "https://r.xlogic.cc", "Relay normalization");
  check(relay_url("http://[::1]:8787").host == "::1", "IPv6 loopback");
  for (auto s : {"http://evil.example", "https://user:pass@r.xlogic.cc", "https://r.xlogic.cc/path",
                 "https://r.xlogic.cc?secret=x", "https://r.xlogic.cc:99999"})
    rejects([&] { relay_url(s); }, "INVALID_RELAY");
  rejects([] { web_command({{"action", "exec"}, {"requestId", "request"}}); }, "INVALID_REQUEST");
  rejects([] { web_command({{"action", "sync"}, {"after", -1}}); }, "INVALID_REQUEST");
  rejects(
      [] {
        const auto command = Json{{"method", "account/login/start"}};
        guard_cli(command, "/p", "workspace-write");
      },
      "UNSUPPORTED_METHOD");
  rejects(
      [] {
        guard_cli({{"method", "turn/start"}, {"params", {{"cwd", "/etc"}}}}, "/p",
                  "workspace-write");
      },
      "FORBIDDEN");
  rejects(
      [] {
        guard_cli({{"method", "turn/start"}, {"params", {{"threadId", "foreign"}}}}, "/p",
                  "workspace-write", "mine");
      },
      "FORBIDDEN");
  rejects(
      [] {
        guard_cli({{"method", "turn/start"},
                   {"params", {{"sandboxPolicy", {{"type", "dangerFullAccess"}}}}}},
                  "/p", "workspace-write");
      },
      "FORBIDDEN");
  rejects([] { guard_cli({{"method", "thread/resume"}}, "/p", "read-only"); }, "FORBIDDEN");
  auto guarded = guard_cli({{"method", "thread/start"},
                            {"params",
                             {{"config", {{"sandbox_mode", "danger-full-access"}}},
                              {"approvalsReviewer", "user"},
                              {"sandboxPolicy",
                               {{"type", "workspaceWrite"},
                                {"networkAccess", false},
                                {"writableRoots", Json::array({"/p"})}}}}}},
                           "/p", "workspace-write");
  check(guarded["params"] ==
            Json{{"cwd", "/p"}, {"sandbox", "workspace-write"}, {"approvalPolicy", "on-request"}},
        "Server policy must win over echoed configuration");
  check(redact({{"nested",
                 {{"api_key", "secret"}, {"env", {{"TOKEN", "secret"}}}, {"model", "x"}}}}) ==
            Json{{"nested", {{"api_key", "[redacted]"}, {"env", Json::object()}, {"model", "x"}}}},
        "Nested credential redaction");
  check(web_fingerprint({{"action", "approval"},
                         {"requestId", "r"},
                         {"approvalId", "1"},
                         {"runtimeId", "rt"},
                         {"approvalVersion", "v"},
                         {"allow", false}}) ==
            "{\"action\":\"approval\",\"requestId\":\"r\",\"approvalId\":\"1\",\"runtimeId\":"
            "\"rt\",\"approvalVersion\":\"v\",\"allow\":false}",
        "Approval fingerprint binds runtime and version");
  check(
      web_fingerprint(
          {{"action", "prompt"}, {"requestId", "r"}, {"text", "hello"}, {"model", "model-a"}}) !=
          web_fingerprint(
              {{"action", "prompt"}, {"requestId", "r"}, {"text", "hello"}, {"model", "model-b"}}),
      "Model changes must not share a prompt fingerprint");
  Temp t;
  {
    Store s(t.path);
    rejects([&] { Store duplicate(t.path); }, "STATE_LOCKED");
    check(s.begin("r", "a")["cached"] == false, "New request");
    rejects([&] { s.begin("r", "a"); }, "RESULT_UNKNOWN");
    rejects([&] { s.begin("r", "b"); }, "IDEMPOTENCY_CONFLICT");
    s.finish("r", {{"ok", true}});
    check(s.begin("r", "a")["value"]["ok"] == true, "Cached request");
    s.save({{"id", "a"},
            {"projectId", "p"},
            {"mode", "web"},
            {"state", "ready"},
            {"running", true},
            {"createdAt", now()}});
    auto first = s.event("a", "text", "first");
    s.event("b", "text", "private");
    s.event("a", "text", "last");
    auto replay = s.replay("a", first["seq"]);
    check(!replay["gap"].get<bool>() && replay["events"].size() == 1 &&
              replay["events"][0]["data"] == "last",
          "Replay session isolation and global sequence gaps");
  }
  {
    Store s(t.path);
    check(s.get("a")["state"] == "failed" && s.get("a")["running"] == false,
          "Restart must fail old runtime");
    check(s.begin("r", "a")["value"]["ok"] == true, "Persistent deduplication");
  }
  auto file = std::filesystem::path(t.path) / "private.json";
  save_private(file, {{"token", "placeholder"}}, true);
  struct stat st {};
  stat(file.c_str(), &st);
  check((st.st_mode & 0777) == 0600, "Credential file mode");
  rejects([&] { save_private(file, Json::object(), true); }, "CONFIG_ERROR");
  std::cout << "PASS: URL validation, web schemas, RPC isolation, policy, redaction, SQLite "
               "replay/restart/deduplication, private configuration\n";
}
void external_approval_contract(const std::string &endpoint, const std::string &thread,
                                const std::string &cwd, bool allow) {
  asio::io_context io;
  asio::steady_timer deadline(io, std::chrono::seconds(15));
  std::shared_ptr<ExternalApprovals> bridge;
  bool received = false, resolved = false;
  std::string failure;
  auto end = [&] {
    bridge->close();
    deadline.cancel();
    io.stop();
  };
  bridge = std::make_shared<ExternalApprovals>(
      io, Json{{"approvalEndpoint", endpoint}}, thread, cwd,
      [&](Json approval) {
        received = true;
        auto result = bridge->answer(approval.at("approvalId"), allow);
        check(result.at("state") == "approval-submitted", "Approval forwarded as submission only");
        rejects([&] { bridge->answer(approval.at("approvalId"), !allow); }, "RESULT_UNKNOWN");
      },
      [&](Json) {
        resolved = true;
        end();
      },
      [&](bool available, std::string message) {
        if (!available) {
          failure = message;
          end();
        }
      });
  deadline.async_wait([&](auto error) {
    if (!error) {
      failure = "Approval contract timed out";
      end();
    }
  });
  bridge->start();
  io.run();
  check(failure.empty() && received && resolved,
        failure.empty() ? "No approval resolution" : failure.c_str());
  std::cout
      << "PASS: native original-server approval replay, explicit decision, duplicate guard and "
         "resolution\n";
}
void external_test() {
  Temp temp;
  auto config = agent_config(
      {{"hostId", "external"},
       {"token", std::string(24, 'x')},
       {"dataDir", temp.path + "/state"},
       {"projects", Json::array({{{"id", "project"}, {"name", "Project"}, {"path", temp.path}}})}});
  check(config["codexUseProxy"] == false, "Codex proxy is opt-in by default");
  auto proxy_config = config;
  proxy_config["codexUseProxy"] = true;
  check(agent_config(proxy_config)["codexUseProxy"] == true, "Preserve Codex proxy opt-in");
  proxy_config["codexUseProxy"] = "true";
  rejects([&] { agent_config(proxy_config); }, "CONFIG_ERROR");
  check(config["externalSessions"]["allowApprovals"] == false &&
            config["externalSessions"]["allowQueue"] == false,
        "External side effects disabled by default");
  config["externalSessions"]["allowApprovals"] = "true";
  rejects([&] { agent_config(config); }, "CONFIG_ERROR");
  Store store(temp.path);
  store.save({{"id", "external"}, {"state", "ready"}});
  Json item = {{"id", "reply"}, {"type", "agentMessage"}, {"text", "你好"}};
  auto first = store.external_item("external", "turn", item);
  check(!first.is_null(), "Initial external snapshot");
  check(store.external_item("external", "turn", item).is_null(), "Identical polls do not journal");
  item["text"] = "你好 again";
  auto second = store.external_item("external", "turn", item);
  check(second["seq"] == first["seq"] && second["revision"] > first["revision"] &&
            second["data"]["delta"] == "你好 again",
        "External snapshot replaces stable item");
  auto changes = store.history("external", 0, first["revision"]);
  check(changes["events"].size() == 1 && changes["events"][0]["data"]["delta"] == "你好 again",
        "Reconnect returns revised full snapshot once");
  item["text"] = std::string(18000, 'x');
  auto large = store.external_item("external", "turn", item);
  check(large.contains("contentSeq") && large["seq"] == first["seq"],
        "Large rewritten snapshot chunked");
  auto content = store.content("external", large["seq"], 0, large["revision"]);
  check(content["text"] == std::string(4096, 'x') && content["more"] == true,
        "Rewritten body is readable");
  const auto tool = store.event("external", "item/completed",
                                {{"item",
                                  {{"id", "large-tool"},
                                   {"type", "commandExecution"},
                                   {"command", "build"},
                                   {"exitCode", 0},
                                   {"aggregatedOutput", std::string(30000, 'x')}}}});
  check(tool.contains("contentSeq") && tool["data"]["item"]["id"] == "large-tool" &&
            tool["data"]["item"]["exitCode"] == 0,
        "Large live tool retains identity and completion metadata");
  const auto tool_page = store.history("external");
  bool found_tool = false;
  for (const auto &entry : tool_page["events"])
    if (entry["seq"] == tool["seq"])
      found_tool = entry["data"]["item"]["id"] == "large-tool";
  check(found_tool, "Large replayed tool uses the same metadata as the live event");
  auto older = store.external_item(
      "external", "older-turn", {{"id", "old"}, {"type", "agentMessage"}, {"text", "older"}}, true);
  check(older["seq"] < 0, "Archived external item precedes live window");
  auto normal = store.archive_event("external", "user", {{"text", "normal archive"}});
  check(normal["seq"] != older["seq"], "External and normal archive sequences cannot collide");
  check(store
            .external_item("external", "older-turn",
                           {{"id", "old"}, {"type", "agentMessage"}, {"text", "older"}})
            .is_null(),
        "Archive/live overlap deduplicates");
  check(active_writer_error(
            {{"code", "CODEX_ERROR"}, {"message", "thread t already has an active writer"}}),
        "Exact active writer fallback");
  check(!active_writer_error({{"code", "CODEX_ERROR"}, {"message", "permission denied"}}) &&
            !active_writer_error(
                {{"code", "HTTP_TIMEOUT"}, {"message", "already has an active writer"}}),
        "Other failures never downgrade");
  Json patch = {
      {"id", "patch"},
      {"type", "fileChange"},
      {"status", "inProgress"},
      {"changes", Json::array({{{"path", "file.txt"}, {"diff", std::string(18000, '+')}}})}};
  auto patch_event = store.external_item("external", "turn", patch);
  check(patch_event["type"] == "item/started" && patch_event.contains("contentSeq") &&
            patch_event["data"]["item"]["type"] == "fileChange",
        "Large pending patch retains readable tool context");
  check(same_project_path(temp.path, temp.path + "/."), "Canonical project verification");
  check(!same_project_path(temp.path, temp.path + "/missing"), "Missing project rejected safely");
  approval_configuration_fixture(temp.path);
  shared_approval_fixture(temp.path);
  std::cout << "PASS: external stable snapshots, revisions, rewrite, chunks, archive overlap and "
               "writer fallback\n";
}
void external_refresh_test() {
  Temp temp;
  asio::io_context io;
  Json items = Json::array();
  for (int i = 0; i < 25; ++i)
    items.push_back(
        {{"id", "external-" + std::to_string(i)}, {"type", "agentMessage"}, {"text", "partial"}});
  const auto state_file = temp.path + "/.fake-external.json";
  auto save = [&] { save_private(state_file, {{"items", items}, {"running", true}}); };
  save();
  bool finished = false, success = false;
  int phase = 0;
  std::string failure;
  std::shared_ptr<CodexProcess> process;
  std::shared_ptr<ExternalThread> reader;
  asio::steady_timer deadline(io, std::chrono::seconds(12));
  auto end = [&](bool ok, std::string error) {
    if (finished)
      return;
    finished = true;
    success = ok;
    failure = std::move(error);
    deadline.cancel();
    reader->close();
    process->close();
  };
  process = std::make_shared<CodexProcess>(
      io,
      Json{{"codexPath", "node"},
           {"codexArgs",
            Json::array({std::string(COC_SOURCE_DIR) + "/tests/fixtures/fake-codex.mjs"})},
           {"sandbox", "read-only"}},
      temp.path, [](Json) {}, [&] { end(false, "External fixture exited"); });
  reader = std::make_shared<ExternalThread>(
      io, process, "external-history", temp.path,
      [&](std::string, Json item, bool) {
        if (phase == 2 && item.at("id") == "external-10" && item.value("text", "") == "final")
          end(true, "");
      },
      [&](Json state) {
        if (phase == 1 && state.contains("seed")) {
          // Let the tail advance first, then finish an item now more than 16 entries old.
          phase = 2;
          items[10]["text"] = "final";
          save();
        }
      },
      [&](Json error) { end(false, error.dump()); });
  deadline.async_wait([&](auto error) {
    if (!error)
      end(false, "Older growing output was lost after the tail advanced");
  });
  process->start();
  process->initialize([&](Json, Json error) {
    if (!error.is_null()) {
      end(false, error.dump());
      return;
    }
    reader->bootstrap([&](Json, Json error) {
      if (!error.is_null()) {
        end(false, error.dump());
        return;
      }
      phase = 1;
      for (int i = 25; i < 65; ++i)
        items.push_back({{"id", "external-" + std::to_string(i)},
                         {"type", "agentMessage"},
                         {"text", "newer output"}});
      save();
    });
  });
  io.run();
  check(success, failure.c_str());
  std::cout << "PASS: external output finalization survives more than 16 newer items\n";
}
void history_subscriber_test() {
  Temp temp;
  Store cache(temp.path, false);
  asio::io_context io;
  int64_t durable = 0;
  int ready = 0, dirty = 0;
  Json sent = Json::array();
  auto send = [&](Json frame) { sent.push_back(frame); };
  const auto window = [&](const Json &request, int64_t received, int64_t maximum = 10) {
    auto result = request;
    result["type"] = "history-window";
    result["agentInstance"] = "agent-storage";
    result["streamSerial"] = 1;
    result["creditGeneration"] = "history-credit";
    result["receivedRevision"] = received;
    result["maxRevision"] = maximum;
    return result;
  };
  const auto failed = [&](const Json &) { throw std::runtime_error("Unexpected history failure"); };
  {
    HistorySubscription subscriber(
        io, cache, "reader", [&] { return durable; }, [&](int64_t) { ++dirty; }, [&] { ++ready; },
        failed);
    subscriber.connect(send);
    const auto retired = sent.back();
    subscriber.disconnect();
    subscriber.connect(send);
    subscriber.receive(window(retired, 0));
    check(ready == 0, "Native history ignores a retired recovery exchange");
    subscriber.receive(window(sent.back(), 0));
    check(ready == 1 && dirty == 1 && sent.size() == 2,
          "A history head is not a durable client acknowledgement");
    durable = 10;
    subscriber.commit();
    const auto ack = sent.back();
    check(ack.at("operation") == "ack" && ack.at("receivedRevision") == durable,
          "Native history confirms only the committed cache checkpoint");
    io.run_for(std::chrono::milliseconds(1100));
    check(sent.back() == ack && sent.size() == 4,
          "Native history retries a lost ACK without changing identity");
    subscriber.receive(window(ack, 10));
    subscriber.receive(window(ack, 5));
    check(cache.cache_get("reader").at("acknowledgedRevision") == 10,
          "Native history ignores an online old ACK without rewinding its floor");
    const auto count = sent.size();
    io.restart();
    io.run_for(std::chrono::milliseconds(20));
    check(sent.size() == count, "A fully confirmed native history subscriber is idle");
    subscriber.disconnect();
    subscriber.connect(send);
    rejects([&] { subscriber.receive(window(sent.back(), 9)); }, "DELIVERY_STATE_MISMATCH");
  }
  {
    HistorySubscription restored(
        io, cache, "reader", [&] { return durable; }, [&](int64_t) {}, [&] {}, failed);
    restored.connect(send);
    check(sent.back().at("acknowledgedRevision") == 10 &&
              sent.back().at("agentInstance") == "agent-storage",
          "Native history restores its persistent confirmation and Agent identity");
    auto changed = window(sent.back(), 10);
    changed["creditGeneration"] = "replaced";
    rejects([&] { restored.receive(changed); }, "DELIVERY_STATE_MISMATCH");
  }
  {
    HistorySubscription active(
        io, cache, "reader", [&] { return durable; }, [&](int64_t) {}, [&] {}, failed);
    active.connect(send);
    active.receive(window(sent.back(), 10));
    const auto original = sent.back();
    Store other(temp.path, false);
    other.cache_clear();
    durable = 11; // Old in-memory cursors cannot acknowledge after another process clears.
    const auto count = sent.size();
    rejects([&] { active.commit(); }, "DELIVERY_STATE_MISMATCH");
    active.receive(window(original, 10));
    check(sent.size() == count && cache.cache_get("reader").is_null(),
          "Cross-process cache clear fences active history ACKs without resurrecting metadata");
    // Restore only to exercise the independent checkpoint rollback check below.
    cache.cache_put("reader",
                    {{"stream", "retired"}, {"instance", "client"}, {"acknowledgedRevision", 10}});
  }
  durable = 0;
  rejects(
      [&] {
        HistorySubscription lost(
            io, cache, "reader", [&] { return durable; }, [&](int64_t) {}, [&] {}, failed);
      },
      "DELIVERY_STATE_MISMATCH");
}
void history_subscription_test() {
  Temp temp;
  Json request = {{"sessionId", "history"},   {"owner", "reader"},
                  {"stream", "subscription"}, {"instance", "client-storage"},
                  {"exchangeId", "exchange"}, {"operation", "subscribe"},
                  {"receivedRevision", 0},    {"acknowledgedRevision", 0}};
  Json identity;
  int64_t revision = 0;
  {
    Store store(temp.path);
    store.save({{"id", "history"}, {"state", "closed"}, {"createdAt", 1}});
    revision = store.event("history", "user", {{"text", "tail"}}).at("revision");
    identity = store.history_subscription(request);
    check(identity.at("maxRevision") == revision && identity.at("receivedRevision") == 0,
          "History OPEN announces its own durable head without confirming receipt");
    check(store.history_subscription(request) == identity,
          "A lost history OPEN returns the same persistent allocation");
    for (const auto &field : {"agentInstance", "streamSerial", "creditGeneration"})
      request[field] = identity.at(field);
    request["operation"] = "ack";
    request["receivedRevision"] = revision;
    check(store.history_subscription(request).at("receivedRevision") == revision,
          "History confirmation advances only the addressed subscriber");
    auto stranger = request;
    stranger["owner"] = "other-reader";
    rejects([&] { store.history_subscription(stranger); }, "DELIVERY_STATE_MISMATCH");
    request["receivedRevision"] = 0;
    check(store.history_subscription(request).at("receivedRevision") == revision,
          "An online old history ACK cannot rewind receipt");
    auto next = store.event("history", "user", {{"text", "later"}}).at("revision");
    request["receivedRevision"] = next;
    rejects([&] { store.history_subscription(request); }, "INVALID_ACK");
    check(store.history_hint(request).at("maxRevision") == next,
          "A dirty hint exposes the last tail without another business message");
    revision = next;
    check(store.history_subscription(request).at("receivedRevision") == revision,
          "Announced history boundaries can be acknowledged");
  }
  {
    Store store(temp.path);
    request["operation"] = "subscribe";
    request["acknowledgedRevision"] = revision;
    request["exchangeId"] = "after-restart";
    auto recovered = store.history_subscription(request);
    check(recovered.at("receivedRevision") == revision &&
              recovered.at("streamSerial") == identity.at("streamSerial") &&
              recovered.at("creditGeneration") == identity.at("creditGeneration"),
          "History subscription ACK and allocation survive Agent restart");
    auto rollback = request;
    rollback["receivedRevision"] = 0;
    rollback["acknowledgedRevision"] = 0;
    rejects([&] { store.history_subscription(rollback); }, "DELIVERY_STATE_MISMATCH");
    rollback = request;
    rollback["agentInstance"] = "different-database";
    rejects([&] { store.history_subscription(rollback); }, "DELIVERY_STATE_MISMATCH");
    rollback = request;
    rollback["receivedRevision"] = revision + 1;
    rollback["acknowledgedRevision"] = revision + 1;
    rejects([&] { store.history_subscription(rollback); }, "DELIVERY_STATE_MISMATCH");
    request["operation"] = "retire";
    check(store.history_subscription(request).at("closed") == true,
          "Retirement fences history allocation before releasing an online route");
    request["operation"] = "subscribe";
    rejects([&] { store.history_subscription(request); }, "STREAM_CLOSED");
    request.erase("streamSerial");
    request.erase("creditGeneration");
    request["acknowledgedRevision"] = 0;
    request["receivedRevision"] = 0;
    for (int i = 1; i < credit::flow_limit; ++i) {
      request["stream"] = "reader-" + std::to_string(i);
      auto allocated = store.history_subscription(request);
      check(allocated.at("streamSerial") == i + 1,
            "History subscriber serials never reuse retired allocations");
    }
    request["stream"] = "beyond-budget";
    rejects([&] { store.history_subscription(request); }, "BACKPRESSURE");
  }
}
void history_test() {
  Temp temp;
  Store store(temp.path);
  store.save({{"id", "history"}, {"state", "closed"}, {"createdAt", 1}});
  for (int i = 0; i < 450; ++i)
    store.event("history", "user", {{"text", std::to_string(i)}});
  auto latest = store.history("history");
  check(latest["events"].size() == 200 && latest["more"] == true, "Latest page is bounded");
  auto watermark = latest["snapshotSeq"].get<int64_t>();
  store.event("other", "user", {{"text", "private"}});
  store.event("history", "user", {{"text", "new"}});
  auto older = store.history("history", latest["cursor"]);
  check(older["events"].size() == 200 &&
            older["events"].back()["seq"] < latest["events"].front()["seq"],
        "Keyset pagination is stable across live inserts");
  auto forward = store.history("history", 0, watermark);
  check(forward["events"].size() == 1 && forward["events"][0]["data"]["text"] == "new",
        "Snapshot handoff does not lose live messages or cross sessions");
  auto first = store.event("history", "item/agentMessage/delta",
                           {{"itemId", "answer"}, {"delta", "hello "}});
  auto second =
      store.event("history", "item/agentMessage/delta", {{"itemId", "answer"}, {"delta", "world"}});
  check(first["seq"] == second["seq"] && second["revision"] > first["revision"] &&
            second["data"]["delta"] == "hello world",
        "Streaming fragments materialize into a stable message with revisions");
  auto updated = store.history("history", 0, first["revision"]);
  check(updated["events"].size() == 1 && updated["events"][0]["data"]["delta"] == "hello world",
        "Reconnect replays message updates by revision");
  std::string text;
  for (int i = 0; i < 50000; ++i)
    text += "你好";
  auto large = store.event("history", "user", {{"text", text}});
  check(large.contains("contentSeq") && large.dump().size() < 1024,
        "Large messages become small references");
  std::string reconstructed;
  int64_t offset = 0;
  while (true) {
    auto chunk = store.content("history", large["seq"], offset, large["revision"]);
    check(chunk.dump().size() < max_frame, "Content chunks fit transport frames");
    reconstructed += chunk["text"].get<std::string>();
    offset = chunk["nextOffset"];
    if (chunk["more"] == false)
      break;
  }
  check(reconstructed == text, "UTF-8 content round trips across chunks");
  rejects([&] { store.content("other", large["seq"], 0); }, "CONTENT_NOT_FOUND");
  rejects([&] { store.content("history", second["seq"], 0, first["revision"]); },
          "CONTENT_CHANGED");
  store.archive_page("history",
                     Json::array({{{"type", "user"}, {"data", {{"text", "archive-new"}}}},
                                  {{"type", "user"}, {"data", {{"text", "archive-old"}}}}}),
                     nullptr);
  auto archive = store.history("history", 1);
  check(archive["events"].size() == 2 && archive["events"][0]["data"]["text"] == "archive-old",
        "Lazy archived items sort before live messages");
  store.cleanup();
  check(store.history("history")["snapshotSeq"] == large["revision"],
        "Cleanup retains old closed-session history");
  store.cache_put("page", latest);
  check(store.cache_get("page") == latest, "Local SQLite page cache round trip");
  store.cache_clear();
  check(store.cache_get("page").is_null() && !store.history("history")["events"].empty(),
        "Clearing cache preserves authoritative history");
  std::cout << "PASS: bounded history, stable cursors, revision sync, UTF-8 chunks, archive "
               "ordering, retention and cache isolation\n";
}
void stabilization_test() {
  Temp temp;
  { Store store(temp.path); }
  sqlite3 *database = nullptr;
  check(sqlite3_open((temp.path + "/agent.db").c_str(), &database) == SQLITE_OK, "Seed database");
  sqlite3_exec(database, "BEGIN", nullptr, nullptr, nullptr);
  sqlite3_stmt *statement = nullptr;
  sqlite3_prepare_v2(database, "INSERT INTO sessions VALUES(?,?)", -1, &statement, nullptr);
  for (int i = 0; i < 100000; ++i) {
    const auto id = std::to_string(100000 + i);
    const auto value = Json{{"id", id},          {"projectId", "p"}, {"mode", "web"},
                            {"state", "closed"}, {"running", false}, {"createdAt", i}}
                           .dump();
    sqlite3_bind_text(statement, 1, id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(statement, 2, value.c_str(), -1, SQLITE_TRANSIENT);
    check(sqlite3_step(statement) == SQLITE_DONE, "Seed session");
    sqlite3_reset(statement);
  }
  sqlite3_finalize(statement);
  sqlite3_exec(database, "COMMIT", nullptr, nullptr, nullptr);
  sqlite3_close(database);
  {
    Store store(temp.path);
    for (int i = 0; i < 4; ++i)
      store.save({{"id", "live-" + std::to_string(i)},
                  {"projectId", "p"},
                  {"mode", "web"},
                  {"state", "ready"},
                  {"running", true},
                  {"createdAt", now()}});
    check(store.sessions(true).size() == 4, "Active scans ignore 100000 archived sessions");
    std::string cursor;
    size_t count = 0;
    do {
      auto page = store.session_page(
          {{"cursor", cursor}, {"state", "closed"}, {"projectId", "p"}, {"mode", "web"}});
      check(page.dump().size() < 100 * 1024 && page["data"].size() <= 100,
            "Session page byte/count budgets");
      for (auto &session : page["data"]) {
        check(session["id"].get<std::string>() > cursor, "Stable directory cursor");
        cursor = session["id"];
        ++count;
      }
      if (page["nextCursor"].is_null())
        break;
    } while (true);
    check(count == 100000 && store.sessions(true).size() == 4,
          "Complete directory without disrupting running sessions");
    Json stream;
    const std::string delta(1000, 'x');
    for (int i = 0; i < 1100; ++i)
      stream = store.event("live-0", "item/agentMessage/delta",
                           {{"itemId", "stream"}, {"delta", delta}});
    check(stream.contains("contentSeq"), "Chunked stream is referenced");
    std::string text;
    for (int64_t offset = 0;;) {
      const auto part = store.content("live-0", stream["seq"], offset, stream["revision"]);
      text += part["text"].get<std::string>();
      offset = part["nextOffset"];
      if (part["more"] == false)
        break;
    }
    check(text == std::string(1100000, 'x'), "Append-only chunks reconstruct 1 MiB stream");
    store.begin("failed", "test");
    store.finish("failed", {{"requestError", {{"code", "PROJECT_BUSY"}, {"message", "Busy"}}}});
    check(store.request_status("failed")["state"] == "failed", "Known failure is queryable");
    rejects([&] { store.begin("failed", "test"); }, "PROJECT_BUSY");
    check(store.request_status("absent")["state"] == "not_found",
          "Unknown identity is distinct from unknown execution");
    WorkspaceFiles files(&store);
    files.request(
        temp.path, "workspace-write", "owner",
        {{"operation", "begin"}, {"uploadId", "persistent"}, {"path", "empty"}, {"size", 0}});
    const auto result = files.request(temp.path, "workspace-write", "owner",
                                      {{"operation", "finish"}, {"uploadId", "persistent"}});
    check(result["state"] == "completed" &&
              result["sha256"] ==
                  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          "Upload completion checksum");
  }
  {
    Store store(temp.path);
    WorkspaceFiles files(&store);
    auto result = files.request(temp.path, "read-only", "owner",
                                {{"operation", "status"}, {"uploadId", "persistent"}});
    check(result["state"] == "completed",
          "Upload result survives Agent restart and policy changes");
    rejects(
        [&] {
          files.request(temp.path, "workspace-write", "owner",
                        {{"operation", "begin"},
                         {"uploadId", "persistent"},
                         {"path", "another"},
                         {"size", 0}});
        },
        "UPLOAD_EXISTS");
    check(files.request(temp.path, "read-only", "other",
                        {{"operation", "status"}, {"uploadId", "persistent"}})["state"] ==
              "not_found",
          "Upload status credential isolation");
  }
  auto path = std::filesystem::path(temp.path) / "credential.json";
  save_private(path, {{"value", "old"}});
  {
    PrivateLock lock(path);
    rejects([&] { PrivateLock other(path); }, "CONFIG_BUSY");
  }
  save_private(path, {{"value", "new"}});
  check(read_json(path)["value"] == "new", "Atomic private replacement");
  std::filesystem::create_symlink(path, temp.path + "/symlink");
  rejects([&] { save_private(temp.path + "/symlink", Json::object()); }, "CONFIG_ERROR");
  check(read_json(path)["value"] == "new", "Rejected symlink preserves credential");
  std::cout << "PASS: 100000 session directory, active indexes, append-only 1 MiB stream, request "
               "failures, durable upload results, atomic credentials\n";
}
void http_deadline_test() {
  for (const auto &phase : {"header", "body", "tls"}) {
    asio::io_context server_io;
    asio::ip::tcp::acceptor acceptor(server_io, {asio::ip::make_address("127.0.0.1"), 0});
    const auto port = acceptor.local_endpoint().port();
    std::mutex mutex;
    std::condition_variable condition;
    bool finished = false;
    std::thread server([&] {
      asio::ip::tcp::socket socket(server_io);
      acceptor.accept(socket);
      if (std::string(phase) == "body") {
        const std::string response = "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{";
        boost::system::error_code ignored;
        asio::write(socket, asio::buffer(response), ignored);
      }
      std::unique_lock<std::mutex> lock(mutex);
      condition.wait(lock, [&] { return finished; });
    });
    std::string code;
    const auto start = now();
    try {
      http_json(relay_url(std::string(std::string(phase) == "tls" ? "https" : "http") +
                          "://127.0.0.1:" + std::to_string(port)),
                "/", nullptr, "", "", std::chrono::milliseconds(150));
    } catch (const Error &error) {
      code = error.code;
    }
    {
      std::lock_guard<std::mutex> lock(mutex);
      finished = true;
    }
    condition.notify_one();
    server.join();
    check(code == "HTTP_TIMEOUT" && now() - start < 2000,
          "HTTP/TLS stall deadline cancels transport");
  }
  std::cout << "PASS: stalled HTTP headers/body and TLS handshake time out and release sockets\n";
}
void storage_failure_test() {
  Temp temp;
  Store store(temp.path);
  bool failed = false;
  store.on_failure([&] { failed = true; });
  sqlite3 *writer = nullptr;
  check(sqlite3_open((temp.path + "/agent.db").c_str(), &writer) == SQLITE_OK,
        "Open contending writer");
  check(sqlite3_exec(writer, "BEGIN IMMEDIATE", nullptr, nullptr, nullptr) == SQLITE_OK,
        "Lock journal");
  const auto start = now();
  rejects([&] { store.cache_put("blocked", "value"); }, "STORAGE_BUSY");
  check(failed && now() - start < 2000, "Storage fault is explicit and bounded");
  sqlite3_exec(writer, "ROLLBACK", nullptr, nullptr, nullptr);
  sqlite3_close(writer);
  check(store.cache_get("blocked").is_null(), "Failed write never appears committed");
  std::cout << "PASS: bounded SQLite contention, fault callback and no partial commit\n";
}
void stream_benchmark(int delta_size, int bytes, int seconds, int batch = 1) {
  if (delta_size < 1 || delta_size > 1000 || bytes < 1 || bytes > 16 * 1024 * 1024 || seconds < 1 ||
      seconds > 28800)
    throw Error("USAGE", "--benchmark DELTA(1..1000) BYTES(1..16MiB) MAX_SECONDS(1..28800)");
  Temp temp;
  Store store(temp.path);
  for (int i = 0; i < 4; ++i)
    store.save({{"id", "bench-" + std::to_string(i)},
                {"projectId", "project"},
                {"mode", "web"},
                {"state", "ready"},
                {"running", true},
                {"createdAt", now()}});
  const auto start = std::chrono::steady_clock::now();
  const auto cpu_start = std::clock();
  std::vector<double> durations;
  size_t events = 0;
  int characters = 0;
  int64_t wal_peak = 0;
  Json last[4];
  Json pending = Json::array();
  const auto flush = [&] {
    if (pending.empty())
      return;
    const auto began = std::chrono::steady_clock::now();
    const auto results = store.event_batch(pending);
    const auto duration =
        std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - began).count();
    if (events % 16 == 0)
      durations.push_back(duration);
    for (size_t i = 0; i < results.size(); ++i) {
      const auto session = pending[i]["session"].get<std::string>();
      last[session.back() - '0'] = results[i];
    }
    events += results.size();
    pending = Json::array();
  };
  while (characters < bytes &&
         std::chrono::steady_clock::now() - start < std::chrono::seconds(seconds)) {
    const std::string delta(std::min(delta_size, bytes - characters), 'x');
    for (int i = 0; i < 4; ++i) {
      pending.push_back({{"session", "bench-" + std::to_string(i)},
                         {"type", "item/agentMessage/delta"},
                         {"data", {{"itemId", "stream"}, {"delta", delta}}}});
      if (int(pending.size()) >= batch)
        flush();
    }
    characters += delta.size();
    if (events % 4096 == 0) {
      std::error_code ignored;
      wal_peak = std::max(
          wal_peak, int64_t(std::filesystem::file_size(temp.path + "/agent.db-wal", ignored)));
    }
  }
  flush();
  for (int i = 0; i < 4; ++i) {
    const auto offset = std::max(0, characters - 4096);
    auto part =
        store.content("bench-" + std::to_string(i), last[i]["seq"], offset, last[i]["revision"]);
    check(part["text"] == std::string(characters - offset, 'x') && part["more"] == false,
          "Benchmark content remains consistent");
  }
  std::sort(durations.begin(), durations.end());
  rusage usage{};
  getrusage(RUSAGE_SELF, &usage);
  std::error_code ignored;
  const auto wal = std::filesystem::file_size(temp.path + "/agent.db-wal", ignored);
  std::cout
      << Json{{"sessions", 4},
              {"deltaCharacters", delta_size},
              {"targetCharactersPerSession", bytes},
              {"charactersPerSession", characters},
              {"completed", characters == bytes},
              {"events", events},
              {"elapsedSeconds",
               std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count()},
              {"cpuSeconds", double(std::clock() - cpu_start) / CLOCKS_PER_SEC},
              {"batchSize", batch},
              {batch == 1 ? "eventP95MicrosecondsSampled" : "batchP95MicrosecondsSampled",
               durations[durations.size() * 95 / 100]},
              {"peakRssKiB", usage.ru_maxrss},
              {"databaseBytes", std::filesystem::file_size(temp.path + "/agent.db")},
              {"walPeakBytes", std::max(wal_peak, int64_t(wal))}}
             .dump()
      << '\n';
}
void performance_test() {
  Temp temp;
  Store store(temp.path);
  store.save({{"id", "a"}, {"state", "ready"}});
  store.save({{"id", "b"}, {"state", "ready"}});
  Json entries = Json::array();
  for (int i = 0; i < 128; ++i)
    entries.push_back({{"session", i % 2 ? "a" : "b"},
                       {"type", "item/agentMessage/delta"},
                       {"data", {{"itemId", "reply"}, {"delta", "你好"}}}});
  auto result = store.event_batch(entries);
  check(result.size() == 128, "Batch returns every committed projection");
  const auto before = store.history("a");
  const auto body = store.content("a", result.back()["seq"], 0, result.back()["revision"]);
  std::string expected;
  for (int i = 0; i < 64; ++i)
    expected += "你好";
  check(body["text"] == expected, "Batched interleaved Unicode streams reconstruct exactly");
  entries = Json::array(
      {{{"session", "a"}, {"type", "user"}, {"data", {{"text", "rollback"}}}}, {{"session", "a"}}});
  try {
    store.event_batch(entries);
    throw std::runtime_error("Expected malformed batch rejection");
  } catch (const Json::exception &) {
  }
  check(store.history("a") == before && !store.get("a").contains("title"),
        "A failed batch rolls back events, projection and session changes");
  store.event("a", "user", {{"text", "after rollback"}});
  check(store.get("a")["title"] == "after rollback", "Cached statements reset after rollback");
  store.cache_put("upload:expired", {{"completedAt", now() - 86400001}});
  store.cache_put("upload:recent", {{"completedAt", now()}});
  store.cache_put("other", {{"completedAt", 0}});
  store.begin("identity", "fingerprint");
  store.cleanup();
  check(store.cache_get("upload:expired").is_null() &&
            !store.cache_get("upload:recent").is_null() && !store.cache_get("other").is_null() &&
            store.request_status("identity")["state"] == "received",
        "Expiry only removes completed uploads, preserving durable request identities");
  std::cout << "PASS: batched journal atomicity, Unicode, statement reuse and indexed expiry\n";
}
void files_test() {
  Temp t, outside;
  WorkspaceFiles files;
  auto call = [&](Json data, std::string owner = "owner", std::string sandbox = "workspace-write") {
    return files.request(t.path, sandbox, owner, data);
  };
  auto begin = [&](std::string id, bool overwrite = false) {
    return call({{"operation", "begin"},
                 {"uploadId", id},
                 {"path", "proof.bin"},
                 {"size", 3},
                 {"overwrite", overwrite}});
  };
  for (auto path : {"../escape", "/etc", "a/../b", "a//b", "a/"})
    rejects([&] { call({{"operation", "list"}, {"path", path}}); }, "INVALID_PATH");
  std::filesystem::create_directory_symlink(outside.path, t.path + "/escape");
  rejects([&] { call({{"operation", "list"}, {"path", "escape"}}); }, "FORBIDDEN");
  check(call({{"operation", "list"}})["entries"].empty(), "Symlinks hidden from list");
  rejects(
      [&] {
        call({{"operation", "begin"}, {"uploadId", "readonly"}, {"path", "x"}, {"size", 0}},
             "owner", "read-only");
      },
      "FORBIDDEN");
  begin("upload");
  auto chunk =
      Json{{"operation", "chunk"}, {"uploadId", "upload"}, {"offset", 0}, {"data", "AAH/"}};
  rejects([&] { call(chunk, "other"); }, "UPLOAD_NOT_FOUND");
  rejects([&] { files.request(outside.path, "workspace-write", "owner", chunk); },
          "UPLOAD_NOT_FOUND");
  rejects([&] { call({{"operation", "finish"}, {"uploadId", "upload"}}); }, "UPLOAD_INCOMPLETE");
  check(call(chunk)["offset"] == 3 && call(chunk)["offset"] == 3, "Chunk retry is idempotent");
  chunk["data"] = "YWJj";
  rejects([&] { call(chunk); }, "UPLOAD_CONFLICT");
  check(!std::filesystem::exists(t.path + "/proof.bin"), "Upload is not published early");
  call({{"operation", "finish"}, {"uploadId", "upload"}});
  auto first = call({{"operation", "read"}, {"path", "proof.bin"}}, "owner", "read-only");
  check(first["data"] == "AAH/" && first["size"] == 3, "Binary download in read-only mode");
  rejects([&] { begin("existing"); }, "FILE_EXISTS");
  begin("replace", true);
  call({{"operation", "cancel"}, {"uploadId", "replace"}});
  check(call({{"operation", "read"}, {"path", "proof.bin"}})["data"] == "AAH/",
        "Cancel preserves target");
  begin("race", true);
  std::ofstream(t.path + "/proof.bin") << "changed";
  call({{"operation", "chunk"}, {"uploadId", "race"}, {"offset", 0}, {"data", "YWJj"}});
  rejects([&] { call({{"operation", "finish"}, {"uploadId", "race"}}); }, "FILE_CHANGED");
  rejects(
      [&] {
        const auto request =
            Json{{"operation", "read"}, {"path", "proof.bin"}, {"version", first["version"]}};
        call(request);
      },
      "FILE_CHANGED");
  call({{"operation", "begin"}, {"uploadId", "pipeline"}, {"path", "pipeline.bin"}, {"size", 6}});
  auto later =
      Json{{"operation", "chunk"}, {"uploadId", "pipeline"}, {"offset", 3}, {"data", "ZGVm"}};
  check(call(later)["offset"] == 0 && call(later)["offset"] == 0,
        "Out-of-order chunk and retry wait for the missing prefix");
  later["data"] = "YWJj";
  rejects([&] { call(later); }, "UPLOAD_CONFLICT");
  rejects(
      [&] {
        call({{"operation", "chunk"}, {"uploadId", "pipeline"}, {"offset", 2}, {"data", "YWJj"}});
      },
      "UPLOAD_CONFLICT");
  rejects([&] { call({{"operation", "finish"}, {"uploadId", "pipeline"}}); }, "UPLOAD_INCOMPLETE");
  check(call({{"operation", "chunk"},
              {"uploadId", "pipeline"},
              {"offset", 0},
              {"data", "YWJj"}})["offset"] == 6,
        "Missing prefix drains the reorder buffer");
  call({{"operation", "finish"}, {"uploadId", "pipeline"}});
  check(call({{"operation", "read"}, {"path", "pipeline.bin"}})["data"] == "YWJjZGVm",
        "Pipelined upload publishes exact ordered bytes");
  std::filesystem::remove(t.path + "/pipeline.bin");
  files.clear();
  check(call({{"operation", "list"}})["entries"].size() == 1, "Staging files cleaned up");
  std::cout << "PASS: workspace file isolation, binary transfer, retry, read-only, cancellation "
               "and overwrite conflict\n";
}
void process_test(bool real, bool task) {
  Temp temp;
  asio::io_context io;
  bool success = false, finished = false;
  std::string failure;
  Json config = {{"codexPath", real ? "codex" : "node"},
                 {"codexArgs", real ? Json::array()
                                    : Json::array({std::string(COC_SOURCE_DIR) +
                                                   "/tests/fixtures/fake-codex.mjs"})},
                 {"sandbox", task ? "workspace-write" : "read-only"}};
  verify_codex(config);
  if (!real) {
    codex_proxy_fixture(config, temp.path);
    auto version_config = [](const std::string &script) {
      return Json{{"codexPath", "node"}, {"codexArgs", Json::array({"-e", script, "--"})}};
    };
    auto newer = version_config("console.log('codex-cli 0.999.0')");
    check(verify_codex(newer) == "codex-cli 0.999.0",
          "Agent and CLI accept and report a different Codex version");
    auto older = version_config("console.log('codex-cli 0.130.0')");
    check(verify_codex(older) == "codex-cli 0.130.0", "Older Codex versions are accepted");
    auto empty = version_config("");
    rejects([&] { verify_codex(empty); }, "CODEX_VERSION");
    auto failed = version_config("console.log('codex-cli 0.999.0'); process.exit(1)");
    rejects([&] { verify_codex(failed); }, "CODEX_VERSION");
  }
  std::shared_ptr<CodexProcess> p;
  asio::steady_timer timeout(io, std::chrono::seconds(task ? 120 : 15));
  auto end = [&](bool ok, std::string error = "") {
    if (finished)
      return;
    finished = true;
    success = ok;
    failure = std::move(error);
    timeout.cancel();
    p->close();
  };
  p = std::make_shared<CodexProcess>(
      io, config, temp.path,
      [&](Json m) {
        if (m.contains("method") && m.contains("id")) {
          if (!real && m["method"] == "item/commandExecution/requestApproval") {
            p->send({{"id", m["id"]}, {"result", {{"decision", "decline"}}}});
          } else {
            p->send({{"id", m["id"]},
                     {"error",
                      {{"code", -32000},
                       {"message", "Unattended test denies additional permissions"}}}});
            end(false, "Unexpected interactive request");
          }
        }
        if (m.value("method", "") == "turn/completed") {
          if (m.at("params").at("turn").value("status", "") != "completed") {
            end(false, "Turn failed");
            return;
          }
          if (task) {
            std::ifstream f(temp.path + "/proof.txt");
            std::string s((std::istreambuf_iterator<char>(f)), {});
            end(s == "coc-smoke-ok\n", "Unexpected proof.txt content");
          } else
            end(true);
        }
      },
      [&] {
        if (!finished)
          end(false, "Codex exited before completion");
      });
  p->start();
  timeout.async_wait([&](auto ec) {
    if (!ec)
      end(false, "Codex test timed out");
  });
  p->initialize([&](Json, Json e) {
    if (!e.is_null()) {
      end(false, e.dump());
      return;
    }
    p->request(
        "thread/start",
        {{"cwd", temp.path},
         {"sandbox", config["sandbox"]},
         {"approvalPolicy", "on-request"},
         {"ephemeral", true}},
        [&](Json r, Json e) {
          if (!e.is_null()) {
            end(false, e.dump());
            return;
          }
          if (real && !task) {
            end(r.contains("thread") && r["thread"].contains("id"), "No thread");
            return;
          }
          std::string prompt =
              task ? "Local integration smoke test. In the current working directory only, create "
                     "proof.txt containing exactly coc-smoke-ok followed by a newline. Do not read "
                     "any other project, access the network, or change any other files. Then stop."
                   : "approval";
          p->request("turn/start",
                     {{"threadId", r.at("thread").at("id")},
                      {"input", Json::array({{{"type", "text"},
                                              {"text", prompt},
                                              {"text_elements", Json::array()}}})}},
                     [&](Json, Json e) {
                       if (!e.is_null())
                         end(false, e.dump());
                     });
        });
  });
  io.run();
  check(success, failure.c_str());
  if (task)
    std::cout << "PASS: real Codex model created proof.txt in temporary project\n";
  else if (real)
    std::cout << "PASS: C++ initialize + thread/start against real Codex; no model call\n";
  else
    std::cout << "PASS: C++ subprocess bidirectional RPC and approval rejection\n";
}
} // namespace
int main(int argc, char **argv) {
  try {
    std::cout.setf(std::ios::unitbuf);
    std::cerr.setf(std::ios::unitbuf);
    signal(SIGPIPE, SIG_IGN);
    std::string mode = argc > 1 ? argv[1] : "";
    if (mode == "--proxy") {
      proxy_tests();
    } else if (mode == "--external-refresh") {
      external_refresh_test();
    } else if (mode == "--external-approval") {
      if (argc != 5 && argc != 6)
        throw Error("USAGE", "--external-approval ENDPOINT THREAD CWD [--allow]");
      external_approval_contract(argv[2], argv[3], argv[4],
                                 argc == 6 && std::string(argv[5]) == "--allow");
    } else if (mode == "--benchmark" || mode == "--benchmark-batch") {
      if (argc != 5)
        throw Error("USAGE", "--benchmark DELTA BYTES MAX_SECONDS");
      stream_benchmark(std::stoi(argv[2]), std::stoi(argv[3]), std::stoi(argv[4]),
                       mode == "--benchmark-batch" ? 128 : 1);
    } else if (mode == "--codex" || mode == "--task")
      process_test(true, mode == "--task");
    else {
      std::cout << "RUN: core\n";
      core();
      proxy_tests();
      {
        Temp remote;
        remote_configuration_fixture(remote.path);
      }
      external_test();
      external_refresh_test();
      std::cout << "RUN: history\n";
      history_subscriber_test();
      history_subscription_test();
      history_test();
      std::cout << "RUN: performance invariants\n";
      performance_test();
      std::cout << "RUN: files\n";
      files_test();
      std::cout << "RUN: stabilization\n";
      stabilization_test();
      std::cout << "RUN: HTTP deadlines\n";
      http_deadline_test();
      std::cout << "RUN: storage failures\n";
      storage_failure_test();
      std::cout << "RUN: subprocess\n";
      process_test(false, false);
    }
    return 0;
  } catch (const std::exception &e) {
    std::cerr << "FAIL: " << e.what() << '\n';
    return 1;
  }
}
