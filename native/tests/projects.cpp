#include "coc/projects.hpp"
#include "coc/store.hpp"
#include <fstream>
#include <iostream>
#include <thread>
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
