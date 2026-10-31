#pragma once
#include "coc/proxy.hpp"
#include "coc/remote_config.hpp"
#include <fstream>
#ifndef _WIN32
#include <sys/stat.h>
#endif
inline void remote_configuration_fixture(const std::filesystem::path &root) {
  using namespace coc;
  std::filesystem::create_directories(root);
  auto require = [](bool value) {
    if (!value)
      throw std::runtime_error("Remote configuration fixture failed");
  };
  auto path = root / "remote-client.json";
  Json original = {{"version", 2},
                   {"entries", Json::array({{{"relay", "https://relay.test"},
                                             {"hostId", "host"},
                                             {"name", "Host"},
                                             {"token", "private-token"}}})},
                   {"selected", "https://relay.test~host"},
                   {"autoUpdate", false}};
  save_private(path, original);
  RemoteConfiguration config(path, false);
  bool restart = false;
  auto read = config.request({{"action", "read"}}, false, restart);
  require(Json::parse(read.at("text").get<std::string>()) == original && !restart);
  auto replacement = original;
  replacement["proxy"] = "http://127.0.0.1:8080";
  Json replace = {{"action", "replace"},
                  {"requestId", "replace-one"},
                  {"revision", read.at("revision")},
                  {"text", replacement.dump()}};
  auto result = config.request(replace, false, restart);
  require(read_json(path) == replacement && !restart);
  require(read_json(std::filesystem::u8path(path.u8string() + ".remote.previous")) == original);
  auto expect = [&](const Json &request, const std::string &code) {
    try {
      config.request(request, true, restart);
    } catch (const Error &error) {
      require(error.code == code);
      return;
    }
    throw std::runtime_error("Missing remote configuration rejection");
  };
  require(config.request(replace, false, restart) == result);
  // Recover both crash windows without blindly repeating a completed write.
  auto receipt_path = std::filesystem::u8path(path.u8string() + ".remote") / "replace-one.json";
  auto receipt = read_json(receipt_path);
  receipt["phase"] = "prepared";
  save_private(receipt_path, receipt);
  require(config.request(replace, false, restart) == result);
  receipt["phase"] = "prepared";
  save_private(receipt_path, receipt);
  save_private_text(path, read.at("text").get<std::string>());
  require(config.request(replace, false, restart) == result);
  require(read_json(path) == replacement);
  auto conflict = replace;
  conflict["text"] = original.dump();
  expect(conflict, "IDEMPOTENCY_CONFLICT");
  conflict["requestId"] = "stale";
  expect(conflict, "CONFIG_CONFLICT");
  conflict["revision"] = result.at("revision");
  conflict["text"] = "{invalid";
  expect(conflict, "CONFIG_ERROR");
  conflict["text"] =
      Json{{"version", 2}, {"entries", Json::array()}, {"selected", "missing"}}.dump();
  expect(conflict, "CONFIG_ERROR");
  Json reboot = {{"action", "restart"},
                 {"requestId", "restart-one"},
                 {"revision", result.at("revision")},
                 {"allowActive", false}};
  expect(reboot, "SESSION_BUSY");
  reboot["allowActive"] = true;
  auto restarted = config.request(reboot, true, restart);
  require(restart && restarted.at("state") == "restart-requested");
  RemoteConfiguration reopened(path, false);
  require(reopened.request(reboot, true, restart) == restarted && !restart);
  require(reopened.request(replace, false, restart) == result && !restart);
  // Receipts contain only digests and outcomes, never credentials or proxy URLs.
  for (const auto &entry :
       std::filesystem::directory_iterator(std::filesystem::u8path(path.u8string() + ".remote"))) {
    auto text = read_json(entry.path()).dump();
    require(text.find("private-token") == std::string::npos &&
            text.find("8080") == std::string::npos);
  }
#ifndef _WIN32
  struct stat mode {};
  require(stat(path.c_str(), &mode) == 0 && (mode.st_mode & 0777) == 0600);
#endif
  require(read_json(path) == replacement);
  // Pure proxy validation does not alter a running process's network policy.
  configure_proxy("");
  validate_proxy("http://127.0.0.1:8080");
  require(!proxy_enabled());
  auto agent_path = root / "remote-agent.json";
  Json agent = {
      {"hostId", "host"},
      {"token", std::string(24, 'x')},
      {"dataDir", (root / "state").u8string()},
      {"autoUpdate", false},
      {"projects",
       Json::array({{{"id", "project"}, {"name", "Project"}, {"path", root.u8string()}}})}};
  save_private(agent_path, agent);
  RemoteConfiguration agent_config_file(agent_path, true);
  auto agent_read = agent_config_file.request({{"action", "read"}}, false, restart);
  Json agent_replace = {{"action", "replace"},
                        {"requestId", "agent-one"},
                        {"revision", agent_read.at("revision")},
                        {"text", agent.dump()}};
  agent_config_file.request(agent_replace, false, restart);
  agent["codexUseProxy"] = "true";
  agent_replace["requestId"] = "invalid-agent";
  agent_replace["revision"] =
      agent_config_file.request({{"action", "read"}}, false, restart).at("revision");
  agent_replace["text"] = agent.dump();
  try {
    agent_config_file.request(agent_replace, false, restart);
  } catch (const Error &error) {
    require(error.code == "CONFIG_ERROR");
    return;
  }
  throw std::runtime_error("Missing Agent configuration validation");
}
