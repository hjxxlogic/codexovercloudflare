#pragma once
#include "login.hpp"
namespace coc {
class Projects {
  std::filesystem::path file_;
  Json state_;
  Json execute(const Json &, const std::function<bool(const std::string &)> &);

public:
  explicit Projects(const Json &config);
  Json list() const;
  Json request(const Json &, const std::function<bool(const std::string &)> &busy);
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
