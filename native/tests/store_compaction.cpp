#include "coc/store.hpp"
#include <iostream>
using namespace coc;
namespace {
void check(bool ok, const char *message) {
  if (!ok)
    throw std::runtime_error(message);
}
struct Fixture {
  std::string path = (std::filesystem::temp_directory_path() / ("coc-compact-" + uuid())).string();
  sqlite3 *db = nullptr;
  Fixture(bool bad_control = false, bool bad_digest = false) {
    std::filesystem::create_directories(path);
    check(sqlite3_open((path + "/agent.db").c_str(), &db) == SQLITE_OK, "open fixture");
    sql("CREATE TABLE transport2_identity(id INTEGER PRIMARY KEY,instance TEXT NOT NULL)");
    sql("INSERT INTO transport2_identity VALUES(1,'original-instance')");
    sql("CREATE TABLE transport2_control(session TEXT PRIMARY KEY,epoch INTEGER NOT NULL,"
        "control_id TEXT NOT NULL,owner TEXT NOT NULL,ready TEXT NOT NULL)");
    const Json ready = {{"controlEpoch", 7},
                        {"controlId", "claim"},
                        {"owner", "owner"},
                        {"instance", bad_control ? "wrong-instance" : "original-instance"}};
    sql("INSERT INTO transport2_control VALUES('session',7,'claim','owner','" + ready.dump() +
        "')");
    sql("CREATE TABLE transport2_command_keys(stream TEXT NOT NULL,request_id TEXT NOT NULL,"
        "seq INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY "
        "KEY(stream,request_id),UNIQUE(stream,seq))");
    sql("INSERT INTO transport2_command_keys VALUES('stream','rpc:1',1,'digest')");
    sql("CREATE TABLE transport2_namespaces(scope TEXT PRIMARY KEY,allocated INTEGER NOT NULL,"
        "closed_through INTEGER NOT NULL)");
    sql("INSERT INTO transport2_namespaces VALUES('scope',2,1)");
    sql("CREATE TABLE transport2_credit(stream TEXT PRIMARY KEY,session TEXT NOT NULL,lane TEXT "
        "NOT "
        "NULL,scope TEXT NOT NULL,serial INTEGER NOT NULL,generation TEXT NOT NULL,reserved "
        "INTEGER "
        "NOT NULL,credit INTEGER NOT NULL DEFAULT 0,byte_credit INTEGER NOT NULL DEFAULT 0,"
        "closed INTEGER NOT NULL DEFAULT 0,UNIQUE(scope,serial))");
    sql("INSERT INTO transport2_credit "
        "VALUES('closed','session','normal','scope',1,'first',0,0,0,1)");
    sql("INSERT INTO transport2_credit "
        "VALUES('open','session','normal','scope',2,'second',0,0,0,0)");
    sql("CREATE TABLE transport2_command_digests(stream TEXT NOT NULL,seq INTEGER NOT NULL,"
        "digest TEXT NOT NULL,PRIMARY KEY(stream,seq))");
    sql(std::string("INSERT INTO transport2_command_digests VALUES('stream',1,'") +
        (bad_digest ? "conflict" : "digest") + "')");
  }
  ~Fixture() {
    sqlite3_close(db);
    std::filesystem::remove_all(path);
  }
  void sql(const std::string &text) {
    check(sqlite3_exec(db, text.c_str(), nullptr, nullptr, nullptr) == SQLITE_OK, "fixture SQL");
  }
  int count(const std::string &text) {
    sqlite3_stmt *statement = nullptr;
    check(sqlite3_prepare_v2(db, text.c_str(), -1, &statement, nullptr) == SQLITE_OK,
          "fixture query");
    check(sqlite3_step(statement) == SQLITE_ROW, "fixture row");
    const auto value = sqlite3_column_int(statement, 0);
    sqlite3_finalize(statement);
    return value;
  }
  bool old_columns() {
    return count(
               "SELECT COUNT(*) FROM pragma_table_info('transport2_control') WHERE name='ready'") ==
               1 &&
           count("SELECT COUNT(*) FROM pragma_table_info('transport2_command_keys') WHERE "
                 "name='digest'") == 1 &&
           count("SELECT COUNT(*) FROM pragma_table_info('transport2_namespaces') WHERE "
                 "name='closed_through'") == 1;
  }
};
} // namespace
int main() {
  try {
    {
      Fixture fixture;
      Json ready;
      {
        Store store(fixture.path, false);
        ready = store.control_state("session");
        check(store.delivery_budget().at("namespaces").at(0).at("closedThrough") == 1,
              "Namespace telemetry derives the original continuous closure checkpoint");
        store.delivery_close("open");
        check(store.delivery_budget().at("namespaces").at(0).at("closedThrough") == 2,
              "Closing the final flow derives allocated without a checkpoint write");
        check(ready.at("controlEpoch") == 7 && ready.at("instance") == "original-instance",
              "Derived control confirmation preserves original fencing identity");
      }
      check(
          fixture.count(
              "SELECT COUNT(*) FROM pragma_table_info('transport2_control') WHERE name='ready'") ==
                  0 &&
              fixture.count("SELECT COUNT(*) FROM pragma_table_info('transport2_control') WHERE "
                            "name='retained_at'") == 1 &&
              fixture.count("SELECT COUNT(*) FROM pragma_table_info('transport2_command_keys')") ==
                  3,
          "Redundant columns are removed");
      check(fixture.count("SELECT COUNT(*) FROM transport2_command_keys WHERE stream='stream' AND "
                          "request_id='rpc:1' AND seq=1") == 1,
            "Original request refusal identity is preserved");
      check(fixture.count("SELECT COUNT(*) FROM pragma_table_info('transport2_namespaces')") == 2,
            "Derived namespace checkpoint column is removed");
      Store reopened(fixture.path, false);
      check(reopened.delivery_budget().at("namespaces").at(0).at("closedThrough") == 2,
            "Namespace closure is reconstructed after restart");
      check(reopened.control_state("session") == ready, "Compaction is restart-idempotent");
    }
    for (const bool bad_control : {false, true}) {
      Fixture fixture(bad_control, !bad_control);
      bool rejected = false;
      try {
        Store store(fixture.path, false);
      } catch (const Error &error) {
        rejected = error.code == "STORAGE_CORRUPT";
      }
      check(rejected && fixture.old_columns(), "Conflict rolls back all schema/data changes");
      check(fixture.count("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '%_compact'") == 0,
            "Failed compaction leaves no partial replacement tables");
    }
    {
      Fixture fixture;
      fixture.sql("UPDATE transport2_namespaces SET closed_through=2");
      bool rejected = false;
      try {
        Store store(fixture.path, false);
      } catch (const Error &error) {
        rejected = error.code == "STORAGE_CORRUPT";
      }
      check(rejected && fixture.old_columns(), "Checkpoint conflict rolls back all compactions");
      check(fixture.count("SELECT closed_through FROM transport2_namespaces") == 2,
            "Conflicting checkpoint is preserved for diagnosis");
      check(fixture.count("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '%_compact'") == 0,
            "Checkpoint conflict leaves no partial tables");
    }
    std::cout << "PASS: durable identity compaction, restart and transactional failure rollback\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
