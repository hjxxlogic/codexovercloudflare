#pragma once
#include "network.hpp"
#include <map>
namespace coc {
struct Options {
  std::map<std::string, std::string> values;
  std::vector<std::string> args;
  bool takeover = false;
  Options(int argc, char **argv);
  std::string get(const std::string &key, const std::string &fallback = "") const;
};
std::filesystem::path config_path(const char *env, const std::string &relative);
Json device_login(const std::string &relay, const std::string &role, const std::string &name,
                  const std::string &host = "");
Json credential_status(const Json &credential);
} // namespace coc
