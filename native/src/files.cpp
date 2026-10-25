#include "coc/files.hpp"
#include "coc/store.hpp"
#include <algorithm>
#include <cerrno>
#include <dirent.h>
#include <fcntl.h>
#include <iomanip>
#include <openssl/evp.h>
#include <sstream>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>
namespace coc {
namespace {
constexpr int64_t file_limit = 20 * 1024 * 1024, chunk_limit = 64 * 1024;
struct Fd {
  int value;
  explicit Fd(int v) : value(v) {}
  ~Fd() {
    if (value >= 0)
      ::close(value);
  }
  Fd(const Fd &) = delete;
  Fd &operator=(const Fd &) = delete;
};
[[noreturn]] void failed() {
  if (errno == EEXIST)
    throw Error("FILE_EXISTS",
                "File already exists; explicitly allow overwrite or choose a new name");
  if (errno == ENOENT)
    throw Error("FILE_NOT_FOUND", "File or directory not found");
  if (errno == ELOOP || errno == ENOTDIR || errno == EACCES || errno == EPERM)
    throw Error("FORBIDDEN", "Path is inaccessible or contains a symbolic link");
  throw Error("FILE_IO", "Workspace file operation failed");
}
std::vector<std::string> components(const std::string &path) {
  if (path.size() > 4096 || path.find('\0') != std::string::npos ||
      (!path.empty() && path[0] == '/'))
    throw Error("INVALID_PATH", "Use a path relative to the project");
  std::vector<std::string> parts;
  size_t start = 0;
  while (start < path.size()) {
    auto end = path.find('/', start);
    auto part = path.substr(start, end == std::string::npos ? end : end - start);
    if (part.empty() || part == "." || part == ".." || part.size() > 255 ||
        part.rfind(".coc-upload-", 0) == 0)
      throw Error("INVALID_PATH", "Invalid workspace path component");
    parts.push_back(part);
    if (end == std::string::npos)
      break;
    start = end + 1;
    if (start == path.size())
      throw Error("INVALID_PATH", "Remove the trailing slash");
  }
  return parts;
}
int directory(const std::string &root, const std::vector<std::string> &parts, size_t count) {
  int fd = open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0)
    failed();
  for (size_t i = 0; i < count; ++i) {
    auto next = openat(fd, parts[i].c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    ::close(fd);
    if (next < 0)
      failed();
    fd = next;
  }
  return fd;
}
std::string version(const struct stat &s) {
  return std::to_string(s.st_dev) + ":" + std::to_string(s.st_ino) + ":" +
         std::to_string(s.st_size) + ":" + std::to_string(s.st_mtim.tv_sec) + ":" +
         std::to_string(s.st_mtim.tv_nsec) + ":" + std::to_string(s.st_ctim.tv_sec) + ":" +
         std::to_string(s.st_ctim.tv_nsec);
}
std::string encode(const std::string &bytes) {
  if (bytes.empty())
    return "";
  std::string output(4 * ((bytes.size() + 2) / 3), '\0');
  EVP_EncodeBlock(reinterpret_cast<unsigned char *>(&output[0]),
                  reinterpret_cast<const unsigned char *>(bytes.data()), bytes.size());
  return output;
}
std::string decode(const std::string &text) {
  if (text.empty())
    return "";
  if (text.size() > 4 * ((chunk_limit + 2) / 3) || text.size() % 4)
    throw Error("INVALID_REQUEST", "Invalid file chunk");
  std::string bytes(text.size() / 4 * 3, '\0');
  int length = EVP_DecodeBlock(reinterpret_cast<unsigned char *>(&bytes[0]),
                               reinterpret_cast<const unsigned char *>(text.data()), text.size());
  if (length < 0)
    throw Error("INVALID_REQUEST", "Invalid base64 file chunk");
  if (text.back() == '=')
    --length;
  if (text.size() > 1 && text[text.size() - 2] == '=')
    --length;
  if (length < 0 || length > chunk_limit)
    throw Error("INVALID_REQUEST", "File chunk too large");
  bytes.resize(length);
  if (encode(bytes) != text)
    throw Error("INVALID_REQUEST", "Non-canonical base64 file chunk");
  return bytes;
}
} // namespace
struct WorkspaceFiles::Upload {
  int parent = -1, fd = -1;
  std::string temporary, name, root, owner, previous;
  int64_t size = 0, offset = 0, touched = now();
  mode_t mode = 0600;
  bool published = false;
  std::map<int64_t, std::string> pending;
  ~Upload() {
    if (fd >= 0)
      ::close(fd);
    if (parent >= 0) {
      if (!temporary.empty())
        unlinkat(parent, temporary.c_str(), 0);
      ::close(parent);
    }
  }
};
WorkspaceFiles::WorkspaceFiles(Store *store) : store_(store) {}
WorkspaceFiles::~WorkspaceFiles() = default;
void WorkspaceFiles::clear() { uploads_.clear(); }
void WorkspaceFiles::cleanup() {
  for (auto it = completed_.begin(); it != completed_.end();)
    if (now() - it->second.value("completedAt", int64_t(0)) > 86400000)
      it = completed_.erase(it);
    else
      ++it;
  for (auto it = uploads_.begin(); it != uploads_.end();)
    if (now() - it->second->touched > 600000)
      it = uploads_.erase(it);
    else
      ++it;
}
Json WorkspaceFiles::request(const std::string &root, const std::string &sandbox,
                             const std::string &owner, const Json &d) {
  cleanup();
  auto operation = d.at("operation").get<std::string>();
  if (operation == "list") {
    auto path = d.value("path", "");
    auto parts = components(path);
    int fd = directory(root, parts, parts.size());
    DIR *raw = fdopendir(fd);
    if (!raw) {
      ::close(fd);
      failed();
    }
    auto close_directory = [](DIR *dir) { closedir(dir); };
    std::unique_ptr<DIR, decltype(close_directory)> entries(raw, close_directory);
    std::map<std::string, Json> page;
    auto after = d.value("after", "");
    struct stat directory_stat;
    if (fstat(fd, &directory_stat) < 0)
      failed();
    const auto key = root + "/" + path;
    const auto stamp = version(directory_stat);
    const auto add = [&](const std::string &name) {
      if (name <= after)
        return;
      struct stat st;
      if (fstatat(fd, name.c_str(), &st, AT_SYMLINK_NOFOLLOW) < 0 ||
          (!S_ISDIR(st.st_mode) && !S_ISREG(st.st_mode)))
        return;
      page[name] = {{"name", name}, {"directory", S_ISDIR(st.st_mode)}, {"size", st.st_size}};
      if (page.size() > 101)
        page.erase(std::prev(page.end()));
    };
    if (directory_key_ != key || directory_version_ != stamp || now() - directory_cached_ > 30000) {
      directory_names_.clear();
      directory_key_.clear();
      size_t bytes = 0;
      bool bounded = true;
      while (auto *entry = readdir(raw)) {
        std::string name = entry->d_name;
        if (name == "." || name == ".." || name.rfind(".coc-upload-", 0) == 0)
          continue;
        try {
          Json(name).dump();
        } catch (...) {
          continue;
        }
        bytes += sizeof(std::string) + name.size() + 1;
        if (bounded && bytes > 4 * 1024 * 1024) {
          // Huge directories retain the bounded streaming fallback.
          for (const auto &prior : directory_names_)
            add(prior);
          directory_names_.clear();
          bounded = false;
        }
        if (bounded)
          directory_names_.push_back(std::move(name));
        else
          add(name);
      }
      if (bounded) {
        std::sort(directory_names_.begin(), directory_names_.end());
        directory_key_ = key;
        directory_version_ = stamp;
        directory_cached_ = now();
      }
    }
    if (directory_key_ == key)
      for (auto name = std::upper_bound(directory_names_.begin(), directory_names_.end(), after);
           name != directory_names_.end() && page.size() < 101; ++name)
        add(*name);
    bool more = page.size() > 100;
    if (more)
      page.erase(std::prev(page.end()));
    Json data = Json::array();
    for (auto &[name, value] : page)
      data.push_back(value);
    return {{"entries", data},
            {"next", more ? Json(page.rbegin()->first) : Json()},
            {"writable", sandbox == "workspace-write"},
            {"maxSize", file_limit}};
  }
  if (operation == "read") {
    auto parts = components(d.at("path"));
    if (parts.empty())
      throw Error("INVALID_PATH", "Select a file");
    Fd parent(directory(root, parts, parts.size() - 1));
    Fd file(
        openat(parent.value, parts.back().c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
    if (file.value < 0)
      failed();
    struct stat st;
    if (fstat(file.value, &st) < 0)
      failed();
    if (!S_ISREG(st.st_mode))
      throw Error("FORBIDDEN", "Only regular files can be downloaded");
    if (st.st_size > file_limit)
      throw Error("FILE_TOO_LARGE", "File exceeds the 20 MiB transfer limit");
    auto offset = d.value("offset", int64_t(0));
    if (offset < 0 || offset > st.st_size)
      throw Error("INVALID_REQUEST", "Invalid download offset");
    auto stamp = version(st);
    if (d.contains("version") && d["version"] != stamp)
      throw Error("FILE_CHANGED", "File changed during download; retry from the start");
    std::string bytes(std::min<int64_t>(chunk_limit, st.st_size - offset), '\0');
    if (!bytes.empty()) {
      auto count = pread(file.value, &bytes[0], bytes.size(), offset);
      if (count < 0)
        failed();
      bytes.resize(count);
    }
    struct stat current;
    if (fstat(file.value, &current) < 0)
      failed();
    if (version(current) != stamp || (bytes.empty() && offset < st.st_size))
      throw Error("FILE_CHANGED", "File changed during download; retry from the start");
    return {{"data", encode(bytes)},
            {"size", st.st_size},
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
    upload->parent = directory(root, parts, parts.size() - 1);
    upload->name = parts.back();
    upload->root = root;
    upload->owner = owner;
    upload->size = size;
    struct stat st;
    if (fstatat(upload->parent, upload->name.c_str(), &st, AT_SYMLINK_NOFOLLOW) == 0) {
      if (!S_ISREG(st.st_mode))
        throw Error("FORBIDDEN", "Upload target must be a regular file");
      if (!d.value("overwrite", false))
        throw Error("FILE_EXISTS", "Explicitly allow overwrite or choose a new name");
      upload->previous = version(st);
      upload->mode = st.st_mode & 0777;
    } else if (errno != ENOENT)
      failed();
    auto temporary = ".coc-upload-" + uuid();
    upload->fd = openat(upload->parent, temporary.c_str(),
                        O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (upload->fd < 0)
      failed();
    upload->temporary = temporary;
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
      if (pread(upload.fd, prior.data(), prior.size(), offset) != int64_t(prior.size()) ||
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
      size_t written = 0;
      while (written < next.size()) {
        auto count = pwrite(upload.fd, next.data() + written, next.size() - written,
                            upload.offset + written);
        if (count < 0 && errno == EINTR)
          continue;
        if (count <= 0)
          failed();
        written += count;
      }
      upload.offset += next.size();
      upload.pending.erase(upload.pending.begin());
    }
    return {{"offset", upload.offset}};
  }
  if (operation != "finish")
    throw Error("INVALID_REQUEST", "Unknown file operation");
  if (upload.offset != upload.size)
    throw Error("UPLOAD_INCOMPLETE", "All file bytes must arrive before publishing");
  if (fchmod(upload.fd, upload.mode) < 0 || fsync(upload.fd) < 0)
    failed();
  if (!upload.published) {
    if (upload.previous.empty()) {
      if (linkat(upload.parent, upload.temporary.c_str(), upload.parent, upload.name.c_str(), 0) <
          0)
        failed();
    } else {
      struct stat st;
      if (fstatat(upload.parent, upload.name.c_str(), &st, AT_SYMLINK_NOFOLLOW) < 0 ||
          !S_ISREG(st.st_mode) || version(st) != upload.previous)
        throw Error("FILE_CHANGED", "Upload target changed; review it before overwriting");
      if (renameat(upload.parent, upload.temporary.c_str(), upload.parent, upload.name.c_str()) < 0)
        failed();
    }
    upload.published = true;
  }
  if (fsync(upload.parent) != 0)
    throw Error("RESULT_UNKNOWN",
                "File published but directory sync is unconfirmed; query upload status");
  EVP_MD_CTX *raw = EVP_MD_CTX_new();
  if (!raw)
    throw Error("RESULT_UNKNOWN", "Cannot calculate upload checksum");
  std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> hash(raw, EVP_MD_CTX_free);
  EVP_DigestInit_ex(raw, EVP_sha256(), nullptr);
  char buffer[65536];
  for (int64_t offset = 0; offset < upload.size;) {
    auto count = pread(upload.fd, buffer, sizeof(buffer), offset);
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
