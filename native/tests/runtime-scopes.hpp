#pragma once
#include "coc/approvals.hpp"
#include "coc/credit.hpp"
#include <condition_variable>
#include <mutex>
#include <thread>
inline void runtime_scope_contract() {
  using namespace coc;
  using Kind = RuntimeResource;
  const auto rejected = [](auto fn) {
    try {
      fn();
    } catch (const Error &error) {
      if (error.code == "BACKPRESSURE")
        return;
      throw;
    }
    throw std::runtime_error("Expected runtime scope backpressure");
  };
  const auto empty = [] {
    const auto usage = RuntimeResources::usage();
    for (const auto &entry : usage.items())
      if (entry.value().at("records") != 0 || entry.value().at("bytes") != 0 ||
          entry.value().at("wireBytes") != 0)
        throw std::runtime_error("Runtime reservation leaked");
  };
  auto scope = std::make_shared<RuntimeResources>();
  const Json approval = {{"id", 0},
                         {"method", "item/commandExecution/requestApproval"},
                         {"params", {{"command", "echo bounded"}}}};
  auto original = reserve_approval(scope, approval, true);
  auto mirror = original;
  scope.reset(); // Removing the runtime cannot release its retained mirror.
  original.reset();
  if (RuntimeResources::usage().at("approvals").at("records") != 1)
    throw std::runtime_error("A closing runtime released its outstanding approval");
  mirror.reset();
  empty();
  scope = std::make_shared<RuntimeResources>();
  auto full = scope->reserve(Kind::command, credit::runtime_command_bytes);
  rejected([&] { scope->reserve(Kind::command, 1); });
  auto priority = scope->reserve(Kind::priority, 16384);
  auto decision = reserve_approval(scope, approval);
  if (RuntimeResources::usage().at("commands").at("records") != 1)
    throw std::runtime_error("Priority borrowed or released normal command capacity");
  full.reset();
  priority.reset();
  decision.reset();
  rejected(
      [&] { reserve_approval(scope, {{"id", "large"}, {"params", std::string(40000, '\\')}}); });
  empty();
  // Aggregate byte exhaustion: all scopes remain below their record caps.
  std::vector<std::shared_ptr<void>> retained;
  for (int n = 0; n < 8; ++n) {
    auto owner = std::make_shared<RuntimeResources>();
    retained.push_back(owner->reserve(Kind::command, credit::runtime_command_bytes));
  }
  rejected([&] { scope->reserve(Kind::command, 1); });
  priority = scope->reserve(Kind::priority, 16384);
  retained.clear();
  priority.reset();
  empty();
  // Independent threads race the actual shared quota. Retain every lease until
  // the main thread has observed the aggregate bound, then release together.
  std::mutex mutex;
  std::condition_variable changed;
  int ready = 0;
  bool release = false;
  std::vector<std::thread> workers;
  for (int n = 0; n < 8; ++n)
    workers.emplace_back([&] {
      auto owner = std::make_shared<RuntimeResources>();
      std::vector<std::shared_ptr<void>> held;
      for (int k = 0; k < credit::runtime_approvals; ++k) {
        try {
          held.push_back(reserve_approval(owner, approval));
        } catch (const Error &error) {
          if (error.code != "BACKPRESSURE")
            throw;
          break;
        }
      }
      std::unique_lock<std::mutex> lock(mutex);
      ++ready;
      changed.notify_all();
      changed.wait(lock, [&] { return release; });
    });
  bool full_count = false, refused = false;
  {
    std::unique_lock<std::mutex> lock(mutex);
    changed.wait(lock, [&] { return ready == 8; });
    full_count =
        RuntimeResources::usage().at("approvals").at("records") == credit::runtime_approval_global;
    try {
      reserve_approval(scope, approval);
    } catch (const Error &error) {
      refused = error.code == "BACKPRESSURE";
    }
    release = true;
    changed.notify_all();
  }
  for (auto &worker : workers)
    worker.join();
  if (!full_count || !refused)
    throw std::runtime_error("Concurrent admission did not enforce the actual global quota");
  empty();
}
