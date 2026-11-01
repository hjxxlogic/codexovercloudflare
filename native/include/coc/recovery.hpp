#pragma once
#include <algorithm>
#include <random>
#include <string_view>
namespace coc {
// Scheduling is volatile; durable work and authorization decide whether to retry.
inline unsigned recovery_delay(unsigned attempt, unsigned fast_attempts, unsigned jitter_ms) {
  return attempt < fast_attempts ? std::min(10000U, 1000U << std::min(attempt, 4U))
                                 : 30000U + std::min(jitter_ms, 30000U);
}
inline unsigned recovery_delay(unsigned attempt, unsigned fast_attempts = 3) {
  if (attempt < fast_attempts)
    return recovery_delay(attempt, fast_attempts, 0);
  static thread_local std::mt19937 random(std::random_device{}());
  return recovery_delay(attempt, fast_attempts,
                        std::uniform_int_distribution<unsigned>(0, 30000)(random));
}
inline bool retry_original_operation(std::string_view code) {
  return code == "HTTP_TIMEOUT" || code == "HTTP_NETWORK" || code == "RESULT_UNKNOWN" ||
         code == "RESULT_PENDING" || code == "HOST_OFFLINE" || code == "AGENT_NEGOTIATING" ||
         code == "BACKPRESSURE";
}
} // namespace coc
