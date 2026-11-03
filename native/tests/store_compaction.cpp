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
  Fixture(bool bad_control = false, bool bad_digest = false, bool current = false) {
    std::filesystem::create_directories(path);
    if (current) {
      Store store(path, false);
      store.save(
          {{"id", "unbound"}, {"projectId", "project"}, {"state", "ready"}, {"mode", "web"}});
    }
    check(sqlite3_open((path + "/agent.db").c_str(), &db) == SQLITE_OK, "open fixture");
    if (current) {
      sql("PRAGMA user_version=0");
      sql("ALTER TABLE transport2_retention ADD COLUMN legacy_allowed INTEGER NOT NULL DEFAULT 1");
      return;
    }
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
      Fixture fixture(false, false, true);
      {
        Store store(fixture.path, false);
        auto session = store.get("unbound");
        check(!session.contains("cwAccountId"), "Unbound session is preserved without claiming");
        check(store.session_page({{"cwAccountId", "mailbox"}}).at("data").empty(),
              "Unbound session is absent from the mailbox directory");
        session["cwAccountId"] = "mailbox";
        store.save(session);
      }
      {
        Store store(fixture.path, false);
        check(store.session_page({{"cwAccountId", "mailbox"}}).at("data").size() == 1 &&
                  store.session_page({{"cwAccountId", "other"}}).at("data").empty(),
              "Explicit session ownership persists and remains isolated after reopening");
      }
      check(fixture.count("PRAGMA user_version") == 0 &&
                fixture.count("SELECT legacy_allowed FROM transport2_retention") == 1,
            "Current unmarked storage is used without schema conversion or compatibility flags");
    }
    for (int kind = 0; kind < 3; ++kind) {
      Fixture fixture(kind == 1, kind == 2);
      bool rejected = false;
      try {
        Store store(fixture.path, false);
      } catch (const Error &error) {
        rejected = error.code == "UNSUPPORTED_STORAGE_VERSION";
      }
      check(rejected && fixture.old_columns(), "Unsupported schema must be rejected unchanged");
      check(fixture.count("SELECT COUNT(*) FROM transport2_credit") == 2,
            "Rejected storage preserves credit identities");
    }
    std::cout << "PASS: unsupported journal schemas rejected without conversion or data loss\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
