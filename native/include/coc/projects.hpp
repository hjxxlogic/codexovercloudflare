#pragma once
#include "login.hpp"
namespace coc {
// The caller holds the Agent state lock and serializes catalog mutations.
class Projects {
  std::filesystem::path file_;
  Json state_;
  bool failed_ = false;
  Json retention_policy_;
  void commit(Json);
  Json execute(const Json &, const std::function<bool(const std::string &)> &, const std::string &);

public:
  explicit Projects(const Json &config);
  void cleanup(int64_t time = -1);
  Json list() const;
  Json usage() const;
  Json request(const Json &, const std::function<bool(const std::string &)> &busy,
               const std::string &owner = "local");
};
Json project_arguments(const Options &, bool remote = false);
Json local_project_request(const Json &config, Json request);
class ProjectControl {
  struct Impl;
  std::shared_ptr<Impl> impl_;

public:
  ProjectControl(asio::io_context &, const Json &, std::function<Json(Json)>);
  ~ProjectControl();
  ProjectControl(const ProjectControl &) = delete;
  ProjectControl &operator=(const ProjectControl &) = delete;
};
} // namespace coc
