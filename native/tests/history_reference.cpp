#include "coc/delivery.hpp"
#include <iostream>
using namespace coc;
namespace {
void check(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class F> void rejects(F fn, const std::string &code) {
  try {
    fn();
  } catch (const Error &error) {
    check(error.code == code, error.what());
    return;
  }
  throw std::runtime_error("Expected " + code);
}
void run(const std::filesystem::path &root) {
  for (const auto &fixture :
       read_json(std::filesystem::path(COC_SOURCE_DIR) / "tests/history-reference-fixtures.json")) {
    if (fixture.at("error"))
      rejects([&] { history_reference_descriptor(fixture.at("input")); }, "INVALID_REQUEST");
    else
      check(history_reference_descriptor(fixture.at("input")) == fixture.at("input"),
            "Shared immutable history shape");
  }
  Store receiver((root / "agent").string());
  const std::string id = "host~session";
  receiver.save({{"id", id}});
  const std::string text = "original 用户文本 " + std::string(12000, 'x');
  const auto event = receiver.event(id, "user", {{"text", text}});
  const auto reference = receiver.history_reference(id, event.at("seq"));
  check(reference.at("digest") == delivery_digest(text) && reference.at("length") == text.size(),
        "Original history fixes UTF-8 length and digest");
  Store client((root / "client").string(), false);
  std::vector<Json> sent, results;
  CommandDelivery sender(client, "scope", [&](Json result) {
    const auto durable = client.cache_get("scope:v2");
    check(durable.at("normal").at("results").at("received") == 1,
          "Client commits descriptor before callback");
    results.push_back(result);
  });
  sender.connect([&](Json frame) { sent.push_back(frame); });
  const auto exchange = sent.back().at("exchangeId");
  for (const auto &lane : {"normal", "priority"}) {
    auto window = receiver.delivery_open(lane, id, 2, max_frame, lane);
    sender.receive({{"type", "delivery-window"},
                    {"lane", lane},
                    {"exchangeId", exchange},
                    {"window", window}});
  }
  sender.submit({{"id", 7}, {"method", "turn/start"}, {"params", Json::object()}});
  const auto command = sent.back();
  check(command.at("type") == "delivery-command", "Command published after receiver windows");
  receiver.delivery_receive("normal", command.at("seq"), command.at("end"), command.at("body"));
  const Json payload = {{"id", 7},
                        {"result", {{"turnId", "original-turn"}, {"history", reference}}}};
  receiver.delivery_finish("normal", command.at("seq"), payload);
  const auto record = receiver.delivery_record("normal", command.at("seq"));
  Json frame = {{"type", "delivery-result"},
                {"lane", "normal"},
                {"window", receiver.delivery_window("normal")}};
  frame["seq"] = command.at("seq");
  for (const auto &key : {"resultSeq", "resultEnd", "resultBody", "resultDigest", "resultStream"})
    frame[key] = record.at(key);
  sender.receive(frame);
  check(results.size() == 1 && results.at(0) == payload,
        "History reference preserves original terminal result");
  check(sent.back().at("type") == "delivery-receipt",
        "History descriptor needs no transfer fetch before ACK");
  receiver.delivery_result_ack("normal", record.at("resultSeq"), record.at("resultEnd"));
  check(receiver.delivery_record("normal", command.at("seq")).at("resultBody").is_null(),
        "Result body can retire independently");
  std::string recovered;
  int64_t offset = 0;
  do {
    auto part = receiver.history_content(id, reference, offset);
    recovered += part.at("text").get<std::string>();
    offset = part.at("more").get<bool>() ? part.at("nextOffset").get<int64_t>() : -1;
  } while (offset >= 0);
  check(recovered == text, "ACK leaves immutable authoritative history intact");
  rejects([&] { receiver.history_content("other~session", reference, 0); }, "FORBIDDEN");
  auto replaced = reference;
  replaced["agentInstance"] = "another-store";
  rejects([&] { receiver.history_content(id, replaced, 0); }, "DELIVERY_STATE_MISMATCH");
  auto delta = Json{{"turnId", "turn"}, {"itemId", "item"}, {"delta", "before"}};
  const auto changing = receiver.event(id, "item/agentMessage/delta", delta);
  const auto original = receiver.history_reference(id, changing.at("seq"));
  delta["delta"] = "after";
  receiver.event(id, "item/agentMessage/delta", delta);
  rejects([&] { receiver.history_content(id, original, 0); }, "CONTENT_UNAVAILABLE");
  sqlite3 *database = nullptr;
  check(sqlite3_open((root / "agent/agent.db").u8string().c_str(), &database) == SQLITE_OK,
        "Open explicit history cleanup");
  check(sqlite3_exec(database, ("DELETE FROM history WHERE seq=" + event.at("seq").dump()).c_str(),
                     nullptr, nullptr, nullptr) == SQLITE_OK,
        "Explicitly remove referenced history");
  sqlite3_close(database);
  rejects([&] { receiver.history_content(id, reference, 0); }, "CONTENT_UNAVAILABLE");
  check(client.cache_get("scope:v2").at("normal").at("entries").empty(),
        "Expired history cannot reopen completed business");
}
} // namespace
int main() {
  const auto root = std::filesystem::temp_directory_path() / ("coc-history-reference-" + uuid());
  try {
    run(root);
    std::filesystem::remove_all(root);
    std::cout << "PASS: immutable history references, shared validation, durable client completion "
                 "and independent ACK/expiry\n";
    return 0;
  } catch (const std::exception &error) {
    std::filesystem::remove_all(root);
    std::cerr << "FAIL: " << error.what() << '\n';
    return 1;
  }
}
