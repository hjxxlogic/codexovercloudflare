#include "coc/access.hpp"
#include "coc/access_defaults.hpp"
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <fstream>
#include <set>
#ifndef _WIN32
#include <sys/stat.h>
#include <unistd.h>
#endif
namespace coc {
namespace {
std::set<std::string> origins;
std::pair<std::string, std::string> credentials;
std::string origin_key(const Url &url) {
  std::string host = url.host;
  std::transform(host.begin(), host.end(), host.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  return std::string(url.tls ? "https://" : "http://") + host + ":" + url.port;
}
void validate_header(const std::string &value) {
  if (value.empty() || value.size() > 4096 ||
      std::any_of(value.begin(), value.end(), [](unsigned char c) { return c <= 32 || c >= 127; }))
    throw Error("CONFIG_ERROR", "Invalid Cloudflare Access credential");
}
} // namespace
std::string configure_access(const std::string &file) {
  origins.clear();
  credentials = {};
  auto path = file;
  if (path.empty())
    if (const auto env = std::getenv("COC_ACCESS_CONFIG"))
      path = env;
  if (path.empty()) {
    const auto compiled = Json::parse(access_defaults);
    credentials = {compiled.at("clientId").get<std::string>(),
                   compiled.at("clientSecret").get<std::string>()};
    for (const auto &entry : compiled.at("origins")) {
      const auto url = relay_url(entry.get<std::string>());
      if (!url.tls)
        throw Error("CONFIG_ERROR", "Compiled Cloudflare Access origins require HTTPS");
      origins.insert(origin_key(url));
    }
    return "";
  }
  try {
    const auto resolved = std::filesystem::absolute(std::filesystem::u8path(path));
#ifndef _WIN32
    struct stat info {};
    if (stat(resolved.c_str(), &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != geteuid() ||
        (info.st_mode & 077) != 0)
      throw Error("CONFIG_ERROR",
                  "Cloudflare Access file must be owned by this user and private (0600)");
#endif
    if (std::filesystem::file_size(resolved) > 16384)
      throw Error("CONFIG_ERROR", "Cloudflare Access configuration is too large");
    const auto config = read_json(resolved);
    auto id = config.at("clientId").get<std::string>();
    auto secret = config.at("clientSecret").get<std::string>();
    validate_header(id);
    validate_header(secret);
    const auto allowed = config.at("origins");
    if (!allowed.is_array() || allowed.empty() || allowed.size() > 32)
      throw Error("CONFIG_ERROR", "Cloudflare Access requires trusted HTTPS origins");
    std::set<std::string> checked;
    for (const auto &entry : allowed) {
      const auto url = relay_url(entry.get<std::string>());
      if (!url.tls)
        throw Error("CONFIG_ERROR", "Cloudflare Access requires HTTPS");
      checked.insert(origin_key(url));
    }
    credentials = {std::move(id), std::move(secret)};
    origins = std::move(checked);
    return resolved.u8string();
  } catch (const Error &) {
    throw;
  } catch (...) {
    throw Error("CONFIG_ERROR",
                "Cannot read Cloudflare Access configuration; check its path and format");
  }
}
std::pair<std::string, std::string> access_credentials(const Url &url) {
  return origins.count(origin_key(url)) ? credentials : std::pair<std::string, std::string>{};
}
bool access_enabled(const Url &url) { return origins.count(origin_key(url)) != 0; }
} // namespace coc
