#pragma once
#ifdef _WIN32
#include "common.hpp"
#include <boost/asio.hpp>
#include <vector>
#include <windows.h>
namespace coc {
std::wstring wide(const std::string &text);
std::string utf8(const std::wstring &text);
class WinHandle {
  HANDLE value_ = INVALID_HANDLE_VALUE;

public:
  WinHandle() = default;
  explicit WinHandle(HANDLE value) : value_(value) {}
  ~WinHandle() { reset(); }
  WinHandle(const WinHandle &) = delete;
  WinHandle &operator=(const WinHandle &) = delete;
  WinHandle(WinHandle &&other) noexcept : value_(other.release()) {}
  WinHandle &operator=(WinHandle &&other) noexcept {
    reset(other.release());
    return *this;
  }
  HANDLE get() const { return value_; }
  HANDLE release() {
    auto value = value_;
    value_ = INVALID_HANDLE_VALUE;
    return value;
  }
  explicit operator bool() const { return value_ != INVALID_HANDLE_VALUE && value_ != nullptr; }
  void reset(HANDLE value = INVALID_HANDLE_VALUE) {
    if (*this)
      CloseHandle(value_);
    value_ = value;
  }
};
// Protected DACL: only this user and SYSTEM; no inherited broad permissions.
void private_path(const std::filesystem::path &path);
HANDLE private_file(const std::filesystem::path &path, DWORD access, DWORD sharing, DWORD creation);
HANDLE relative_file(HANDLE parent, const std::wstring &name, DWORD access, DWORD sharing,
                     DWORD creation, bool folder = false, bool private_acl = false);
std::string codex_executable();
std::wstring quote_windows_argument(const std::wstring &value);
class WindowsChild {
  WinHandle process_, job_;

public:
  WinHandle input, output;
  WindowsChild(const std::vector<std::string> &args, const std::string &cwd = "",
               bool redirected = true, const std::string &ticket = "",
               const Json &environment = Json::object());
  bool poll(DWORD &code) const;
  void terminate();
};
std::string windows_capture(const std::vector<std::string> &args, size_t limit = 4096,
                            const Json &environment = Json::object());
void windows_console();
} // namespace coc
#endif
