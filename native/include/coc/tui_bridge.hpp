#pragma once
#include "network.hpp"
namespace coc {
// Loopback-only, ticket-authenticated WebSocket endpoint for Codex TUI.
class TuiBridge {
  class Impl;
  std::shared_ptr<Impl> impl_;

public:
  TuiBridge(asio::io_context &, const Url &, const std::string &ticket, const std::string &path);
  ~TuiBridge();
  std::string url() const;
};
std::string remote_address(const Url &, const std::string &path);
} // namespace coc
