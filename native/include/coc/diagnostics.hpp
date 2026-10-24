#pragma once
#include "network.hpp"
#include <sqlite3.h>
#include <unistd.h>
namespace coc {
// Explicit diagnostics emit metadata only and never start a model task.
inline Json doctor(const Json &config, bool agent) {
  Json result = {{"checks", Json::array()}, {"ok", true}};
  auto check = [&](const std::string &name, auto operation) {
    try {
      result["checks"].push_back({{"name", name}, {"ok", true}, {"details", operation()}});
    } catch (const std::exception &error) {
      result["ok"] = false;
      result["checks"].push_back({{"name", name}, {"ok", false}, {"error", error_data(error)}});
    }
  };
  check("codex", [&] {
    verify_codex({{"codexPath", config.value("codexPath", "codex")},
                  {"codexArgs", config.value("codexArgs", Json::array())}});
    return Json("0.164.0");
  });
  check("relay_tls", [&] {
    return http_json(relay_url(config.at(agent ? "relayUrl" : "relay")), "/api/v1/healthz",
                     nullptr);
  });
  if (agent) {
    check("configuration", [&] {
      auto validated = agent_config(config);
      return Json{{"projects", validated["projects"].size()}, {"sandbox", validated["sandbox"]}};
    });
    check("project_access", [&] {
      for (auto &project : config.at("projects"))
        if (access(project.at("path").get<std::string>().c_str(),
                   R_OK | X_OK |
                       (config.value("sandbox", "workspace-write") == "workspace-write" ? W_OK
                                                                                        : 0)) != 0)
          throw Error("PROJECT_ACCESS", "Project permissions do not match the sandbox");
      return Json("accessible");
    });
    check("disk", [&] {
      auto path = std::filesystem::path(config.at("dataDir").get<std::string>());
      while (!std::filesystem::exists(path) && path.has_parent_path() && path != path.parent_path())
        path = path.parent_path();
      return Json{{"availableBytes", std::filesystem::space(path).available}};
    });
    check("database", [&] {
      const auto file = std::filesystem::path(config.at("dataDir").get<std::string>()) / "agent.db";
      if (!std::filesystem::exists(file))
        return Json("not initialized");
      sqlite3 *raw = nullptr;
      if (sqlite3_open_v2(file.c_str(), &raw, SQLITE_OPEN_READONLY, nullptr) != SQLITE_OK) {
        if (raw)
          sqlite3_close(raw);
        throw Error("STORAGE_ERROR", "Cannot open journal for diagnostics");
      }
      std::unique_ptr<sqlite3, decltype(&sqlite3_close)> database(raw, sqlite3_close);
      sqlite3_stmt *statement = nullptr;
      if (sqlite3_prepare_v2(raw, "PRAGMA quick_check", -1, &statement, nullptr) != SQLITE_OK)
        throw Error("STORAGE_ERROR", "Cannot inspect journal");
      std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> query(statement, sqlite3_finalize);
      if (sqlite3_step(statement) != SQLITE_ROW ||
          std::string(reinterpret_cast<const char *>(sqlite3_column_text(statement, 0))) != "ok")
        throw Error("STORAGE_ERROR", "Journal integrity check failed");
      return Json("ok");
    });
  }
  return result;
}
} // namespace coc
