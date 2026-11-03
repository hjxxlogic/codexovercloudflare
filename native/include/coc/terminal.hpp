#pragma once
#include "coc/common.hpp"
#include <boost/asio.hpp>
#include <functional>
#include <memory>
namespace coc {
// Linux-only sandboxed PTYs. Other platforms fail closed until their isolation
// implementation is available. All methods run on the Agent business executor.
class Terminals {
  struct Impl;
  std::shared_ptr<Impl> impl_;

public:
  Terminals(boost::asio::io_context &, const Json &config);
  ~Terminals();
  Json metadata() const;
  Json request(const Json &, const std::string &root);
  void stream(const Json &, const std::string &route, const Json &frame,
              std::function<void(Json)> emit);
  void detach(const std::string &route);
  bool busy(const std::string &project) const;
  void close_session(const std::string &session);
  void clear();
};
} // namespace coc
