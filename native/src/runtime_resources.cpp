#include "coc/runtime_resources.hpp"
#include "coc/credit.hpp"
#include <mutex>
namespace coc {
namespace {
constexpr size_t count = static_cast<size_t>(RuntimeResource::count);
struct Usage {
  size_t records = 0, bytes = 0, wire = 0;
};
struct Totals {
  std::mutex mutex;
  std::array<Usage, count> used;
};
Totals &totals() {
  static Totals value;
  return value;
}
constexpr std::array<size_t, count> records = {credit::runtime_commands, credit::runtime_priority,
                                               credit::runtime_approvals,
                                               credit::approval_requests};
constexpr std::array<size_t, count> global_records = {
    credit::runtime_command_global, credit::runtime_priority_global,
    credit::runtime_approval_global, credit::approval_requests_global};
constexpr std::array<size_t, count> bytes = {
    credit::runtime_command_bytes, credit::runtime_priority_bytes, credit::runtime_approval_bytes,
    credit::approval_request_bytes};
constexpr std::array<size_t, count> global_bytes = {
    credit::runtime_command_global_bytes, credit::runtime_priority_global_bytes,
    credit::runtime_approval_global_bytes, credit::approval_request_global_bytes};
const std::array<const char *, count> names = {"commands", "priority", "approvals",
                                               "approvalRequests"};
} // namespace
struct RuntimeResources::Lease {
  std::shared_ptr<RuntimeResources> owner;
  size_t kind, charge, wire;
  Lease(std::shared_ptr<RuntimeResources> scope, size_t category, size_t size, size_t encoded)
      : owner(std::move(scope)), kind(category), charge(size), wire(encoded) {
    auto &all = totals();
    std::lock_guard<std::mutex> lock(all.mutex);
    auto &local = owner->used_[kind];
    auto &global = all.used[kind];
    if (local.records >= records[kind] || global.records >= global_records[kind] ||
        charge > bytes[kind] - local.bytes || charge > global_bytes[kind] - global.bytes ||
        (kind == static_cast<size_t>(RuntimeResource::approval) &&
         (wire > credit::runtime_approval_wire - local.wire ||
          wire > credit::runtime_approval_global_wire - global.wire)))
      throw Error("BACKPRESSURE", "Runtime command or approval budget exhausted");
    ++local.records;
    local.bytes += charge;
    local.wire += wire;
    ++global.records;
    global.bytes += charge;
    global.wire += wire;
  }
  ~Lease() {
    auto &all = totals();
    std::lock_guard<std::mutex> lock(all.mutex);
    auto &local = owner->used_[kind];
    auto &global = all.used[kind];
    --local.records;
    local.bytes -= charge;
    local.wire -= wire;
    --global.records;
    global.bytes -= charge;
    global.wire -= wire;
  }
};
std::shared_ptr<void> RuntimeResources::reserve(RuntimeResource kind, size_t size, size_t wire) {
  const auto category = static_cast<size_t>(kind);
  if (category >= count)
    throw Error("INVALID_REQUEST", "Unknown runtime resource category");
  return std::make_shared<Lease>(shared_from_this(), category, size, wire);
}
Json RuntimeResources::usage() {
  auto &all = totals();
  std::lock_guard<std::mutex> lock(all.mutex);
  Json result = Json::object();
  for (size_t n = 0; n < count; ++n)
    result[names[n]] = {{"records", all.used[n].records},
                        {"bytes", all.used[n].bytes},
                        {"wireBytes", all.used[n].wire}};
  return result;
}
} // namespace coc
