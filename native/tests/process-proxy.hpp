#pragma once
#include "coc/process.hpp"
#include <cstdlib>
#include <stdexcept>

inline void codex_proxy_fixture(coc::Json config, const std::string &cwd) {
  using namespace coc;
  struct Environment {
    Json saved = Json::object();
    static void set(const std::string &key, const Json &value) {
#ifdef _WIN32
      _putenv_s(key.c_str(), value.is_null() ? "" : value.get<std::string>().c_str());
#else
      if (value.is_null())
        unsetenv(key.c_str());
      else
        setenv(key.c_str(), value.get<std::string>().c_str(), 1);
#endif
    }
    Environment() {
      for (const auto key : {"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY",
                             "all_proxy", "NO_PROXY", "no_proxy", "COC_PROXY_TEST"}) {
        const auto value = std::getenv(key);
        saved[key] = value ? Json(value) : Json();
      }
      for (auto it = saved.begin(); it != saved.end(); ++it)
        set(it.key(), "ambient-proxy-test");
    }
    ~Environment() {
      for (auto it = saved.begin(); it != saved.end(); ++it)
        set(it.key(), it.value());
    }
  } environment;
  const auto check = [](bool value, const char *message) {
    if (!value)
      throw std::runtime_error(message);
  };
  config["codexArgs"].push_back("--proxy-env");
  const std::string proxy = "http://configured.invalid:8080";
  for (int mode = 0; mode < 4; ++mode) {
    config["proxy"] = mode == 3 ? "" : proxy;
    config.erase("codexUseProxy");
    if (mode)
      config["codexUseProxy"] = mode >= 2;
    const auto verify = [&](const Json &seen) {
      for (const auto key :
           {"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"})
        check(mode == 2 ? seen.at(key) == proxy : seen.at(key).is_null(),
              "Codex proxy environment must follow explicit configuration");
      for (const auto key : {"NO_PROXY", "no_proxy"})
        check(mode == 2 ? seen.at(key) == "localhost,127.0.0.1,::1" : seen.at(key).is_null(),
              "Codex loopback bypass must not inherit ambient proxy policy");
      check(seen.at("COC_PROXY_TEST") == "ambient-proxy-test",
            "Preserve unrelated child environment");
    };
    verify(Json::parse(verify_codex(config)));
    asio::io_context io;
    Json result, failure;
    const auto ignore_message = [](Json) {};
    const auto ignore_exit = [] {};
    auto process = std::make_shared<CodexProcess>(io, config, cwd, ignore_message, ignore_exit);
    process->start();
    process->initialize([&](Json value, Json error) {
      result = std::move(value);
      failure = std::move(error);
      process->close();
    });
    io.run();
    check(failure.is_null(), "Codex environment fixture must initialize");
    verify(result.at("environment"));
    for (auto it = environment.saved.begin(); it != environment.saved.end(); ++it)
      check(std::getenv(it.key().c_str()) &&
                std::string(std::getenv(it.key().c_str())) == "ambient-proxy-test",
            "Launching Codex must not mutate the parent environment");
  }
}
