#pragma once
#include "common.hpp"
#include <array>
#include <memory>
namespace coc {
enum class RuntimeResource { command, priority, approval, approval_request, count };
// A reservation follows the actual retained command/approval and its callbacks,
// including after the owning Runtime is removed from the Agent's live map.
class RuntimeResources : public std::enable_shared_from_this<RuntimeResources> {
  struct Counter {
    size_t records = 0, bytes = 0, wire = 0;
  };
  std::array<Counter, static_cast<size_t>(RuntimeResource::count)> used_;
  struct Lease;

public:
  std::shared_ptr<void> reserve(RuntimeResource, size_t bytes, size_t wire = 0);
  static Json usage();
};
} // namespace coc
