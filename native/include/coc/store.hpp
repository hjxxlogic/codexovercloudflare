#pragma once
#include "common.hpp"
#include <sqlite3.h>
namespace coc {
class Store {
  struct Lock {
    int fd = -1;
    explicit Lock(const std::string &dir);
    ~Lock();
  };
  Lock lock_;
  sqlite3 *db_ = nullptr;
  Json query(const std::string &sql, const Json &args = Json::array());
  void run(const std::string &sql, const Json &args = Json::array());

public:
  explicit Store(const std::string &dir);
  ~Store();
  Store(const Store &) = delete;
  Store &operator=(const Store &) = delete;
  void save(const Json &session);
  Json sessions();
  Json get(const std::string &id);
  Json event(const std::string &id, const std::string &type, const Json &data);
  Json replay(const std::string &id, int64_t after);
  Json begin(const std::string &key, const std::string &fingerprint);
  void finish(const std::string &key, const Json &value);
  void cleanup();
};
} // namespace coc
