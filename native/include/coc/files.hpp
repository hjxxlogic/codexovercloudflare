#pragma once
#include "common.hpp"
#include <map>
#include <memory>
namespace coc {
class WorkspaceFiles {
  struct Upload;
  std::map<std::string, std::unique_ptr<Upload>> uploads_;

public:
  WorkspaceFiles();
  ~WorkspaceFiles();
  Json request(const std::string &root, const std::string &sandbox, const std::string &owner,
               const Json &data);
  void cleanup();
  void clear();
};
} // namespace coc
