#include "coc/projects.hpp"
#include "coc/credit.hpp"
#include "coc/delivery.hpp"
#include "coc/store.hpp"
#include <fstream>
#include <iostream>
#include <thread>
#ifdef __linux__
#include <csignal>
#include <cstring>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
namespace {
const char *fault_directory = nullptr, *fault_catalog = nullptr, *fault_backup = nullptr;
int project_fault = 0;
} // namespace
// Interpose only this test executable's actual mkdir call. Production code has
// no test hooks: the child stops after the directory exists and before publish.
extern "C" int fsync(int fd) {
  const auto result = static_cast<int>(syscall(SYS_fsync, fd));
  if (result == 0 && project_fault == 3 && fault_catalog) {
    const auto descriptor = "/proc/self/fd/" + std::to_string(fd);
    char path[8192];
    const auto bytes = readlink(descriptor.c_str(), path, sizeof(path));
    const auto prefix = std::string(fault_catalog) + ".tmp-";
    if (bytes > 0 && static_cast<size_t>(bytes) > prefix.size() &&
        std::memcmp(path, prefix.data(), prefix.size()) == 0)
      raise(SIGSTOP);
  }
  return result;
}
extern "C" int mkdir(const char *path, mode_t mode) noexcept {
  const auto result = static_cast<int>(syscall(SYS_mkdir, path, mode));
  if (result == 0 && fault_directory && std::strcmp(path, fault_directory) == 0) {
    if (project_fault == 1)
      raise(SIGSTOP);
    else if (project_fault == 2) {
      if (::rename(fault_catalog, fault_backup) != 0 ||
          syscall(SYS_mkdir, fault_catalog, 0700) != 0)
        _exit(55);
    }
  }
  return result;
}
#endif
using namespace coc;
void check(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class F> void rejects(F fn, const std::string &code) {
  try {
    fn();
  } catch (const Error &e) {
    check(e.code == code, e.what());
    return;
  }
  throw std::runtime_error("Expected rejection: " + code);
}
namespace {
Json catalog_config(const std::filesystem::path &root, const std::string &scope,
                    Json projects = Json::array()) {
  return {{"hostId", "budget"}, {"dataDir", (root / scope).u8string()}, {"projects", projects}};
}
Json rename_request(const std::string &request, int64_t revision) {
  return {{"operation", "rename"},
          {"id", "base"},
          {"name", "Name " + request},
          {"requestId", request},
          {"revision", revision}};
}
void legacy_catalog(const std::filesystem::path &root) {
  const auto work = root / "legacy-work";
  std::filesystem::create_directory(work);
  const auto config = catalog_config(root, "legacy-catalog");
  Store::Lock lock(config.at("dataDir"), true);
  const auto file = root / "legacy-catalog" / "projects.json";
  const Json legacy = {
      {"version", 1},
      {"hostId", "budget"},
      {"revision", 77},
      {"projects",
       Json::array({{{"id", "base"}, {"name", "Saved project"}, {"path", work.u8string()}}})},
      {"receipts", Json::array({{{"requestId", "old-request"}, {"result", {{"revision", 999}}}}})}};
  save_private(file, legacy);
  Projects projects(config);
  const auto listed = projects.list();
  check(listed.at("revision") == 77 && listed.at("projects").at(0).at("name") == "Saved project" &&
            listed.at("projects").at(0).at("path") == work.u8string(),
        "Upgrade preserves authoritative old catalog, paths, names and revision");
  check(projects.usage().at("requests") == 0, "Legacy business receipts are not imported");
  const auto idle = [](const std::string &) { return false; };
  rejects([&] { projects.request(rename_request("old-request", 76), idle); }, "PROJECT_CONFLICT");
  projects.request(rename_request("new-intention", 77), idle);
  const auto stored = read_json(file);
  check(!stored.contains("receipts") && stored.at("journal").at("version") == 2 &&
            stored.at("journal").at("keys").size() == 1 && stored.at("revision") == 78,
        "First explicit new change publishes only the new journal without replaying legacy work");
}
#ifdef __linux__
void interrupted_private_files(const std::filesystem::path &root) {
  const auto file = root / "private.json";
  const auto name = file.string();
  save_private_text(file, "original");
  const auto foreign = name + ".tmp-user-file";
  {
    std::ofstream out(foreign);
    out << "preserved";
  }
  for (int n = 0; n < 4; ++n) {
    const auto child = fork();
    check(child >= 0, "Fork private replacement writer");
    if (!child) {
      fault_catalog = name.c_str();
      project_fault = 3;
      save_private_text(file, std::string(65536, 'x'));
      _exit(59);
    }
    int state = 0;
    check(waitpid(child, &state, WUNTRACED) == child && WIFSTOPPED(state),
          "Writer stops after temporary file fsync and before publication");
    // The active writer's actual directory lock prevents deleting its temp file.
    bool blocked = false;
    try {
      save_private_text(file, "racing writer");
    } catch (const Error &error) {
      blocked = error.code == "CONFIG_BUSY";
    }
    kill(child, SIGKILL);
    waitpid(child, &state, 0);
    check(blocked, "Concurrent private writer fails closed before orphan cleanup");
    size_t temporary = 0;
    for (const auto &entry : std::filesystem::directory_iterator(root))
      if (entry.path().filename().string().find("private.json.tmp-") == 0 &&
          entry.path() != foreign)
        ++temporary;
    check(temporary == 1, "Repeated crashes retain at most one target replacement");
    std::ifstream input(file);
    std::string original;
    input >> original;
    check(original == "original", "Unpublished replacement never changes authoritative file");
  }
  save_private_text(file, "published");
  check(std::filesystem::exists(foreign), "Cleanup preserves foreign temporary names");
  for (const auto &entry : std::filesystem::directory_iterator(root))
    check(entry.path().filename().string().find("private.json.tmp-") != 0 ||
              entry.path() == foreign,
          "Successful publication reclaims only exact abandoned private replacements");
  const auto symlink = name + ".tmp-" + uuid();
  std::filesystem::create_symlink(file, symlink);
  rejects([&] { save_private_text(file, "must not publish"); }, "CONFIG_ERROR");
  check(std::filesystem::is_symlink(symlink),
        "Cleanup refuses an unexpected link without following it");
}
#endif
void journal_limits(const std::filesystem::path &root) {
  const auto work = root / "budget-base";
  std::filesystem::create_directory(work);
  const auto config =
      catalog_config(root, "bounded",
                     Json::array({{{"id", "base"}, {"name", "Base"}, {"path", work.u8string()}}}));
  Store::Lock lock(config.at("dataDir"), true);
  const auto idle = [](const std::string &) { return false; };
  const auto first = rename_request("first", 0);
  auto last = first;
  Json last_result;
  {
    Projects projects(config);
    projects.request(first, idle);
    for (int64_t n = 1; n < credit::project_records; ++n) {
      // Pressure cleanup can advance the catalogue fence between requests.
      projects.cleanup();
      last = rename_request("request-" + std::to_string(n), projects.list().at("revision"));
      last_result = projects.request(last, idle);
    }
    check(projects.usage().at("requests") < credit::project_records,
          "Pressure cleanup releases old project identities before the hard limit");
    check(projects.usage().at("bytes") <= credit::project_budget &&
              projects.usage().at("receiptBytes") <= credit::project_tail_bytes,
          "Project identities, results and metadata share finite storage budgets");
    rejects([&] { projects.request(first, idle); }, "REQUEST_EXPIRED");
  }
  Projects resumed(config);
  check(resumed.request(last, idle) == last_result,
        "A full journal still returns the original result");
  rejects([&] { resumed.request(first, idle); }, "REQUEST_EXPIRED");
  auto conflict = first;
  conflict["name"] = "Changed after eviction";
  rejects([&] { resumed.request(conflict, idle); }, "REQUEST_EXPIRED");
  const auto directory = root / "must-not-create-at-full";
  const Json overflow = {{"operation", "add"},
                         {"id", "overflow"},
                         {"name", "Overflow"},
                         {"path", directory.u8string()},
                         {"mkdir", true},
                         {"requestId", "overflow"},
                         {"revision", resumed.list().at("revision")}};
  resumed.request(overflow, idle);
  check(std::filesystem::exists(directory), "Reclaimed project journal still refuses new work");
  for (int i = 0; i < 10 && resumed.usage().at("requests") != 0; ++i)
    resumed.cleanup(now() + 8 * 86400000LL);
  check(resumed.usage().at("requests") == 0, "Project identities exceeded one week");
  rejects([&] { resumed.request(last, idle); }, "REQUEST_EXPIRED");
  Projects reopened(config);
  rejects([&] { reopened.request(last, idle); }, "REQUEST_EXPIRED");
  check(reopened.list().at("projects").size() == 2, "Cleanup deleted project configuration");
}
void owner_isolation(const std::filesystem::path &root) {
  const auto config = catalog_config(
      root, "owners",
      Json::array(
          {{{"id", "base"}, {"name", "Base"}, {"path", (root / "budget-base").u8string()}}}));
  Store::Lock lock(config.at("dataDir"), true);
  const auto idle = [](const std::string &) { return false; };
  Projects projects(config);
  const auto first = rename_request("same-id", 0);
  const auto original = projects.request(first, idle, std::string(64, 'a'));
  rejects([&] { projects.request(first, idle, std::string(64, 'b')); }, "PROJECT_CONFLICT");
  auto second = first;
  second["name"] = "Second owner's intention";
  second["revision"] = 1;
  check(projects.request(second, idle, std::string(64, 'b')).at("revision") == 2,
        "Different authenticated owners can use independent original request IDs");
  check(projects.request(first, idle, std::string(64, 'a')) == original,
        "An original result remains bound to its authenticated owner");
  rejects([&] { projects.request(second, idle, std::string(64, 'a')); }, "IDEMPOTENCY_CONFLICT");
  second["revision"] = 2;
  check(projects.request(second, idle).at("revision") == 3,
        "Local control has an independent server-selected identity namespace");
}
void catalog_limits(const std::filesystem::path &root) {
  const auto idle = [](const std::string &) { return false; };
  const auto work = root / "catalog-new";
  Json projects = Json::array();
  const auto listed_bytes = [&] {
    auto listed = projects;
    for (auto &p : listed)
      p["available"] = false;
    return Json{{"revision", 0}, {"projects", listed}}.dump().size();
  };
  const size_t target = max_frame - 8192 - 32;
  while (listed_bytes() + 3200 < target) {
    const auto id = projects.empty() ? "base" : "project-" + std::to_string(projects.size());
    projects.push_back({{"id", id},
                        {"name", "Project"},
                        {"path", "/" + std::string(2990, 'p') + std::to_string(projects.size())}});
  }
  projects.push_back({{"id", "last"}, {"name", "Last"}, {"path", "/last"}});
  check(listed_bytes() < target, "Catalog fixture fits before filling the final path");
  projects.back()["path"] =
      projects.back().at("path").get<std::string>() + std::string(target - listed_bytes(), 'q');
  const auto config = catalog_config(root, "large-catalog", projects);
  Store::Lock lock(config.at("dataDir"), true);
  Projects catalog(config);
  const Json add = {{"operation", "add"}, {"path", work.u8string()}, {"mkdir", true},
                    {"id", "new"},        {"name", "New"},           {"revision", 0},
                    {"requestId", "new"}};
  rejects([&] { catalog.request(add, idle); }, "MESSAGE_TOO_LARGE");
  check(!std::filesystem::exists(work) && catalog.usage().at("requests") == 0,
        "Catalog frame admission includes list availability fields and precedes mkdir");
  Json last;
  for (int n = 0; n < 24; ++n) {
    auto request = rename_request("r" + std::to_string(n), n);
    request["name"] = "P";
    last = catalog.request(request, idle);
  }
  check(catalog.usage().at("receiptBytes") <= credit::project_tail_bytes &&
            catalog.usage().at("bytes") <= credit::project_budget,
        "Repeated large catalog results cannot multiply the storage budget");
  const auto stored = read_json(root / "large-catalog" / "projects.json");
  size_t result_bytes = 0;
  for (const auto &receipt : stored.at("journal").at("tail"))
    result_bytes += receipt.dump().size() + 4096 + receipt.at("result").at("projects").size() * 512;
  check(result_bytes <= credit::project_tail_bytes &&
            stored.at("journal").at("tail").size() <= credit::project_tail &&
            std::filesystem::file_size(root / "large-catalog" / "projects.json") * 2 <=
                credit::project_budget,
        "Actual retained results include every copied project's metadata and fit the replacement "
        "budget");
  auto newest = rename_request("r23", 23);
  newest["name"] = "P";
  check(catalog.request(newest, idle) == last, "The newest large receipt remains queryable");
  auto oldest = rename_request("r0", 0);
  oldest["name"] = "P";
  rejects([&] { catalog.request(oldest, idle); }, "RESULT_UNAVAILABLE");
}
#ifdef __linux__
void interrupted_projects(const std::filesystem::path &root) {
  const auto idle = [](const std::string &) { return false; };
  for (const int fault : {1, 2, 3}) {
    const auto scope = fault == 1 ? "crash" : fault == 2 ? "finish-storage-failure" : "unpublished";
    const auto config = catalog_config(root, scope);
    const auto file = root / scope / "projects.json";
    const auto backup = root / scope / "started.backup";
    const auto directory = root / (std::string(scope) + "-directory");
    const Json request = {{"operation", "add"},     {"path", directory.u8string()}, {"mkdir", true},
                          {"id", "original"},       {"name", "Original"},           {"revision", 0},
                          {"requestId", "original"}};
    {
      Store::Lock lock(config.at("dataDir"), true);
      Projects initialize(config);
    }
    const auto child = fork();
    check(child >= 0, "Project fault child starts");
    if (child == 0) {
      const auto target_text = directory.string(), file_text = file.string(),
                 backup_text = backup.string();
      fault_directory = target_text.c_str();
      fault_catalog = file_text.c_str();
      fault_backup = backup_text.c_str();
      project_fault = fault;
      try {
        Store::Lock lock(config.at("dataDir"), true);
        Projects projects(config);
        if (fault != 2) {
          projects.request(request, idle);
          _exit(50);
        }
        rejects([&] { projects.request(request, idle); }, "RESULT_UNKNOWN");
        rejects([&] { projects.request(request, idle); }, "STORAGE_ERROR");
        _exit(0);
      } catch (...) {
        _exit(51);
      }
    }
    struct Guard {
      pid_t pid;
      ~Guard() {
        if (pid > 0) {
          kill(pid, SIGKILL);
          waitpid(pid, nullptr, 0);
        }
      }
    } guard{child};
    int status = 0;
    check(waitpid(child, &status, WUNTRACED) == child, "Observe the actual project process");
    if (WIFEXITED(status) || WIFSIGNALED(status))
      guard.pid = -1;
    if (fault != 2) {
      check(WIFSTOPPED(status), "Crash injection reaches the exact project storage boundary");
      const auto original_key =
          delivery_digest(Json{{"owner", "local"}, {"requestId", "original"}}.dump());
      if (fault == 1) {
        check(read_json(file).at("journal").at("keys").at(original_key).at("phase") == "started",
              "Original identity and result reservation precede the actual directory creation");
      } else {
        check(read_json(file).at("journal").at("keys").empty() &&
                  !std::filesystem::exists(directory),
              "Unpublished started cannot reach a filesystem side effect");
        size_t temporaries = 0;
        for (const auto &entry : std::filesystem::directory_iterator(file.parent_path()))
          temporaries += entry.path().filename().string().find("projects.json.tmp-") == 0;
        check(temporaries == 1,
              "An interrupted rewrite consumes at most one pre-reserved temporary");
      }
      kill(child, SIGKILL);
      waitpid(child, nullptr, 0);
      guard.pid = -1;
    } else {
      check(WIFEXITED(status) && WEXITSTATUS(status) == 0,
            "Final catalog write fault stops new work");
      check(std::filesystem::is_directory(file),
            "Final publication encountered a real storage fault");
      std::filesystem::remove(file);
      std::filesystem::rename(backup, file);
    }
    if (fault == 3) {
      Store::Lock lock(config.at("dataDir"), true);
      Projects resumed(config);
      for (const auto &entry : std::filesystem::directory_iterator(file.parent_path()))
        check(entry.path().filename().string().find("projects.json.tmp-") != 0,
              "Restart removes an actual killed process's unpublished temporary before new writes");
      check(resumed.request(request, idle).at("revision") == 1,
            "An intention not durably admitted may execute after recovering the abandoned rewrite");
      continue;
    }
    check(std::filesystem::is_directory(directory),
          "The interrupted operation created its directory");
    Store::Lock lock(config.at("dataDir"), true);
    Projects resumed(config);
    rejects([&] { resumed.request(request, idle); }, "RESULT_UNKNOWN");
    check(
        resumed.list().at("projects").empty() && resumed.list().at("revision") == 0 &&
            resumed.usage().at("unknown") == 1 && resumed.usage().at("reserved") == 0,
        "Restart preserves the unknown identity without replaying or falsely publishing a project");
    auto changed = request;
    changed["name"] = "Changed";
    rejects([&] { resumed.request(changed, idle); }, "IDEMPOTENCY_CONFLICT");
    auto explicit_intent = request;
    explicit_intent["requestId"] = "explicit-new-intent";
    check(resumed.request(explicit_intent, idle).at("revision") == 1,
          "An explicit new intention can register the inspected existing directory");
    rejects([&] { resumed.request(request, idle); }, "RESULT_UNKNOWN");
  }
}
#endif
void admission_faults(const std::filesystem::path &root) {
  const auto idle = [](const std::string &) { return false; };
  const auto config = catalog_config(root, "admission");
  const auto file = root / "admission" / "projects.json";
  const auto directory = root / "no-space-directory";
  const Json add = {{"operation", "add"}, {"id", "new"},   {"path", directory.u8string()},
                    {"name", "New"},      {"mkdir", true}, {"revision", 0},
                    {"requestId", "new"}};
  Store::Lock lock(config.at("dataDir"), true);
  Json clean;
  size_t bytes;
  {
    Projects initialized(config);
    clean = read_json(file);
    bytes = initialized.usage().at("bytes");
  }
  const auto abandoned = file.u8string() + ".tmp-" + uuid();
  const auto unrelated = file.u8string() + ".tmp-user-note";
  save_private_text(abandoned, "Unpublished replacement");
  save_private_text(unrelated, "Preserve unrelated file");
  {
    Projects cleanup(config);
    check(!std::filesystem::exists(abandoned) && std::filesystem::exists(unrelated),
          "Restart only removes unpublished replacements in the exact project temporary namespace");
  }
  auto padded = clean;
  padded["padding"] = std::string((credit::project_budget - bytes) / 2 - 2048, 'x');
  save_private_text(file, padded.dump() + "\n");
  {
    Projects full(config);
    check(full.usage().at("bytes") < credit::project_budget,
          "The loaded file fits its total budget");
    rejects([&] { full.request(add, idle); }, "BACKPRESSURE");
    check(!std::filesystem::exists(directory) && full.usage().at("requests") == 0,
          "Unused terminal-result reservation is charged before any project side effect");
  }
  save_private_text(file, clean.dump() + "\n");
  {
    Projects failed(config);
    std::filesystem::rename(file, root / "admission" / "backup");
    std::filesystem::create_directory(file);
    rejects([&] { failed.request(add, idle); }, "CONFIG_ERROR");
    check(!std::filesystem::exists(directory), "Failure persisting started cannot reach mkdir");
    rejects([&] { failed.request(add, idle); }, "STORAGE_ERROR");
    check(failed.usage().at("storageFailed") == true, "Project metrics expose the storage failure");
    std::filesystem::remove(file);
    std::filesystem::rename(root / "admission" / "backup", file);
  }
  {
    Projects recovered(config);
    check(recovered.request(add, idle).at("revision") == 1,
          "An intent never admitted to disk can execute after storage is restored");
  }
  auto retired = clean;
  for (int64_t i = 0; i < credit::project_retired_ids; ++i)
    retired["retiredIds"].push_back("retired-" + std::to_string(i));
  retired["projects"] =
      Json::array({{{"id", "new"}, {"name", "New"}, {"path", directory.u8string()}}});
  save_private_text(file, retired.dump() + "\n");
  {
    Projects full(config);
    const Json remove = {
        {"operation", "remove"}, {"id", "new"}, {"revision", 0}, {"requestId", "remove"}};
    rejects([&] { full.request(remove, idle); }, "BACKPRESSURE");
    check(full.list().at("projects").size() == 1 && full.usage().at("requests") == 0,
          "Retired project IDs are bounded without discarding their refusal boundary");
  }
  auto exhausted = clean;
  exhausted["revision"] = 9007199254740991LL;
  save_private_text(file, exhausted.dump() + "\n");
  {
    Projects full(config);
    auto request = add;
    request["revision"] = 9007199254740991LL;
    rejects([&] { full.request(request, idle); }, "BACKPRESSURE");
    check(full.usage().at("requests") == 0,
          "Revision exhaustion cannot overflow or admit an identity");
  }
  {
    std::ofstream oversized(file, std::ios::binary | std::ios::trunc);
    oversized.seekp(credit::project_budget);
    oversized.put('x');
  }
  rejects([&] { Projects oversized(config); }, "BACKPRESSURE");
}
} // namespace
int main() {
  auto root = std::filesystem::temp_directory_path() / ("coc-projects-" + uuid());
  std::filesystem::create_directories(root);
  try {
    Json config = {
        {"hostId", "alice"}, {"dataDir", (root / "state").u8string()}, {"projects", Json::array()}};
    auto idle = [](const std::string &) { return false; };
    Json add = {{"operation", "add"},     {"path", (root / "work" / "one").u8string()},
                {"mkdir", true},          {"id", "one"},
                {"requestId", "add-one"}, {"revision", 0}};
    {
      Store::Lock lock(config.at("dataDir"), true);
      Projects projects(config);
      check(projects.list()["projects"].empty(), "Empty catalog");
      const auto first = projects.request(add, idle);
      check(first["revision"] == 1 && first["projects"][0]["id"] == "one",
            "Add existing or new directory");
      check(projects.request(add, idle) == first,
            "Duplicate request uses persisted result before revision check");
      auto altered = add;
      altered["name"] = "different";
      rejects([&] { projects.request(altered, idle); }, "IDEMPOTENCY_CONFLICT");
      auto stale = add;
      stale["requestId"] = "stale";
      rejects([&] { projects.request(stale, idle); }, "PROJECT_CONFLICT");
      auto nested = add;
      nested["revision"] = 1;
      nested["requestId"] = "nested";
      nested["id"] = "nested";
      nested["path"] = (root / "work" / "one" / "nested").u8string();
      rejects([&] { projects.request(nested, idle); }, "PROJECT_CONFLICT");
      check(!std::filesystem::exists(root / "work" / "one" / "nested"),
            "Rejected add does not create directory");
#ifndef _WIN32
      std::filesystem::create_directory_symlink(root / "work" / "one", root / "alias");
      nested["path"] = (root / "alias").u8string();
      rejects([&] { projects.request(nested, idle); }, "PROJECT_CONFLICT");
#endif
      Json rename = {{"operation", "rename"},
                     {"id", "one"},
                     {"name", "First"},
                     {"revision", 1},
                     {"requestId", "rename"}};
      projects.request(rename, idle);
      Json remove = {
          {"operation", "remove"}, {"id", "one"}, {"revision", 2}, {"requestId", "remove"}};
      rejects([&] { projects.request(remove, [](const std::string &) { return true; }); },
              "PROJECT_BUSY");
      check(projects.list()["revision"] == 2, "Busy rejection leaves revision unchanged");
      projects.request(remove, idle);
      check(std::filesystem::is_directory(root / "work" / "one"), "Remove preserves project files");
      add["requestId"] = "reuse";
      add["revision"] = 3;
      rejects([&] { projects.request(add, idle); }, "PROJECT_CONFLICT");
    }
    add["id"] = "second-id";
    auto result = local_project_request(config, add);
    check(result["revision"] == 4, "Offline commands share catalog and instance lock");
    std::filesystem::rename(root / "work" / "one", root / "work" / "moved");
    check(local_project_request(config, {{"operation", "list"}})["projects"][0]["available"] ==
              false,
          "Missing directory does not prevent catalog loading");
    auto full_config = config;
    full_config["relayUrl"] = "https://relay.example";
    full_config["token"] = "test-credential-long-enough";
    std::ofstream(root / "work" / "one") << "directory replaced with a file";
    check(agent_config(full_config).at("projects").size() == 1,
          "Unavailable registered paths cannot prevent other projects from starting");
    check(local_project_request(config, {{"operation", "list"}})["projects"][0]["available"] ==
              false,
          "A file replacing a directory is unavailable");
    Json other = {{"hostId", "bob"},
                  {"dataDir", (root / "bob-state").u8string()},
                  {"projects", Json::array()}};
    {
      Store::Lock lock(config.at("dataDir"), true), other_lock(other.at("dataDir"), true);
      Projects projects(config), bob(other);
      asio::io_context io;
      ProjectControl control(io, config, [&](Json d) { return projects.request(d, idle); });
      ProjectControl other_control(io, other, [&](Json d) { return bob.request(d, idle); });
      std::thread worker([&] { io.run(); });
      try {
        check(local_project_request(config, {{"operation", "list"}})["projects"].size() == 1,
              "Online local IPC uses Alice catalog");
        check(local_project_request(other, {{"operation", "list"}})["projects"].empty(),
              "Second Agent catalog isolated");
        auto endpoint = root / "state" / "project-control.json";
        auto original = read_json(endpoint), tampered = original;
        tampered["token"] = "wrong";
        save_private(endpoint, tampered);
        rejects([&] { local_project_request(config, {{"operation", "list"}}); }, "FORBIDDEN");
        save_private(endpoint, original);
        auto wrong_host = config;
        wrong_host["hostId"] = "bob";
        rejects([&] { local_project_request(wrong_host, {{"operation", "list"}}); }, "FORBIDDEN");
      } catch (...) {
        io.stop();
        worker.join();
        throw;
      }
      io.stop();
      worker.join();
    }
    check(local_project_request(other, {{"operation", "list"}})["projects"].empty(),
          "Stale endpoint ignored when state lock is available");
    legacy_catalog(root);
#ifdef __linux__
    interrupted_private_files(root);
#endif
    journal_limits(root);
    owner_isolation(root);
    catalog_limits(root);
    admission_faults(root);
#ifdef __linux__
    interrupted_projects(root);
#endif
    std::filesystem::remove_all(root);
    std::cout
        << "PASS: project persistence, conflicts, busy protection, identity and local control\n";
    return 0;
  } catch (const std::exception &e) {
    std::cerr << "FAIL: " << e.what() << '\n';
    std::filesystem::remove_all(root);
    return 1;
  }
}
