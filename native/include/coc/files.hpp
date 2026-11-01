#pragma once
#include "common.hpp"
#include <map>
#include <memory>
#include <vector>
namespace coc {
class Store;
std::string workspace_upload_identity(const std::string &root, const std::string &owner,
                                      const std::string &id);
void validate_workspace_upload(const Json &data, const std::string &instance);
class WorkspaceFiles {
  Store &store_;
  std::string directory_key_, directory_version_;
  std::vector<std::string> directory_names_;
  int64_t directory_cached_ = 0;
  Json upload_receipt(const std::string &root, const std::string &owner, const std::string &id);
  void begin_receipt(const std::string &root, const std::string &owner, const std::string &id,
                     const Json &body);
  void finish_receipt(const std::string &root, const std::string &owner, const std::string &id,
                      const Json &result, bool reclaimed);
  struct Upload;
  std::map<std::string, std::unique_ptr<Upload>> uploads_;

public:
  explicit WorkspaceFiles(Store &store);
  ~WorkspaceFiles();
  Json request(const std::string &root, const std::string &sandbox, const std::string &owner,
               const Json &data);
  void cleanup();
  void clear();
};
} // namespace coc
