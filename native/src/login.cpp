#include "coc/login.hpp"
#include <cstdlib>
#include <iostream>
#include <termios.h>
#include <thread>
#include <unistd.h>
namespace coc {
Options::Options(int argc, char **argv) {
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--takeover")
      takeover = true;
    else if (a == "--api-key")
      api_key = true;
    else if (a.rfind("--api-key=", 0) == 0)
      throw Error("USAGE", "Use --api-key with COC_API_KEY or standard input");
    else if (a == "--help") {
      args = {"help"};
      break;
    } else if (a.rfind("--", 0) == 0) {
      const auto key = a.substr(2);
      if (key != "relay" && key != "host" && key != "name" && key != "message" && key != "config" &&
          key != "project" && key != "project-id" && key != "before" && key != "seq" &&
          key != "offset" && key != "offline" && key != "cache-dir")
        throw Error("USAGE", "Unknown option: " + a);
      if (++i >= argc)
        throw Error("USAGE", "Missing value: " + a);
      values[key] = argv[i];
    } else
      args.push_back(a);
  }
}
std::string Options::get(const std::string &key, const std::string &fallback) const {
  auto it = values.find(key);
  return it == values.end() ? fallback : it->second;
}
std::filesystem::path config_path(const char *env, const std::string &relative) {
  if (auto value = getenv(env))
    return value;
  auto home = getenv("HOME");
  if (!home)
    throw Error("CONFIG_ERROR", std::string("HOME or ") + env + " must be set");
  return std::filesystem::path(home) / ".config" / relative;
}
Json device_login(const std::string &relay, const std::string &role, const std::string &name,
                  const std::string &host, bool api_key, const std::string &message) {
  auto url = relay_url(relay);
  if (api_key) {
    std::string value;
    if (const auto env = getenv("COC_API_KEY"))
      value = env;
    else {
      struct HiddenInput {
        termios saved{};
        bool active = false;
        HiddenInput() {
          if (isatty(STDIN_FILENO)) {
            if (tcgetattr(STDIN_FILENO, &saved) != 0)
              throw Error("INPUT", "Cannot secure terminal input");
            auto hidden = saved;
            hidden.c_lflag &= ~ECHO;
            if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &hidden) != 0)
              throw Error("INPUT", "Cannot secure terminal input");
            active = true;
          }
        }
        ~HiddenInput() {
          if (active)
            tcsetattr(STDIN_FILENO, TCSAFLUSH, &saved);
        }
      } hidden;
      std::cerr << "API_KEY: " << std::flush;
      std::getline(std::cin, value);
      std::cerr << '\n';
    }
    if (value.empty() || value.size() > 500)
      throw Error("INPUT", "Invalid API key input");
    auto result = http_json(url, "/api/v1/auth/api-key",
                            {{"apiKey", value}, {"role", role}, {"name", name}, {"hostId", host}});
    result["token"] = value;
    result["relay"] = url.origin;
    return result;
  }
  Json input = {{"role", role}, {"name", name}};
  if (role == "cli") {
    input["message"] = message;
    if (!host.empty()) {
      if (!valid_id(host))
        throw Error("USAGE", "Invalid target host ID");
      input["requestedHostId"] = host;
    }
  }
  auto request = http_json(url, "/api/v1/auth/device/start", input);
  if (role == "cli" && !host.empty()) {
    if (request.value("requestedHostId", "") != host)
      throw Error("PROTOCOL_MISMATCH", "Relay does not support explicitly targeted login");
    std::cout << "Requested server: " << host
              << "\nThat Agent or the administrator can approve this request.\n";
  } else if (role == "cli")
    std::cout << "The administrator will select the server for this request.\n";
  std::cout << "Authorize in browser: " << url.origin << request.at("url").get<std::string>()
            << "\nPairing code: " << request.at("code").get<std::string>()
            << "\nWaiting for approval (5 minutes)...\n"
            << std::flush;
  while (now() < request.at("expires").get<int64_t>()) {
    auto result = http_json(url, "/api/v1/auth/device/poll",
                            {{"id", request.at("id")}, {"pollSecret", request.at("pollSecret")}});
    if (result.at("state") == "approved") {
      if (role == "cli" && !host.empty() && result.value("hostId", "") != host)
        throw Error("FORBIDDEN", "Approved server differs from the requested server");
      result.erase("state");
      result["relay"] = url.origin;
      return result;
    }
    if (result.at("state") == "rejected")
      throw Error("LOGIN_REJECTED", "Login request rejected");
    std::this_thread::sleep_for(std::chrono::seconds(2));
  }
  throw Error("LOGIN_EXPIRED", "Login request expired; run login again");
}
Json credential_status(const Json &credential) {
  const auto role = credential.at("role").get<std::string>();
  return http_json(relay_url(credential.at("relay")),
                   role == "agent" ? "/api/v1/agent/status" : "/api/v1/hosts", nullptr,
                   credential.at("token"));
}
} // namespace coc
