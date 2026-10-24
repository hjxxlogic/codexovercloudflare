#include "coc/common.hpp"
#include <algorithm>
#include <chrono>
#include <fcntl.h>
#include <fstream>
#include <openssl/rand.h>
#include <regex>
#include <set>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
namespace coc {
PrivateLock::PrivateLock(const std::filesystem::path &path) {
  auto parent = path.parent_path();
  if (!parent.empty() && !std::filesystem::exists(parent)) {
    std::filesystem::create_directories(parent);
    chmod(parent.c_str(), 0700);
  }
  fd_ = open((path.string() + ".lock").c_str(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd_ < 0)
    throw Error("CONFIG_ERROR", "Cannot open configuration lock");
  if (flock(fd_, LOCK_EX | LOCK_NB) != 0) {
    close(fd_);
    fd_ = -1;
    throw Error("CONFIG_BUSY", "Another credential update is in progress");
  }
}
PrivateLock::~PrivateLock() {
  if (fd_ >= 0)
    close(fd_);
}

Json error_data(const std::exception &e) {
  auto p = dynamic_cast<const Error *>(&e);
  return {{"code", p ? p->code : "INTERNAL_ERROR"},
          {"message", p ? e.what() : "Local operation failed"}};
}
int64_t now() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}
std::string uuid() {
  unsigned char b[16];
  if (RAND_bytes(b, 16) != 1)
    throw Error("RANDOM_FAILED", "Secure random failed");
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const char *h = "0123456789abcdef";
  std::string s;
  for (int i = 0; i < 16; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10)
      s += '-';
    s += h[b[i] >> 4];
    s += h[b[i] & 15];
  }
  return s;
}
bool valid_id(const std::string &s) {
  return std::regex_match(s, std::regex("[a-zA-Z0-9_-]{1,100}"));
}
std::string id_key(const Json &id) { return id.is_string() ? id.get<std::string>() : id.dump(); }
Json read_json(const std::filesystem::path &p) {
  std::ifstream f(p);
  if (!f)
    throw Error("CONFIG_ERROR", "Cannot open configuration: " + p.string());
  Json j;
  f >> j;
  return j;
}
void save_private(const std::filesystem::path &p, const Json &j, bool exclusive) {
  auto parent = p.parent_path();
  if (!parent.empty() && !std::filesystem::exists(parent)) {
    std::filesystem::create_directories(parent);
    chmod(parent.c_str(), 0700);
  }
  auto directory = parent.empty() ? std::filesystem::path(".") : parent;
  int dirfd = open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (dirfd < 0)
    throw Error("CONFIG_ERROR", "Cannot open configuration directory");
  const auto temporary = p.string() + ".tmp-" + uuid();
  int fd = -1;
  try {
    struct stat existing {};
    if (lstat(p.c_str(), &existing) == 0 && !S_ISREG(existing.st_mode))
      throw Error("CONFIG_ERROR", "Configuration must be a regular file");
    fd = open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0)
      throw Error("CONFIG_ERROR", "Cannot create private configuration");
    if (fchmod(fd, 0600) != 0)
      throw Error("CONFIG_ERROR", "Cannot set private configuration permissions");
    const auto text = j.dump(2) + "\n";
    size_t offset = 0;
    while (offset < text.size()) {
      auto count = write(fd, text.data() + offset, text.size() - offset);
      if (count < 0 && errno == EINTR)
        continue;
      if (count <= 0)
        throw Error("CONFIG_ERROR", "Configuration write failed");
      offset += count;
    }
    if (fsync(fd) != 0)
      throw Error("CONFIG_ERROR", "Configuration sync failed");
    close(fd);
    fd = -1;
    if (exclusive) {
      if (link(temporary.c_str(), p.c_str()) != 0)
        throw Error("CONFIG_ERROR", "Configuration already exists or cannot be published");
      unlink(temporary.c_str());
    } else if (rename(temporary.c_str(), p.c_str()) != 0)
      throw Error("CONFIG_ERROR", "Configuration replacement failed");
    if (fsync(dirfd) != 0)
      throw Error("CONFIG_ERROR", "Configuration directory sync failed");
    close(dirfd);
  } catch (...) {
    if (fd >= 0)
      close(fd);
    close(dirfd);
    unlink(temporary.c_str());
    throw;
  }
}
Url relay_url(std::string s) {
  std::smatch m;
  static const std::regex re(
      R"(^(https?)://(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(:([0-9]{1,5}))?/?$)");
  if (!std::regex_match(s, m, re))
    throw Error("INVALID_RELAY", "Relay must be an HTTPS origin (HTTP only on loopback)");
  Url u;
  u.tls = m[1] == "https";
  u.authority = m[2].str() + m[3].str();
  u.host = m[2];
  if (u.host.front() == '[')
    u.host = u.host.substr(1, u.host.size() - 2);
  u.port = m[4].matched ? m[4].str() : (u.tls ? "443" : "80");
  if (std::stoi(u.port) < 1 || std::stoi(u.port) > 65535 ||
      (!u.tls && u.host != "localhost" && u.host != "127.0.0.1" && u.host != "::1"))
    throw Error("INVALID_RELAY", "Insecure relay rejected");
  u.origin = std::string(u.tls ? "https://" : "http://") + u.authority;
  return u;
}
namespace {
std::string trim_text(const std::string &text) {
  size_t first = text.size(), last = 0;
  for (size_t i = 0; i < text.size();) {
    const auto begin = i;
    unsigned char leading = text[i++];
    uint32_t point = leading;
    int count = leading < 0x80 ? 0 : leading < 0xe0 ? 1 : leading < 0xf0 ? 2 : 3;
    if (count) {
      point &= (1u << (6 - count)) - 1;
      for (int n = 0; n < count && i < text.size(); ++n)
        point = (point << 6) | (static_cast<unsigned char>(text[i++]) & 63);
    }
    const bool space = (point >= 9 && point <= 13) || point == 32 || point == 160 ||
                       point == 5760 || (point >= 8192 && point <= 8202) || point == 8232 ||
                       point == 8233 || point == 8239 || point == 8287 || point == 12288 ||
                       point == 65279;
    if (!space) {
      first = std::min(first, begin);
      last = i;
    }
  }
  return last ? text.substr(first, last - first) : "";
}
size_t utf16_length(const std::string &text) {
  size_t units = 0;
  for (unsigned char c : text)
    if ((c & 0xc0) != 0x80)
      units += (c >= 0xf0 ? 2 : 1);
  return units;
}
} // namespace
Json agent_config(Json c) {
  if (!c.is_object())
    throw Error("CONFIG_ERROR", "Expected object");
  for (auto k : {"hostId", "token", "dataDir"})
    if (!c.contains(k) || !c[k].is_string() || c[k].get<std::string>().empty())
      throw Error("CONFIG_ERROR", std::string("Missing ") + k);
  if (!valid_id(c["hostId"]) || c["token"].get<std::string>().size() < 20)
    throw Error("CONFIG_ERROR", "Invalid device credentials");
  c["relayUrl"] = relay_url(c.value("relayUrl", "https://r.xlogic.cc")).origin;
  c["codexPath"] = c.value("codexPath", "codex");
  c["codexArgs"] = c.value("codexArgs", Json::array());
  c["sandbox"] = c.value("sandbox", "workspace-write");
  if (c["sandbox"] != "workspace-write" && c["sandbox"] != "read-only")
    throw Error("CONFIG_ERROR", "Invalid sandbox");
  if (!c["codexArgs"].is_array())
    throw Error("CONFIG_ERROR", "codexArgs must be an array");
  for (auto &a : c["codexArgs"])
    if (!a.is_string())
      throw Error("CONFIG_ERROR", "Invalid Codex argument");
  if (!c.contains("projects") || !c["projects"].is_array() || c["projects"].empty() ||
      c["projects"].size() > 20)
    throw Error("CONFIG_ERROR", "Register 1 to 20 projects");
  std::set<std::string> ids;
  std::vector<std::filesystem::path> roots;
  for (auto &p : c["projects"]) {
    auto id = p.at("id").get<std::string>();
    if (!valid_id(id) || !ids.insert(id).second || !p.at("name").is_string() ||
        p["name"].get<std::string>().empty() || utf16_length(p["name"].get<std::string>()) > 100)
      throw Error("CONFIG_ERROR", "Invalid project");
    auto path = std::filesystem::canonical(p.at("path").get<std::string>());
    if (!std::filesystem::is_directory(path))
      throw Error("CONFIG_ERROR", "Project must be a directory");
    for (const auto &root : roots) {
      auto prefix = [](const auto &a, const auto &b) {
        auto pair = std::mismatch(a.begin(), a.end(), b.begin(), b.end());
        return pair.first == a.end();
      };
      if (prefix(root, path) || prefix(path, root))
        throw Error("CONFIG_ERROR", "Project roots must not duplicate or overlap");
    }
    roots.push_back(path);
    p["path"] = path.string();
  }
  c["dataDir"] = std::filesystem::absolute(c["dataDir"].get<std::string>()).string();
  return c;
}
Json guard_cli(Json m, const std::string &cwd, const std::string &sandbox,
               const std::string &thread) {
  static const std::set<std::string> methods = {"initialize",
                                                "initialized",
                                                "thread/start",
                                                "thread/resume",
                                                "thread/read",
                                                "thread/list",
                                                "thread/loaded/list",
                                                "thread/turns/list",
                                                "thread/items/list",
                                                "thread/unsubscribe",
                                                "thread/name/set",
                                                "turn/start",
                                                "turn/steer",
                                                "turn/interrupt",
                                                "model/list",
                                                "account/read",
                                                "account/rateLimits/read",
                                                "config/read",
                                                "configRequirements/read",
                                                "permissionProfile/list",
                                                "skills/list",
                                                "mcpServerStatus/list",
                                                "plugin/list",
                                                "plugin/installed",
                                                "app/list",
                                                "app/installed",
                                                "experimentalFeature/list",
                                                "hooks/list",
                                                "account/bedrock/checkGovCloudRequirements",
                                                "collaborationMode/list"};
  if (!m.is_object())
    throw Error("INVALID_REQUEST", "Invalid RPC");
  if (!m.contains("method"))
    return m;
  auto method = m.at("method").get<std::string>();
  if (!methods.count(method))
    throw Error("UNSUPPORTED_METHOD", "Remote CLI does not support " + method);
  auto p = m.value("params", Json::object());
  if (!p.is_object())
    throw Error("INVALID_REQUEST", "Expected parameters object");
  if (p.contains("threadId") && !p["threadId"].is_null() && p["threadId"] != thread)
    throw Error("FORBIDDEN", "Thread does not belong to this session");
  if (method == "thread/resume" && thread.empty())
    throw Error("FORBIDDEN", "Cross-session history resume is not supported yet");
  if (method == "thread/start" || method == "thread/resume" || method == "turn/start") {
    if (p.contains("cwd") && !p["cwd"].is_null() && p["cwd"] != cwd)
      throw Error("FORBIDDEN", "Changing remote working directory is not allowed");
    p.erase("config");
    if (p.value("approvalsReviewer", Json()) == "user")
      p.erase("approvalsReviewer");
    if (p.contains("sandboxPolicy") && p["sandboxPolicy"].is_object()) {
      auto policy = p["sandboxPolicy"];
      bool safe =
          policy.value("type", "") == (sandbox == "read-only" ? "readOnly" : "workspaceWrite") &&
          policy.value("networkAccess", Json(false)) != true;
      if (policy.contains("writableRoots") && !policy["writableRoots"].is_null()) {
        if (!policy["writableRoots"].is_array())
          safe = false;
        else
          for (auto &r : policy["writableRoots"])
            if (r != cwd)
              safe = false;
      }
      if (safe)
        p.erase("sandboxPolicy");
    }
    for (auto k :
         {"baseInstructions", "developerInstructions", "sandboxPolicy", "approvalsReviewer"})
      if (p.contains(k) && !p[k].is_null())
        throw Error("FORBIDDEN", std::string("Remote override rejected: ") + k);
    if (p.contains("sandbox") && !p["sandbox"].is_null() && p["sandbox"] != sandbox)
      throw Error("FORBIDDEN", "Sandbox escalation rejected");
    if (p.contains("approvalPolicy") && !p["approvalPolicy"].is_null() &&
        p["approvalPolicy"] != "on-request")
      throw Error("FORBIDDEN", "Approval policy override rejected");
    p["cwd"] = cwd;
    p["approvalPolicy"] = "on-request";
    if (method != "turn/start")
      p["sandbox"] = sandbox;
  }
  if (p.contains("input") && p["input"].is_array())
    for (auto &i : p["input"])
      if (!i.is_object() || i.value("type", "") != "text")
        throw Error("UNSUPPORTED_INPUT", "Only text input is supported remotely");
  if (method == "thread/start" || method == "thread/resume" || method == "turn/start") {
    std::set<std::string> allowed =
        method == "turn/start"
            ? std::set<std::string>{"threadId", "input",  "cwd",     "approvalPolicy",
                                    "model",    "effort", "summary", "serviceTier"}
            : std::set<std::string>{"threadId", "cwd",           "sandbox",     "approvalPolicy",
                                    "model",    "modelProvider", "serviceTier", "ephemeral"};
    Json filtered = Json::object();
    for (auto &k : allowed)
      if (p.contains(k))
        filtered[k] = p[k];
    p = filtered;
  }
  m["params"] = p;
  return m;
}
Json redact(Json v) {
  static const std::regex secret(
      "^(api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization)$",
      std::regex::icase);
  if (v.is_array())
    for (auto &x : v)
      x = redact(x);
  else if (v.is_object())
    for (auto i = v.begin(); i != v.end(); ++i) {
      if (i.key() == "env")
        i.value() = Json::object();
      else if (i.value().is_string() && std::regex_match(i.key(), secret))
        i.value() = "[redacted]";
      else
        i.value() = redact(i.value());
    }
  return v;
}
Json web_command(Json v) {
  if (!v.is_object())
    throw Error("INVALID_REQUEST", "Invalid web command");
  std::string a = v.value("action", "");
  if (a == "sync") {
    auto n = v.value("after", Json(0));
    if (!n.is_number_integer() || n.get<int64_t>() < 0 || n.get<int64_t>() > 9007199254740991LL)
      throw Error("INVALID_REQUEST", "Invalid cursor");
    return {{"action", a}, {"after", n}};
  }
  if (!v.contains("requestId") || !v["requestId"].is_string() || !valid_id(v["requestId"]))
    throw Error("INVALID_REQUEST", "Invalid requestId");
  Json out = {{"action", a}, {"requestId", v["requestId"]}};
  if (a == "prompt") {
    auto s = v.at("text").get<std::string>();
    s = trim_text(s);
    if (s.empty())
      throw Error("INVALID_REQUEST", "Empty prompt");
    if (utf16_length(s) > 64000)
      throw Error("INVALID_REQUEST", "Prompt exceeds limit");
    out["text"] = s;
  } else if (a == "approval") {
    auto s = v.at("approvalId").get<std::string>();
    if (s.empty() || s.size() > 200 || !v.at("allow").is_boolean())
      throw Error("INVALID_REQUEST", "Invalid approval");
    out["approvalId"] = s;
    out["allow"] = v["allow"];
  } else if (a != "interrupt")
    throw Error("INVALID_REQUEST", "Unknown web command");
  return out;
}
std::string web_fingerprint(const Json &c) {
  // Preserve Zod/JSON.stringify field order from the original journal.
  std::string out =
      "{\"action\":" + c.at("action").dump() + ",\"requestId\":" + c.at("requestId").dump();
  if (c.at("action") == "prompt")
    out += ",\"text\":" + c.at("text").dump();
  if (c.at("action") == "approval")
    out += ",\"approvalId\":" + c.at("approvalId").dump() + ",\"allow\":" + c.at("allow").dump();
  return out + "}";
}
} // namespace coc
