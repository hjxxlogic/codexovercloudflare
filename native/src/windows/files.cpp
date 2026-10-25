#include "coc/files.hpp"
#include "coc/store.hpp"
#include "coc/windows.hpp"
#include <aclapi.h>
#include <algorithm>
#include <cctype>
#include <iomanip>
#include <openssl/evp.h>
#include <sstream>
#include <winternl.h>
namespace coc {
namespace {
constexpr int64_t file_limit = 20 * 1024 * 1024, chunk_limit = 64 * 1024;
[[noreturn]] void failed() {
  auto code = GetLastError();
  if (code == ERROR_FILE_EXISTS || code == ERROR_ALREADY_EXISTS)
    throw Error("FILE_EXISTS", "File already exists; explicitly allow overwrite");
  if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND)
    throw Error("FILE_NOT_FOUND", "File or directory not found");
  if (code == ERROR_ACCESS_DENIED || code == ERROR_SHARING_VIOLATION)
    throw Error("FORBIDDEN",
                "Workspace path is inaccessible or in use (Windows " + std::to_string(code) + ")");
  throw Error("FILE_IO",
              "Windows workspace file operation failed (Windows " + std::to_string(code) + ")");
}
// Win32 SetFileInformationByHandle rejects a non-null RootDirectory on older
// supported Windows versions. The NT interface accepts the held directory and
// a single validated filename without reopening the directory by path.
void rename_relative(HANDLE file, FILE_RENAME_INFO *rename, DWORD size) {
  using Rename = NTSTATUS(NTAPI *)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
  using ToError = ULONG(NTAPI *)(NTSTATUS);
  auto module = GetModuleHandleW(L"ntdll.dll");
  static auto set_information =
      reinterpret_cast<Rename>(GetProcAddress(module, "NtSetInformationFile"));
  static auto to_error = reinterpret_cast<ToError>(GetProcAddress(module, "RtlNtStatusToDosError"));
  if (!set_information || !to_error)
    throw Error("FILE_IO", "Windows relative rename is unavailable");
  IO_STATUS_BLOCK result{};
  const auto status =
      set_information(file, &result, rename, size, static_cast<FILE_INFORMATION_CLASS>(10));
  if (status < 0) {
    SetLastError(to_error(status));
    failed();
  }
}
std::vector<std::string> components(const std::string &path) {
  if (path.size() > 4096 || path.find('\0') != std::string::npos ||
      path.find_first_of("\\:") != std::string::npos || (!path.empty() && path.front() == '/'))
    throw Error("INVALID_PATH", "Use a forward-slash path relative to the project");
  std::vector<std::string> parts;
  std::istringstream input(path);
  std::string part;
  while (std::getline(input, part, '/')) {
    if (part.empty() || part == "." || part == ".." || part.size() > 255 || part.back() == '.' ||
        part.back() == ' ' || part.find_first_of("<>\"|?*") != std::string::npos ||
        _strnicmp(part.c_str(), ".coc-upload-", 12) == 0 ||
        std::any_of(part.begin(), part.end(), [](unsigned char c) { return c < 32; }))
      throw Error("INVALID_PATH", "Invalid Windows workspace path component");
    auto name = part.substr(0, part.find('.'));
    while (!name.empty() && name.back() == ' ')
      name.pop_back();
    std::transform(name.begin(), name.end(), name.begin(),
                   [](unsigned char c) { return char(std::toupper(c)); });
    if (name == "CON" || name == "PRN" || name == "AUX" || name == "NUL" || name == "CONIN$" ||
        name == "CONOUT$" ||
        (name.size() == 4 && (name.substr(0, 3) == "COM" || name.substr(0, 3) == "LPT") &&
         name[3] >= '0' && name[3] <= '9') ||
        ((name.rfind("COM", 0) == 0 || name.rfind("LPT", 0) == 0) &&
         (name.substr(3) == "\xc2\xb9" || name.substr(3) == "\xc2\xb2" ||
          name.substr(3) == "\xc2\xb3")))
      throw Error("INVALID_PATH", "Windows device names are forbidden");
    parts.push_back(part);
  }
  if (!path.empty() && path.back() == '/')
    throw Error("INVALID_PATH", "Remove trailing slash");
  return parts;
}
BY_HANDLE_FILE_INFORMATION information(HANDLE file) {
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(file, &info))
    failed();
  if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    throw Error("FORBIDDEN", "Symbolic links and junctions are forbidden");
  return info;
}
uint64_t size_of(const BY_HANDLE_FILE_INFORMATION &info) {
  return (uint64_t(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
}
std::string version(HANDLE file) {
  auto info = information(file);
  FILE_BASIC_INFO basic{};
  if (!GetFileInformationByHandleEx(file, FileBasicInfo, &basic, sizeof(basic)))
    failed();
  return std::to_string(info.dwVolumeSerialNumber) + ":" + std::to_string(info.nFileIndexHigh) +
         ":" + std::to_string(info.nFileIndexLow) + ":" + std::to_string(size_of(info)) + ":" +
         std::to_string(basic.LastWriteTime.QuadPart) + ":" +
         std::to_string(basic.ChangeTime.QuadPart);
}
// Inspect canonical ancestors and lock project directories against writes and
// moves for the entire operation or upload. System ancestors remain shareable.
struct Directory {
  std::filesystem::path path;
  std::vector<WinHandle> ancestors;
  Directory(const std::string &root, const std::vector<std::string> &parts, size_t count) {
    auto absolute = std::filesystem::absolute(std::filesystem::u8path(root)).lexically_normal();
    if (!absolute.has_root_name() || absolute.root_name().wstring().size() != 2)
      throw Error("FORBIDDEN", "Windows workspace requires a local drive");
    path = absolute.root_path();
    auto hold = [&](bool project_directory) {
      auto access = FILE_READ_ATTRIBUTES | (project_directory ? FILE_LIST_DIRECTORY : 0);
      auto share = project_directory ? FILE_SHARE_READ
                                     : FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
      WinHandle handle(CreateFileW(path.c_str(), access, share, nullptr, OPEN_EXISTING,
                                   FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                                   nullptr));
      if (!handle)
        failed();
      if (!(information(handle.get()).dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
        throw Error("FORBIDDEN", "Expected directory");
      ancestors.push_back(std::move(handle));
    };
    hold(path == absolute);
    for (auto &part : absolute.relative_path()) {
      path /= part;
      hold(path == absolute);
    }
    for (size_t i = 0; i < count; ++i) {
      path /= wide(parts[i]);
      hold(true);
    }
  }
};
WinHandle open_file(const std::filesystem::path &path, DWORD access, DWORD creation = OPEN_EXISTING,
                    DWORD share = FILE_SHARE_READ) {
  WinHandle file(CreateFileW(path.c_str(), access, share, nullptr, creation,
                             FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file)
    failed();
  if (information(file.get()).dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
    throw Error("FORBIDDEN", "Expected a regular file");
  if (GetFileType(file.get()) != FILE_TYPE_DISK)
    throw Error("FORBIDDEN", "Expected a disk file");
  return file;
}
int64_t read_at(HANDLE file, char *buffer, size_t length, int64_t offset) {
  LARGE_INTEGER position;
  position.QuadPart = offset;
  DWORD count = 0;
  if (!SetFilePointerEx(file, position, nullptr, FILE_BEGIN) ||
      !ReadFile(file, buffer, DWORD(length), &count, nullptr))
    failed();
  return count;
}
void write_at(HANDLE file, const std::string &bytes, int64_t offset) {
  LARGE_INTEGER position;
  position.QuadPart = offset;
  DWORD count = 0;
  if (!SetFilePointerEx(file, position, nullptr, FILE_BEGIN) ||
      !WriteFile(file, bytes.data(), DWORD(bytes.size()), &count, nullptr) || count != bytes.size())
    failed();
}
std::string encode(const std::string &bytes) {
  if (bytes.empty())
    return "";
  std::string output(4 * ((bytes.size() + 2) / 3), '\0');
  EVP_EncodeBlock(reinterpret_cast<unsigned char *>(output.data()),
                  reinterpret_cast<const unsigned char *>(bytes.data()), int(bytes.size()));
  return output;
}
std::string decode(const std::string &text) {
  if (text.empty())
    return "";
  if (text.size() > 4 * ((chunk_limit + 2) / 3) || text.size() % 4)
    throw Error("INVALID_REQUEST", "Invalid file chunk");
  std::string bytes(text.size() / 4 * 3, '\0');
  int count =
      EVP_DecodeBlock(reinterpret_cast<unsigned char *>(bytes.data()),
                      reinterpret_cast<const unsigned char *>(text.data()), int(text.size()));
  if (count < 0)
    throw Error("INVALID_REQUEST", "Invalid base64");
  if (text.back() == '=')
    --count;
  if (text.size() > 1 && text[text.size() - 2] == '=')
    --count;
  if (count < 0 || count > chunk_limit)
    throw Error("INVALID_REQUEST", "Invalid file chunk");
  bytes.resize(count);
  if (encode(bytes) != text)
    throw Error("INVALID_REQUEST", "Noncanonical base64");
  return bytes;
}
} // namespace
struct WorkspaceFiles::Upload {
  std::unique_ptr<Directory> parent;
  WinHandle file, previous_file;
  std::filesystem::path temporary, target;
  std::string root, owner, previous;
  int64_t size = 0, offset = 0, touched = now();
  bool published = false;
  std::map<int64_t, std::string> pending;
  ~Upload() {
    file.reset();
    if (!temporary.empty())
      DeleteFileW(temporary.c_str());
  }
};
WorkspaceFiles::WorkspaceFiles(Store *store) : store_(store) {}
WorkspaceFiles::~WorkspaceFiles() = default;
void WorkspaceFiles::clear() { uploads_.clear(); }
void WorkspaceFiles::cleanup() {
  for (auto it = completed_.begin(); it != completed_.end();) {
    if (now() - it->second.value("completedAt", int64_t(0)) > 86400000)
      it = completed_.erase(it);
    else
      ++it;
  }
  for (auto it = uploads_.begin(); it != uploads_.end();) {
    if (now() - it->second->touched > 600000)
      it = uploads_.erase(it);
    else
      ++it;
  }
}
Json WorkspaceFiles::request(const std::string &root, const std::string &sandbox,
                             const std::string &owner, const Json &d) {
  cleanup();
  auto operation = d.at("operation").get<std::string>();
  if (operation == "list") {
    auto parts = components(d.value("path", ""));
    Directory directory(root, parts, parts.size());
    std::map<std::string, Json> page;
    auto after = d.value("after", "");
    for (auto &entry : std::filesystem::directory_iterator(directory.path)) {
      auto name = entry.path().filename().u8string();
      if (name <= after || name.rfind(".coc-upload-", 0) == 0)
        continue;
      auto attributes = GetFileAttributesW(entry.path().c_str());
      if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
        continue;
      bool dir = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      std::error_code ec;
      auto size = dir ? 0 : entry.file_size(ec);
      if (ec)
        continue;
      page[name] = {{"name", name}, {"directory", dir}, {"size", size}};
      if (page.size() > 101)
        page.erase(std::prev(page.end()));
    }
    bool more = page.size() > 100;
    if (more)
      page.erase(std::prev(page.end()));
    Json data = Json::array();
    for (auto &[name, entry] : page)
      data.push_back(entry);
    return {{"entries", data},
            {"next", more ? Json(page.rbegin()->first) : Json()},
            {"writable", sandbox == "workspace-write"},
            {"maxSize", file_limit}};
  }
  if (operation == "read") {
    auto parts = components(d.at("path"));
    if (parts.empty())
      throw Error("INVALID_PATH", "Select a file");
    Directory parent(root, parts, parts.size() - 1);
    auto file = open_file(parent.path / wide(parts.back()), GENERIC_READ);
    auto size = size_of(information(file.get()));
    if (size > file_limit)
      throw Error("FILE_TOO_LARGE", "File exceeds 20 MiB");
    auto offset = d.value("offset", int64_t(0));
    if (offset < 0 || uint64_t(offset) > size)
      throw Error("INVALID_REQUEST", "Invalid download offset");
    auto stamp = version(file.get());
    if (d.contains("version") && d["version"] != stamp)
      throw Error("FILE_CHANGED", "File changed; restart download");
    std::string bytes(std::min<int64_t>(chunk_limit, size - offset), '\0');
    if (!bytes.empty())
      bytes.resize(read_at(file.get(), bytes.data(), bytes.size(), offset));
    if (version(file.get()) != stamp || (bytes.empty() && uint64_t(offset) < size))
      throw Error("FILE_CHANGED", "File changed; restart download");
    return {{"data", encode(bytes)},
            {"size", size},
            {"offset", offset + bytes.size()},
            {"version", stamp}};
  }
  if (operation == "status" || operation == "finish") {
    const auto key = "upload:" + owner + ":" + root + ":" + d.at("uploadId").get<std::string>();
    Json completed;
    if (store_)
      completed = store_->cache_get(key);
    else if (completed_.count(key))
      completed = completed_.at(key);
    if (!completed.is_null() && now() - completed.value("completedAt", int64_t(0)) <= 86400000)
      return completed;
    if (operation == "status") {
      auto it = uploads_.find(d.at("uploadId"));
      if (it == uploads_.end() || it->second->root != root || it->second->owner != owner)
        return {{"state", "not_found"}};
      return {{"state", it->second->published ? "unknown" : "uploading"},
              {"offset", it->second->offset}};
    }
  }
  if (sandbox != "workspace-write")
    throw Error("FORBIDDEN", "Uploads are disabled by the Agent read-only policy");
  auto id = d.at("uploadId").get<std::string>();
  if (!valid_id(id))
    throw Error("INVALID_REQUEST", "Invalid upload identifier");
  if (operation == "begin") {
    const auto completed_key = "upload:" + owner + ":" + root + ":" + id;
    Json completed;
    if (store_)
      completed = store_->cache_get(completed_key);
    else if (completed_.count(completed_key))
      completed = completed_.at(completed_key);
    if (!completed.is_null() && now() - completed.value("completedAt", int64_t(0)) <= 86400000)
      throw Error("UPLOAD_EXISTS", "Upload identifier already completed; use a new identifier");
    if (uploads_.count(id))
      throw Error("UPLOAD_EXISTS", "Upload already exists");
    if (uploads_.size() >= 4)
      throw Error("CAPACITY", "At most four concurrent file uploads");
    auto parts = components(d.at("path"));
    auto size = d.value("size", int64_t(-1));
    if (parts.empty() || size < 0 || size > file_limit)
      throw Error("INVALID_REQUEST", "Select a file up to 20 MiB");
    auto upload = std::make_unique<Upload>();
    upload->parent = std::make_unique<Directory>(root, parts, parts.size() - 1);
    upload->target = upload->parent->path / wide(parts.back());
    upload->root = root;
    upload->owner = owner;
    upload->size = size;
    auto attributes = GetFileAttributesW(upload->target.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES) {
      if (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
        throw Error("FORBIDDEN", "Upload target must be a regular file");
      if (!d.value("overwrite", false))
        throw Error("FILE_EXISTS", "Explicitly allow overwrite");
      // Keep the target stable until publication. Delete sharing permits atomic replacement.
      upload->previous_file = open_file(upload->target, GENERIC_READ, OPEN_EXISTING,
                                        FILE_SHARE_READ | FILE_SHARE_DELETE);
      upload->previous = version(upload->previous_file.get());
    } else if (GetLastError() != ERROR_FILE_NOT_FOUND)
      failed();
    upload->temporary = upload->parent->path / wide(".coc-upload-" + uuid());
    upload->file = WinHandle(private_file(upload->temporary, GENERIC_READ | GENERIC_WRITE | DELETE,
                                          FILE_SHARE_READ | FILE_SHARE_DELETE, CREATE_NEW));
    if (!upload->file)
      failed();
    uploads_[id] = std::move(upload);
    return {{"offset", 0}, {"window", 4}};
  }
  auto it = uploads_.find(id);
  if (it == uploads_.end() || it->second->root != root || it->second->owner != owner)
    throw Error("UPLOAD_NOT_FOUND", "Upload is missing, expired or belongs to another credential");
  auto &upload = *it->second;
  upload.touched = now();
  if (operation == "cancel") {
    uploads_.erase(it);
    return {{"ok", true}};
  }
  if (operation == "chunk") {
    auto bytes = decode(d.at("data"));
    auto offset = d.value("offset", int64_t(-1));
    if (offset < 0 || offset + int64_t(bytes.size()) > upload.size)
      throw Error("INVALID_REQUEST", "Invalid upload chunk offset");
    if (offset < upload.offset && offset + int64_t(bytes.size()) <= upload.offset) {
      std::string prior(bytes.size(), '\0');
      if (read_at(upload.file.get(), prior.data(), prior.size(), offset) != int64_t(prior.size()) ||
          prior != bytes)
        throw Error("UPLOAD_CONFLICT", "Upload retry does not match stored bytes");
      return {{"offset", upload.offset}};
    }
    if (offset < upload.offset || (bytes.empty() && upload.size > 0))
      throw Error("UPLOAD_CONFLICT", "Upload overlaps committed bytes");
    if (offset > upload.offset + 4 * chunk_limit)
      throw Error("BACKPRESSURE", "Upload exceeds the four-chunk reorder window");
    const auto duplicate = upload.pending.find(offset);
    if (duplicate != upload.pending.end()) {
      if (duplicate->second != bytes)
        throw Error("UPLOAD_CONFLICT", "Upload retry does not match pending bytes");
      return {{"offset", upload.offset}};
    }
    for (const auto &[start, value] : upload.pending)
      if (offset < start + int64_t(value.size()) && start < offset + int64_t(bytes.size()))
        throw Error("UPLOAD_CONFLICT", "Upload chunks overlap");
    if (upload.pending.size() >= 4)
      throw Error("BACKPRESSURE", "Upload reorder buffer full");
    upload.pending.emplace(offset, std::move(bytes));
    while (!upload.pending.empty() && upload.pending.begin()->first == upload.offset) {
      const auto &next = upload.pending.begin()->second;
      write_at(upload.file.get(), next, upload.offset);
      upload.offset += next.size();
      upload.pending.erase(upload.pending.begin());
    }
    return {{"offset", upload.offset}};
  }
  if (operation != "finish")
    throw Error("INVALID_REQUEST", "Unknown file operation");
  if (upload.offset != upload.size)
    throw Error("UPLOAD_INCOMPLETE", "All file bytes must arrive before publishing");
  if (!FlushFileBuffers(upload.file.get()))
    failed();
  if (!upload.published) {
    if (!upload.previous.empty()) {
      auto current = open_file(upload.target, GENERIC_READ, OPEN_EXISTING,
                               FILE_SHARE_READ | FILE_SHARE_DELETE);
      if (version(current.get()) != upload.previous)
        throw Error("FILE_CHANGED", "Upload target changed; review before overwriting");
      PSECURITY_DESCRIPTOR descriptor = nullptr;
      PACL acl = nullptr;
      if (GetSecurityInfo(current.get(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr,
                          nullptr, &acl, nullptr, &descriptor) != ERROR_SUCCESS)
        throw Error("FILE_IO", "Cannot preserve upload target permissions");
      SECURITY_DESCRIPTOR_CONTROL control = 0;
      DWORD revision = 0;
      bool inspected = GetSecurityDescriptorControl(descriptor, &control, &revision) != FALSE;
      auto result = inspected ? SetSecurityInfo(upload.file.get(), SE_FILE_OBJECT,
                                                DACL_SECURITY_INFORMATION |
                                                    ((control & SE_DACL_PROTECTED)
                                                         ? PROTECTED_DACL_SECURITY_INFORMATION
                                                         : UNPROTECTED_DACL_SECURITY_INFORMATION),
                                                nullptr, nullptr, acl, nullptr)
                              : ERROR_INVALID_SECURITY_DESCR;
      LocalFree(descriptor);
      if (result != ERROR_SUCCESS)
        throw Error("FILE_IO", "Cannot preserve upload target permissions");
    }
    // Rename the open staging handle; no shell, path traversal or partial target.
    auto target = upload.target.filename().wstring();
    std::vector<unsigned char> storage(sizeof(FILE_RENAME_INFO) + target.size() * sizeof(wchar_t));
    auto rename = reinterpret_cast<FILE_RENAME_INFO *>(storage.data());
    rename->ReplaceIfExists = !upload.previous.empty();
    rename->RootDirectory = upload.parent->ancestors.back().get();
    rename->FileNameLength = DWORD(target.size() * sizeof(wchar_t));
    std::copy(target.begin(), target.end(), rename->FileName);
    rename_relative(upload.file.get(), rename, DWORD(storage.size()));
    upload.published = true;
  }
  EVP_MD_CTX *raw = EVP_MD_CTX_new();
  if (!raw)
    throw Error("RESULT_UNKNOWN", "Cannot calculate upload checksum");
  std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> hash(raw, EVP_MD_CTX_free);
  EVP_DigestInit_ex(raw, EVP_sha256(), nullptr);
  char buffer[65536];
  for (int64_t offset = 0; offset < upload.size;) {
    auto count = read_at(upload.file.get(), buffer, sizeof(buffer), offset);
    if (count <= 0)
      throw Error("RESULT_UNKNOWN", "Cannot verify published file");
    EVP_DigestUpdate(raw, buffer, count);
    offset += count;
  }
  unsigned char digest[EVP_MAX_MD_SIZE];
  unsigned length = 0;
  EVP_DigestFinal_ex(raw, digest, &length);
  std::ostringstream checksum;
  for (unsigned i = 0; i < length; ++i)
    checksum << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(digest[i]);
  Json result = {{"ok", true},
                 {"state", "completed"},
                 {"size", upload.size},
                 {"sha256", checksum.str()},
                 {"completedAt", now()}};
  const auto key = "upload:" + owner + ":" + root + ":" + id;
  if (store_)
    store_->cache_put(key, result);
  else
    completed_[key] = result;
  uploads_.erase(it);
  return result;
}
} // namespace coc
