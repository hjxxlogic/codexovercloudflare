#include "coc/delivery.hpp"
#include "coc/external.hpp"
#include <cstdlib>
#ifdef _WIN32
#include "coc/windows.hpp"
#include <sddl.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif
namespace coc {
namespace {
[[noreturn]] void unavailable() {
  throw Error("CONTENT_UNAVAILABLE", "History source file identity is unavailable");
}
#ifdef _WIN32
Json identity(HANDLE handle, bool directory) {
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle, &info) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory)
    unavailable();
  return {{"volume", info.dwVolumeSerialNumber},
          {"indexHigh", info.nFileIndexHigh},
          {"indexLow", info.nFileIndexLow},
          {"createdHigh", info.ftCreationTime.dwHighDateTime},
          {"createdLow", info.ftCreationTime.dwLowDateTime}};
}
std::string subject() {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw))
    unavailable();
  WinHandle token(raw);
  DWORD size = 0;
  GetTokenInformation(raw, TokenUser, nullptr, 0, &size);
  if (!size || size > 65536)
    unavailable();
  std::vector<unsigned char> buffer(size);
  if (!GetTokenInformation(raw, TokenUser, buffer.data(), size, &size))
    unavailable();
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER *>(buffer.data())->User.Sid, &sid))
    unavailable();
  const std::wstring value(sid);
  LocalFree(sid);
  return utf8(value);
}
#else
struct Descriptor {
  int value = -1;
  explicit Descriptor(int fd) : value(fd) {
    if (fd < 0)
      unavailable();
  }
  ~Descriptor() {
    if (value >= 0)
      ::close(value);
  }
  Descriptor(const Descriptor &) = delete;
  Descriptor &operator=(const Descriptor &) = delete;
};
Json identity(int fd, bool directory) {
  struct stat info {};
  if (fstat(fd, &info) != 0 || (directory ? !S_ISDIR(info.st_mode) : !S_ISREG(info.st_mode)))
    unavailable();
  return {{"device", info.st_dev}, {"inode", info.st_ino}, {"owner", info.st_uid}};
}
#endif
} // namespace
std::filesystem::path history_source_home(const std::string &cwd) {
  std::filesystem::path root;
#ifdef _WIN32
  if (auto explicit_home = _wgetenv(L"CODEX_HOME"); explicit_home && *explicit_home)
    root = explicit_home;
  else if (auto home = _wgetenv(L"USERPROFILE"); home && *home)
    root = std::filesystem::path(home) / ".codex";
  else
    unavailable();
#else
  if (auto explicit_home = std::getenv("CODEX_HOME"); explicit_home && *explicit_home)
    root = std::filesystem::u8path(explicit_home);
  else if (auto home = std::getenv("HOME"); home && *home)
    root = std::filesystem::u8path(home) / ".codex";
  else
    unavailable();
#endif
  if (root.is_relative())
    root = std::filesystem::u8path(cwd) / root;
  std::error_code error;
  root = std::filesystem::canonical(root, error);
  if (error)
    unavailable();
  return root;
}
Json history_source_origin(const Json &thread, const std::filesystem::path &home,
                           const std::string &cwd) {
  if (!thread.is_object() || !thread.contains("id") || !thread.at("id").is_string() ||
      !thread.contains("createdAt") || !thread.at("createdAt").is_number_integer() ||
      thread.at("createdAt") < 0 || thread.at("createdAt") > 9007199254740991LL ||
      !thread.contains("path") || !thread.at("path").is_string())
    unavailable();
  if (!thread.contains("cwd") || !thread.at("cwd").is_string() ||
      !same_project_path(thread.at("cwd"), cwd))
    throw Error("FORBIDDEN", "History source belongs to another project");
  const auto path = thread.at("path").get<std::string>();
  const auto id = thread.at("id").get<std::string>();
  if (id.empty() || id.size() > 256 || path.empty() || path.size() > 4096 ||
      path.find('\0') != std::string::npos || home.empty())
    unavailable();
  std::error_code error;
  const auto root = std::filesystem::canonical(home, error);
  if (error)
    unavailable();
  const auto file = std::filesystem::canonical(std::filesystem::u8path(path), error);
  if (error)
    unavailable();
  const auto relative = file.lexically_relative(root);
  if (relative.empty() || relative.is_absolute())
    unavailable();
  std::vector<std::filesystem::path> parts;
  for (const auto &part : relative) {
    if (part.empty() || part == "." || part == "..")
      throw Error("FORBIDDEN", "History source is outside the configured Codex home");
    parts.push_back(part);
  }
  Json evidence = {{"format", 1},
                   {"home", root.u8string()},
                   {"thread", id},
                   {"createdAt", thread.at("createdAt")}};
#ifdef _WIN32
  const auto sharing = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  WinHandle directory(CreateFileW(
      root.c_str(), FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY, sharing, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!directory)
    unavailable();
  evidence["root"] = identity(directory.get(), true);
  evidence["subject"] = subject();
  for (size_t n = 0; n < parts.size(); ++n) {
    const bool folder = n + 1 < parts.size();
    WinHandle next(relative_file(directory.get(), parts[n].wstring(),
                                 FILE_READ_ATTRIBUTES | (folder ? FILE_LIST_DIRECTORY : 0), sharing,
                                 OPEN_EXISTING, folder));
    if (!next)
      unavailable();
    const auto info = identity(next.get(), folder);
    if (!folder)
      evidence["file"] = info;
    directory = std::move(next);
  }
#else
  Descriptor root_fd(open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  evidence["root"] = identity(root_fd.value, true);
  evidence["subject"] = geteuid();
  Descriptor directory(dup(root_fd.value));
  for (size_t n = 0; n < parts.size(); ++n) {
    const bool folder = n + 1 < parts.size();
    Descriptor next(
        openat(directory.value, parts[n].c_str(),
               O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC | (folder ? O_DIRECTORY : 0)));
    const auto info = identity(next.value, folder);
    if (!folder)
      evidence["file"] = info;
    ::close(directory.value);
    directory.value = next.value;
    next.value = -1;
  }
#endif
  const auto project = std::filesystem::canonical(std::filesystem::u8path(cwd), error);
  if (error)
    unavailable();
  return {{"environment", delivery_digest(evidence.dump())}, {"projectPath", project.u8string()}};
}
} // namespace coc
