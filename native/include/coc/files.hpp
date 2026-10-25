#pragma once
#include "common.hpp"
#include <map>
#include <memory>
#include <vector>
namespace coc {
class Store;
class WorkspaceFiles {
  Store *store_;
  std::map<std::string, Json> completed_;
  std::string directory_key_, directory_version_;
  std::vector<std::string> directory_names_;
  int64_t directory_cached_ = 0;
  struct Upload;
  std::map<std::string, std::unique_ptr<Upload>> uploads_;

public:
  explicit WorkspaceFiles(Store *store = nullptr);
  ~WorkspaceFiles();
  Json request(const std::string &root, const std::string &sandbox, const std::string &owner,
               const Json &data);
  void cleanup();
  void clear();
};
} // namespace coc
