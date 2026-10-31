#pragma once
#include "network.hpp"
#include "store.hpp"
namespace coc {
// Loopback-only, ticket-authenticated WebSocket endpoint for Codex TUI.
class TuiBridge {
  class Impl;
  std::shared_ptr<Impl> impl_;

public:
  TuiBridge(asio::io_context &, const Url &, const std::string &ticket, const std::string &path,
            Store *delivery_store = nullptr, std::function<Json(Json)> resume = {});
  ~TuiBridge();
  std::string url() const;
  void observe_output_head(int64_t head);
};
std::string remote_address(const Url &, const std::string &path);
} // namespace coc
