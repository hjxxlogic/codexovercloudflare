#include "coc/common.hpp"
#include "coc/process.hpp"
#include "coc/store.hpp"
#include <fstream>
#include <iostream>
#include <sys/stat.h>
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
void core() {
  check(relay_url("https://r.xlogic.cc/").origin == "https://r.xlogic.cc", "Relay normalization");
  check(relay_url("http://[::1]:8787").host == "::1", "IPv6 loopback");
  for (auto s : {"http://evil.example", "https://user:pass@r.xlogic.cc", "https://r.xlogic.cc/path",
                 "https://r.xlogic.cc?secret=x", "https://r.xlogic.cc:99999"})
    rejects([&] { relay_url(s); }, "INVALID_RELAY");
  rejects([] { web_command({{"action", "exec"}, {"requestId", "request"}}); }, "INVALID_REQUEST");
  rejects([] { web_command({{"action", "sync"}, {"after", -1}}); }, "INVALID_REQUEST");
  rejects(
      [] {
        guard_cli({{"method", "account/login/start"}}, "/p", "workspace-write");
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
  std::cout
      << (task ? "PASS: real Codex model created proof.txt in temporary project\n"
               : real ? "PASS: C++ initialize + thread/start against real Codex; no model call\n"
                      : "PASS: C++ subprocess bidirectional RPC and approval rejection\n");
}
} // namespace
int main(int argc, char **argv) {
  try {
    signal(SIGPIPE, SIG_IGN);
    std::string mode = argc > 1 ? argv[1] : "";
    if (mode == "--codex" || mode == "--task")
      process_test(true, mode == "--task");
    else {
      core();
      process_test(false, false);
    }
    return 0;
  } catch (const std::exception &e) {
    std::cerr << "FAIL: " << e.what() << '\n';
    return 1;
  }
}
