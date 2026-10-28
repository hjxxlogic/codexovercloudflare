#include "coc/login.hpp"
#include <algorithm>
#include <cstdlib>
#include <iostream>
#ifndef _WIN32
#include <termios.h>
#include <unistd.h>
#else
#include "coc/windows.hpp"
#endif
#include <thread>
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
          key != "offset" && key != "offline" && key != "cache-dir" && key != "request-id" &&
          key != "revision" && key != "cursor" && key != "session" && key != "approval-id" &&
          key != "proxy" && key != "access-config")
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
#ifdef _WIN32
  auto key = wide(env);
  if (auto value = _wgetenv(key.c_str()))
    return std::filesystem::path(value);
  if (auto appdata = _wgetenv(L"LOCALAPPDATA"))
    return std::filesystem::path(appdata) / relative;
  if (auto home = _wgetenv(L"USERPROFILE"))
    return std::filesystem::path(home) / ".config" / relative;
  throw Error("CONFIG_ERROR", std::string("LOCALAPPDATA, USERPROFILE or ") + env + " must be set");
#else
  if (auto value = getenv(env))
    return std::filesystem::u8path(value);
  auto home = getenv("HOME");
  if (!home)
    throw Error("CONFIG_ERROR", std::string("HOME or ") + env + " must be set");
  return std::filesystem::u8path(home) / ".config" / relative;
#endif
}
Json device_login(const std::string &relay, const std::string &role, const std::string &name,
                  const std::string &host, bool api_key, const std::string &message) {
  const auto instance_name = display_name(name);
  auto url = relay_url(relay);
  if (api_key) {
    std::string value;
    if (const auto env = getenv("COC_API_KEY"))
      value = env;
    else {
#ifdef _WIN32
      struct HiddenInput {
        HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
        DWORD saved = 0;
        bool active = false;
        HiddenInput() {
          if (GetConsoleMode(input, &saved)) {
            if (!SetConsoleMode(input, saved & ~ENABLE_ECHO_INPUT))
              throw Error("INPUT", "Cannot secure terminal input");
            active = true;
          }
        }
        ~HiddenInput() {
          if (active)
            SetConsoleMode(input, saved);
        }
      } hidden;
#else
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
#endif
      std::cerr << "API_KEY: " << std::flush;
      std::getline(std::cin, value);
      std::cerr << '\n';
    }
    if (value.empty() || value.size() > 500)
      throw Error("INPUT", "Invalid API key input");
    auto result =
        http_json(url, "/api/v1/auth/api-key",
                  {{"apiKey", value}, {"role", role}, {"name", instance_name}, {"hostId", host}});
    result["token"] = value;
    result["relay"] = url.origin;
    return result;
  }
  Json input = {{"role", role}, {"name", instance_name}};
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
  asio::io_context io;
  asio::steady_timer expiry(io), refresh(io);
  std::shared_ptr<Socket> socket;
  Json approved, failure;
  bool ended = false;
  int retries = 0;
  std::function<void()> reconnect;
  const auto finish = [&] {
    if (ended)
      return;
    ended = true;
    expiry.cancel();
    refresh.cancel();
    if (socket)
      socket->close();
  };
  const auto poll = [&] {
    if (ended)
      return;
    try {
      const auto remaining = request.at("expires").get<int64_t>() - now();
      if (remaining <= 0) {
        finish();
        return;
      }
      auto result =
          http_json(url, "/api/v1/auth/device/poll",
                    {{"id", request.at("id")}, {"pollSecret", request.at("pollSecret")}}, "", "",
                    std::chrono::milliseconds(std::min<int64_t>(5000, remaining)));
      if (result.at("state") == "approved") {
        if (role == "cli" && !host.empty() && result.value("hostId", "") != host)
          throw Error("FORBIDDEN", "Approved server differs from requested server");
        result.erase("state");
        result["relay"] = url.origin;
        approved = result;
        finish();
      } else if (result.at("state") == "rejected") {
        failure = {{"code", "LOGIN_REJECTED"}, {"message", "Login request rejected"}};
        finish();
      }
    } catch (const Error &error) {
      if (error.code == "HTTP_TIMEOUT" || error.code == "HTTP_NETWORK") {
        std::cerr << "Login check unavailable (" << error.code
                  << "); reconnecting within the finite login budget\n";
        if (socket)
          socket->close();
        return;
      }
      failure = error_data(error);
      finish();
    }
  };
  std::function<void()> tick;
  tick = [&] {
    if (ended || role != "cli")
      return;
    refresh.expires_after(std::chrono::seconds(10));
    refresh.async_wait([&](auto ec) {
      if (!ec) {
        poll();
        tick();
      }
    });
  };
  reconnect = [&] {
    if (ended)
      return;
    socket = connect_socket(
        io, url, request.at("pollSecret"),
        [&](Json event) {
          if (event.value("type", "") == "subscribed" || event.value("type", "") == "change")
            poll();
        },
        [&](unsigned) {
          if (ended || role == "cli" || retries >= 3)
            return;
          refresh.expires_after(std::chrono::seconds(1 << retries++));
          refresh.async_wait([&](auto ec) {
            if (!ec) {
              reconnect();
              poll();
            }
          });
        },
        "/api/v1/auth/device/events?id=" + request.at("id").get<std::string>());
    socket->start();
  };
  expiry.expires_after(std::chrono::milliseconds(
      std::max<int64_t>(0, request.at("expires").get<int64_t>() - now())));
  expiry.async_wait([&](auto ec) {
    if (!ec)
      finish();
  });
  reconnect();
  poll();
  tick();
  io.run();
  if (!failure.is_null())
    throw Error(failure.value("code", "LOGIN_FAILED"), failure.value("message", "Login failed"));
  if (!approved.is_null())
    return approved;
  throw Error("LOGIN_EXPIRED", "Login request expired; run login again");
}
Json credential_status(const Json &credential) {
  const auto role = credential.at("role").get<std::string>();
  return http_json(relay_url(credential.at("relay")),
                   role == "agent" ? "/api/v1/agent/status" : "/api/v1/hosts", nullptr,
                   credential.at("token"));
}
} // namespace coc
