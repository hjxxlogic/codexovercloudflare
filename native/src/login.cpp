#include "coc/login.hpp"
#include <cstdlib>
#include <iostream>
#include <thread>
namespace coc {
Options::Options(int argc, char **argv) {
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--takeover")
      takeover = true;
    else if (a == "--help") {
      args = {"help"};
      break;
    } else if (a.rfind("--", 0) == 0) {
      const auto key = a.substr(2);
      if (key != "relay" && key != "host" && key != "name" && key != "config" && key != "project" &&
          key != "project-id")
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
                  const std::string &host) {
  auto url = relay_url(relay);
  auto request = http_json(url, "/api/v1/auth/device/start",
                           {{"role", role}, {"name", name}, {"hostId", host}});
  std::cout << "Authorize in browser: " << url.origin << request.at("url").get<std::string>()
            << "\nPairing code: " << request.at("code").get<std::string>()
            << "\nWaiting for administrator approval (5 minutes)...\n"
            << std::flush;
  while (now() < request.at("expires").get<int64_t>()) {
    auto result = http_json(url, "/api/v1/auth/device/poll",
                            {{"id", request.at("id")}, {"pollSecret", request.at("pollSecret")}});
    if (result.at("state") == "approved") {
      result.erase("state");
      result["relay"] = url.origin;
      return result;
    }
    if (result.at("state") == "rejected")
      throw Error("LOGIN_REJECTED", "Administrator rejected login");
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
