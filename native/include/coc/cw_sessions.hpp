#pragma once
#include "coc/common.hpp"

namespace coc {
inline bool cw_session_expired(const Json &session, int64_t detached_ms) {
  if (session.value("autoApproval", false))
    return false;
  const auto timeout =
      session.value("mode", "") == "web" && !session.value("cwAccountId", "").empty() ? 3600000
                                                                                      : 1800000;
  return detached_ms >= timeout;
}
} // namespace coc
