#include "coc/access.hpp"
#include "coc/approvals.hpp"
#include "coc/common.hpp"
#include "coc/delivery.hpp"
#include "coc/external.hpp"
#include "coc/files.hpp"
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
    sender.receive({{"type", "delivery-window"},
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
    sender.receive({{"type", "delivery-result"},
                    {"lane", "normal"},
                    {"seq", 1},
                    {"payload", {{"id", 1}, {"result", {{"ok", true}}}}},
                    {"window",
                     {{"stream", "receiver"},
                      {"instance", "journal"},
                      {"received", 1},
                      {"receivedBytes", frame["end"]},
                      {"credit", 2},
                      {"byteCredit", 262144}}}});
    check(replies.size() == 1 && !sender.pending(), "Native command completes durably");
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
      journal.delivery_receive("stream", 2, body.size() * 2, body);
      rejects([&] { journal.delivery_receive("stream", 3, body.size() * 3, body); },
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
      check(journal.delivery_window("stream")["credit"] == 4, "Terminal commands release credit");
      journal.delivery_receive("stream", 3, body.size() * 3, body);
      journal.delivery_start("stream", 3);
      journal.delivery_finish("stream", 3, {{"ok", true}});
      check(journal.delivery_receive("stream", 3, body.size() * 3,
                                     body)["record"]["result"]["ok"] == true,
            "Completed command result replays after lost acknowledgement");
    }
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
  check(web_fingerprint(
            {{"action", "approval"}, {"requestId", "r"}, {"approvalId", "1"}, {"allow", false}}) ==
            "{\"action\":\"approval\",\"requestId\":\"r\",\"approvalId\":\"1\",\"allow\":false}",
        "Legacy request fingerprint compatibility");
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
