#include "coc/common.hpp"
#include <cstddef>
#include <cstdint>
extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  if (size > coc::max_frame)
    return 0;
  try {
    auto message = coc::Json::parse(data, data + size);
    try {
      coc::web_command(message);
    } catch (const std::exception &) {
    }
    try {
      coc::guard_cli(message, "/workspace", "read-only", "thread");
    } catch (const std::exception &) {
    }
  } catch (const std::exception &) {
  }
  return 0;
}
