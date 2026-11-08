#pragma once
#include "process.hpp"
#include "store.hpp"
namespace coc {
// Serial, bounded catalog validation before invoking Codex's persisted mutations.
void manage_thread(asio::io_context &io, const Json &config, const std::string &cwd, Store &store,
                   const Json &request, const std::string &operation,
                   std::function<void(const Json &)> check_idle, Completion done);
} // namespace coc
