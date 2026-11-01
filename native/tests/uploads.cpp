#include "coc/credit.hpp"
#include "coc/files.hpp"
#include "coc/store.hpp"
#include <fstream>
#include <iostream>
using namespace coc;
namespace {
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
struct Temp {
  std::string path = (std::filesystem::temp_directory_path() / ("coc-upload-" + uuid())).u8string();
  Temp() { std::filesystem::create_directories(path); }
  ~Temp() { std::filesystem::remove_all(path); }
};
void recovery() {
  Temp temp;
  const Json start = {
      {"operation", "begin"}, {"uploadId", "original"}, {"path", "proof.bin"}, {"size", 3}};
  Json receipt;
  {
    Store store(temp.path + "/state");
    WorkspaceFiles files(&store);
    const auto call = [&](Json d, const std::string &owner = "owner") {
      return files.request(temp.path, "workspace-write", owner, d);
    };
    call(start);
    const auto allocated = store.upload_budget();
    check(call(start).at("offset") == 0 && store.upload_budget() == allocated,
          "Duplicate begin retains the original allocation and staging file");
    auto changed = start;
    changed["path"] = "other.bin";
    rejects([&] { call(changed); }, "IDEMPOTENCY_CONFLICT");
    call({{"operation", "chunk"}, {"uploadId", "original"}, {"offset", 0}, {"data", "YWJj"}});
    rejects(
        [&] {
          call({{"operation", "finish"},
                {"uploadId", "original"},
                {"sha256", std::string(64, '0')}});
        },
        "UPLOAD_CONFLICT");
    check(!std::filesystem::exists(temp.path + "/proof.bin"),
          "Checksum mismatch cannot publish the staging file");
    receipt =
        call({{"operation", "finish"},
              {"uploadId", "original"},
              {"sha256", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}});
    check(store.upload_budget().at("bytes") == credit::upload_metadata &&
              store.upload_budget().at("active") == 0,
          "Durable publication releases staging bytes but preserves its refusal record");
    sqlite3 *aged = nullptr;
    check(sqlite3_open((temp.path + "/state/agent.db").c_str(), &aged) == SQLITE_OK,
          "Age receipt connection");
    check(sqlite3_exec(aged,
                       "UPDATE transport2_uploads SET result=json_set(result,'$.completedAt',0) "
                       "WHERE phase='completed'",
                       nullptr, nullptr, nullptr) == SQLITE_OK,
          "Age completed upload beyond the old TTL");
    sqlite3_close(aged);
    receipt["completedAt"] = 0;
    store.cache_clear();
    check(call({{"operation", "status"}, {"uploadId", "original"}}) == receipt,
          "Ordinary cache cleanup cannot erase an upload result");
    auto interrupted = start;
    interrupted["uploadId"] = "interrupted";
    interrupted["path"] = "pending.bin";
    call(interrupted);
    call({{"operation", "chunk"}, {"uploadId", "interrupted"}, {"offset", 0}, {"data", "YWJj"}});
    Store helper(temp.path + "/state", false);
    check(helper.upload_record(temp.path, "owner", "interrupted").at("phase") == "started",
          "A helper connection cannot retire a live upload");
    // Same uploadId from another owner has independent staging and receipt.
    interrupted["path"] = "other-owner.bin";
    call(interrupted, "another-owner");
    call({{"operation", "cancel"}, {"uploadId", "interrupted"}}, "another-owner");
    rejects([&] { call(interrupted, "another-owner"); }, "RESULT_UNKNOWN");
  }
  {
    Store store(temp.path + "/state");
    WorkspaceFiles files(&store);
    const auto call = [&](Json d) {
      return files.request(temp.path, "workspace-write", "owner", d);
    };
    check(call({{"operation", "finish"}, {"uploadId", "original"}}) == receipt,
          "Completed upload survives restart without cache TTL or repeated publication");
    std::ofstream(temp.path + "/proof.bin") << "later edit";
    rejects([&] { call(start); }, "UPLOAD_EXISTS");
    check(call({{"operation", "status"}, {"uploadId", "interrupted"}}).at("state") == "unknown",
          "An interrupted upload is durably unknown, never a fresh begin");
    auto interrupted = start;
    interrupted["uploadId"] = "interrupted";
    interrupted["path"] = "pending.bin";
    const auto budget = store.upload_budget();
    rejects([&] { call(interrupted); }, "RESULT_UNKNOWN");
    check(store.upload_budget() == budget && budget.at("active") == 1,
          "Unreconciled disk promises survive restart and rejected replay");
    check(store.upload_record(temp.path + "/different", "owner", "original").is_null() &&
              store.upload_record(temp.path, "foreign", "original").is_null(),
          "Root and owner isolate original identities");
  }
}
void storage_failure() {
  Temp temp;
  Store store(temp.path + "/state");
  bool stopped = false;
  store.on_failure([&] { stopped = true; });
  sqlite3 *fault = nullptr;
  check(sqlite3_open((temp.path + "/state/agent.db").c_str(), &fault) == SQLITE_OK,
        "Fault injection connection");
  const auto sql = "CREATE TRIGGER fail_upload BEFORE INSERT ON transport2_uploads BEGIN SELECT "
                   "RAISE(ABORT,'forced upload admission failure'); END";
  check(sqlite3_exec(fault, sql, nullptr, nullptr, nullptr) == SQLITE_OK,
        "Install admission storage fault");
  WorkspaceFiles files(&store);
  const Json request = {
      {"operation", "begin"}, {"uploadId", "storage-failure"}, {"path", "proof.bin"}, {"size", 3}};
  rejects([&] { files.request(temp.path, "workspace-write", "owner", request); }, "STORAGE_ERROR");
  check(stopped && store.upload_budget().at("records") == 0,
        "Failed admission rolls back and stops new side effects");
  size_t entries = 0;
  for (const auto &entry : std::filesystem::directory_iterator(temp.path)) {
    ++entries;
    check(entry.path().filename() == "state", "No staging file before durable admission");
  }
  check(entries == 1, "Only the test state directory exists");
  check(sqlite3_exec(fault, "DROP TRIGGER fail_upload", nullptr, nullptr, nullptr) == SQLITE_OK,
        "Remove test storage fault");
  sqlite3_close(fault);
}
void capacities() {
  Temp temp;
  Store store(temp.path);
  const Json body = {{"path", "proof"}, {"size", credit::upload_file}};
  for (int i = 0; i < 4; ++i)
    store.upload_prepare("/project", "owner-" + std::to_string(i / 2),
                         "active-" + std::to_string(i), body);
  const auto full = store.upload_budget();
  check(full.at("bytes") == 4 * (credit::upload_file + credit::upload_metadata),
        "Full staging promises are charged before bytes arrive");
  rejects([&] { store.upload_prepare("/project", "fresh-owner", "extra", body); }, "BACKPRESSURE");
  check(store.upload_budget() == full, "A new principal cannot multiply global staging capacity");
  store.upload_complete("/project", "owner-0", "active-0", {{"state", "completed"}}, true);
  store.upload_prepare("/project", "fresh-owner", "extra", body);
  check(store.upload_budget().at("active") == 4,
        "Reclaimed resources can serve a new original identity");

  Temp retired;
  Store journal(retired.path);
  for (int i = 0; i < credit::upload_records; ++i) {
    const auto owner = "owner-" + std::to_string(i / credit::upload_owner_records);
    const auto id = "retired-" + std::to_string(i);
    journal.upload_prepare("/project", owner, id, {{"path", "empty"}, {"size", 0}});
    journal.upload_complete("/project", owner, id, {{"state", "completed"}}, true);
    if (i == credit::upload_owner_records - 1)
      rejects([&] { journal.upload_prepare("/project", owner, "owner-overflow", body); },
              "BACKPRESSURE");
  }
  check(journal.upload_budget().at("bytes") == credit::upload_records * credit::upload_metadata,
        "All retired metadata remains within its dedicated global reservation");
  rejects([&] { journal.upload_prepare("/project", "fresh-owner", "overflow", body); },
          "BACKPRESSURE");
  rejects(
      [&] {
        journal.upload_prepare("/project", "owner-0", "retired-0",
                               {{"path", "empty"}, {"size", 0}});
      },
      "UPLOAD_EXISTS");
}
} // namespace
int main() {
  try {
    recovery();
    storage_failure();
    capacities();
    std::cout << "PASS: persistent upload identity, cache isolation, crash refusal and bounded "
                 "staging resources\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "FAIL: " << error.what() << '\n';
    return 1;
  }
}
