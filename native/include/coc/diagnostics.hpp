#pragma once
#include "network.hpp"
#include <sqlite3.h>
#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif
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
    return Json(verify_codex({{"codexPath", config.value("codexPath", "codex")},
                              {"codexArgs", config.value("codexArgs", Json::array())}}));
  });
  check("relay_tls", [&] {
    return http_json(relay_url(config.at(agent ? "relayUrl" : "relay")), "/api/v1/healthz",
                     nullptr);
  });
  if (agent) {
    check("configuration", [&] {
      auto validated = agent_config(config);
      return Json{{"projects", validated["projects"].size()},
                  {"sandbox", validated["sandbox"]},
                  {"historyStorage", validated["historyStorage"]}};
    });
    check("project_access", [&] {
      for (auto &project : config.at("projects"))
#ifdef _WIN32
        if (_waccess(std::filesystem::u8path(project.at("path").get<std::string>()).c_str(),
                     config.value("sandbox", "workspace-write") == "workspace-write" ? 6 : 4) != 0)
#else
        if (access(project.at("path").get<std::string>().c_str(),
                   R_OK | X_OK |
                       (config.value("sandbox", "workspace-write") == "workspace-write" ? W_OK
                                                                                        : 0)) != 0)
#endif
          throw Error("PROJECT_ACCESS", "Project permissions do not match the sandbox");
      return Json("accessible");
    });
    check("disk", [&] {
      auto path = std::filesystem::u8path(config.at("dataDir").get<std::string>());
      while (!std::filesystem::exists(path) && path.has_parent_path() && path != path.parent_path())
        path = path.parent_path();
      return Json{{"availableBytes", std::filesystem::space(path).available}};
    });
    check("database", [&] {
      const auto file =
          std::filesystem::u8path(config.at("dataDir").get<std::string>()) / "agent.db";
      if (!std::filesystem::exists(file))
        return Json("not initialized");
      sqlite3 *raw = nullptr;
      if (sqlite3_open_v2(file.u8string().c_str(), &raw, SQLITE_OPEN_READONLY, nullptr) !=
          SQLITE_OK) {
        if (raw)
          sqlite3_close(raw);
        throw Error("STORAGE_ERROR", "Cannot open journal for diagnostics");
      }
      std::unique_ptr<sqlite3, decltype(&sqlite3_close)> database(raw, sqlite3_close);
      sqlite3_stmt *version_query = nullptr;
      if (sqlite3_prepare_v2(raw, "PRAGMA user_version", -1, &version_query, nullptr) != SQLITE_OK)
        throw Error("STORAGE_ERROR", "Cannot inspect journal version");
      std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> version(version_query,
                                                                         sqlite3_finalize);
      if (sqlite3_step(version.get()) != SQLITE_ROW ||
          (sqlite3_column_int(version.get(), 0) != 0 && sqlite3_column_int(version.get(), 0) != 1))
        throw Error("UNSUPPORTED_STORAGE_VERSION", "Unsupported journal schema");
      sqlite3_stmt *statement = nullptr;
      if (sqlite3_prepare_v2(raw, "PRAGMA quick_check", -1, &statement, nullptr) != SQLITE_OK)
        throw Error("STORAGE_ERROR", "Cannot inspect journal");
      std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> query(statement, sqlite3_finalize);
      if (sqlite3_step(statement) != SQLITE_ROW ||
          std::string(reinterpret_cast<const char *>(sqlite3_column_text(statement, 0))) != "ok")
        throw Error("STORAGE_ERROR", "Journal integrity check failed");
      sqlite3_stmt *budget_query = nullptr;
      if (sqlite3_prepare_v2(
              raw,
              "SELECT COALESCE(SUM(CASE WHEN scope='@global' THEN bytes ELSE 0 END),0),"
              "COALESCE(SUM(CASE WHEN scope='@global' THEN records ELSE 0 END),0),"
              "COALESCE(MAX(CASE WHEN scope!='@global' THEN bytes ELSE 0 END),0),"
              "COALESCE(MAX(CASE WHEN scope!='@global' THEN records ELSE 0 END),0),"
              "COUNT(CASE WHEN scope!='@global' THEN 1 END) FROM transport2_history_budget",
              -1, &budget_query, nullptr) != SQLITE_OK)
        throw Error("UNSUPPORTED_STORAGE_VERSION", "Current history ledger is required");
      std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> budget(budget_query,
                                                                        sqlite3_finalize);
      if (sqlite3_step(budget.get()) != SQLITE_ROW)
        throw Error("STORAGE_ERROR", "Cannot inspect history capacity");
      const auto policy = history_storage_config(config.value("historyStorage", Json::object()));
      const char *limits[] = {"maxBytes", "maxRecords", "maxSessionBytes", "maxSessionRecords",
                              "maxSessions"};
      Json exceeded = Json::array();
      for (int i = 0; i < 5; ++i)
        if (sqlite3_column_int64(budget.get(), i) > policy.at(limits[i]).get<int64_t>())
          exceeded.push_back(limits[i]);
      return Json{{"integrity", "ok"},
                  {"historyBytes", sqlite3_column_int64(budget.get(), 0)},
                  {"historyRecords", sqlite3_column_int64(budget.get(), 1)},
                  {"historyOverLimit", exceeded},
                  {"historyGrowthRestricted", !exceeded.empty()}};
    });
  }
  return result;
}
} // namespace coc
