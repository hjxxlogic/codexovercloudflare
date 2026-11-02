#pragma once
#include "coc/common.hpp"
#include <boost/asio.hpp>
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
  bool busy(const std::string &project) const;
  void close_session(const std::string &session);
  void clear();
};
} // namespace coc
