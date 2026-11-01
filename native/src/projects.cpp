#include "coc/projects.hpp"
#include "coc/credit.hpp"
#include "coc/delivery.hpp"
#include "coc/store.hpp"
#include <algorithm>
#include <boost/asio/read_until.hpp>
#include <boost/asio/write.hpp>
#include <fstream>
#include <iostream>
#include <openssl/crypto.h>
#include <regex>
#ifdef _WIN32
#include <io.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif
namespace coc {
namespace {
bool readable_directory(const std::filesystem::path &path) {
#ifdef _WIN32
  return _waccess(path.c_str(), 4) == 0;
#else
  return access(path.c_str(), R_OK | X_OK) == 0;
#endif
}
bool overlaps(const std::filesystem::path &a, const std::filesystem::path &b) {
  auto pair =
      std::mismatch(a.begin(), a.end(), b.begin(), b.end(), [](const auto &x, const auto &y) {
#ifdef _WIN32
        return _wcsicmp(x.c_str(), y.c_str()) == 0;
#else
    return x == y;
#endif
      });
  return pair.first == a.end() || pair.second == b.end();
}
constexpr size_t project_overhead = 4096;
size_t receipt_metadata(const Json &entry) {
  size_t bytes = project_overhead;
  if (entry.contains("result"))
    bytes += entry.at("result").at("projects").size() * 512;
  return bytes;
}
size_t project_bytes(const Json &state) {
  size_t metadata = 0;
  for (const auto &entry : state.at("journal").at("tail"))
    metadata += receipt_metadata(entry);
  return 2 * (state.dump().size() + 1 + project_overhead + metadata +
              state.at("journal").at("keys").size() * 1024 + state.at("projects").size() * 512 +
              state.at("retiredIds").size() * 512);
}
size_t result_reservation(const Json &state) {
  return credit::project_result_reservation + 2 * (state.at("projects").size() + 1) * 512;
}
size_t tail_bytes(const Json &tail) {
  size_t bytes = 0;
  for (const auto &entry : tail)
    bytes += entry.dump().size() + receipt_metadata(entry);
  return bytes;
}
void trim_tail(Json &tail, size_t reserve = 0) {
  while (!tail.empty() && (tail.size() + (reserve ? 1 : 0) > credit::project_tail ||
                           tail_bytes(tail) + reserve > credit::project_tail_bytes))
    tail.erase(tail.begin());
}
void check_catalog(const Json &state) {
  auto projects = state.at("projects");
  // Include the availability field returned by list(), not only write receipts.
  for (auto &project : projects)
    project["available"] = false;
  if (Json{{"revision", state.at("revision")}, {"projects", projects}}.dump().size() >
      max_frame - 8192)
    throw Error("MESSAGE_TOO_LARGE", "Project catalog exceeds frame budget");
}
Json load_catalog(const std::filesystem::path &path) {
  if (!std::filesystem::is_regular_file(std::filesystem::symlink_status(path)))
    throw Error("CONFIG_ERROR", "Project catalog must be a regular file");
  std::ifstream file(path, std::ios::binary);
  if (!file)
    throw Error("CONFIG_ERROR", "Cannot read project catalog");
  std::string text(credit::project_budget / 2 - project_overhead + 1, '\0');
  file.read(text.data(), text.size());
  text.resize(static_cast<size_t>(file.gcount()));
  if (2 * (text.size() + project_overhead) > credit::project_budget)
    throw Error("BACKPRESSURE", "Project catalog exceeds its storage budget");
  if (file.bad())
    throw Error("CONFIG_ERROR", "Cannot read project catalog");
  return Json::parse(text);
}
void cleanup_catalog(const std::filesystem::path &file) {
  const auto directory = file.parent_path();
  if (!std::filesystem::exists(directory))
    return;
  const auto prefix = file.filename().u8string() + ".tmp-";
  static const std::regex temporary_id(
      "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
  bool removed = false;
  for (const auto &entry : std::filesystem::directory_iterator(directory)) {
    const auto name = entry.path().filename().u8string();
    if (name.compare(0, prefix.size(), prefix) != 0 ||
        !std::regex_match(name.substr(prefix.size()), temporary_id))
      continue;
    if (!std::filesystem::is_regular_file(entry.symlink_status()))
      throw Error("CONFIG_ERROR", "Abandoned project replacement must be a regular file");
    removed = std::filesystem::remove(entry.path()) || removed;
  }
#ifndef _WIN32
  if (removed) {
    const auto fd = open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0)
      throw Error("STORAGE_ERROR", "Cannot open project directory for cleanup");
    const auto result = fsync(fd);
    close(fd);
    if (result != 0)
      throw Error("STORAGE_ERROR", "Cannot persist project replacement cleanup");
  }
#else
  (void)removed;
#endif
}
std::filesystem::path endpoint_file(const Json &config) {
  return std::filesystem::u8path(config.at("dataDir").get<std::string>()) / "project-control.json";
}
Json unwrap(const Json &value) {
  if (value.contains("error"))
    throw Error(value["error"].at("code"), value["error"].at("message"));
  return value.at("data");
}
} // namespace
Projects::Projects(const Json &config)
    : file_(std::filesystem::u8path(config.at("dataDir").get<std::string>()) / "projects.json") {
  const bool exists = std::filesystem::exists(file_);
  state_ = exists ? load_catalog(file_)
                  : Json{{"version", 1},
                         {"hostId", config.at("hostId")},
                         {"revision", 0},
                         {"projects", config.at("projects")}};
  if (state_.value("version", 0) != 1 || state_.at("hostId") != config.at("hostId") ||
      !state_.at("projects").is_array() || !state_.at("revision").is_number_integer() ||
      state_.at("revision").get<int64_t>() < 0 ||
      state_.at("revision").get<int64_t>() > 9007199254740991LL)
    throw Error("CONFIG_ERROR", "Invalid project catalog");
  // Project configuration is authoritative data. Old business receipts are not
  // imported into the new journal or used to authorize another execution.
  state_.erase("receipts");
  if (!state_.contains("journal"))
    state_["journal"] = {{"version", 2}, {"keys", Json::object()}, {"tail", Json::array()}};
  if (!state_.contains("retiredIds"))
    state_["retiredIds"] = Json::array();
  auto &journal = state_.at("journal");
  if (journal.value("version", 0) != 2 || !journal.at("keys").is_object() ||
      !journal.at("tail").is_array() || !state_.at("retiredIds").is_array() ||
      journal.at("keys").size() > credit::project_records ||
      journal.at("tail").size() > credit::project_tail ||
      tail_bytes(journal.at("tail")) > credit::project_tail_bytes ||
      state_.at("retiredIds").size() > credit::project_retired_ids)
    throw Error("CONFIG_ERROR", "Invalid or oversized project journal");
  bool interrupted = false;
  static const std::regex digest_pattern("^[0-9a-f]{64}$");
  for (auto it = journal.at("keys").begin(); it != journal.at("keys").end(); ++it) {
    auto &entry = it.value();
    const auto phase = entry.value("phase", "");
    if (!valid_id(it.key()) || !entry.contains("owner") || !entry.at("owner").is_string() ||
        !valid_id(entry.at("owner")) || !entry.contains("requestId") ||
        !entry.at("requestId").is_string() || !valid_id(entry.at("requestId")) ||
        it.key() !=
            delivery_digest(
                Json{{"owner", entry.at("owner")}, {"requestId", entry.at("requestId")}}.dump()) ||
        !entry.at("digest").is_string() ||
        !std::regex_match(entry.at("digest").get<std::string>(), digest_pattern) ||
        (phase != "started" && phase != "finished" && phase != "failed" && phase != "unknown"))
      throw Error("CONFIG_ERROR", "Invalid project request identity");
    if (phase == "started") {
      entry["phase"] = "unknown";
      interrupted = true;
    }
  }
  check_catalog(state_);
  if (project_bytes(state_) > credit::project_budget)
    throw Error("BACKPRESSURE", "Project storage budget exhausted");
  cleanup_catalog(file_);
  if (!exists || interrupted)
    commit(state_);
}
void Projects::commit(Json next) {
  if (failed_)
    throw Error("STORAGE_ERROR", "Project storage failed; restart before modifying projects");
  if (project_bytes(next) > credit::project_budget)
    throw Error("BACKPRESSURE", "Project storage budget exhausted");
  try {
    cleanup_catalog(file_);
    save_private_text(file_, next.dump() + "\n");
  } catch (...) {
    failed_ = true;
    throw;
  }
  state_ = std::move(next);
}
Json Projects::usage() const {
  const auto &journal = state_.at("journal");
  size_t unknown = 0, reserved = 0;
  for (const auto &entry : journal.at("keys")) {
    unknown += entry.at("phase") == "unknown";
    if (entry.at("phase") == "started")
      reserved += result_reservation(state_);
  }
  return {{"bytes", project_bytes(state_)},
          {"reserved", reserved},
          {"requests", journal.at("keys").size()},
          {"unknown", unknown},
          {"retiredIds", state_.at("retiredIds").size()},
          {"receiptBytes", tail_bytes(journal.at("tail"))},
          {"storageFailed", failed_}};
}
Json Projects::list() const {
  if (failed_)
    throw Error("STORAGE_ERROR", "Project storage failed; restart before reading projects");
  auto projects = state_.at("projects");
  for (auto &p : projects) {
    std::error_code ec;
    auto path = std::filesystem::u8path(p.at("path").get<std::string>());
    auto real = std::filesystem::canonical(path, ec);
    p["available"] = !ec && real == path && std::filesystem::is_directory(real, ec) && !ec &&
                     readable_directory(real);
  }
  return {{"revision", state_.at("revision")}, {"projects", projects}};
}
Json Projects::request(const Json &d, const std::function<bool(const std::string &)> &busy,
                       const std::string &owner) {
  try {
    return execute(d, busy, owner);
  } catch (const std::filesystem::filesystem_error &error) {
    throw Error("PROJECT_PATH", "Cannot access project directory: " + error.code().message());
  }
}
Json Projects::execute(const Json &d, const std::function<bool(const std::string &)> &busy,
                       const std::string &owner) {
  if (failed_)
    throw Error("STORAGE_ERROR", "Project storage failed; restart before modifying projects");
  const auto operation = d.at("operation").get<std::string>();
  if (operation == "list")
    return list();
  if (operation == "browse") {
    const auto raw = d.at("path").get<std::string>();
    if (raw.empty() || raw.size() > 4096 || raw.find('\0') != std::string::npos ||
        !std::filesystem::u8path(raw).is_absolute())
      throw Error("INVALID_REQUEST", "Directory path must be absolute and valid");
    auto path =
        std::filesystem::canonical(std::filesystem::u8path(d.at("path").get<std::string>()));
    Json directories = Json::array();
    bool truncated = false;
    size_t bytes = 0, scanned = 0;
    for (const auto &entry : std::filesystem::directory_iterator(path)) {
      if (++scanned > 1000) {
        truncated = true;
        break;
      }
      std::error_code ec;
      if (!entry.is_directory(ec) || ec)
        continue;
      Json directory = {{"name", entry.path().filename().u8string()},
                        {"path", entry.path().u8string()}};
      bytes += directory.dump().size() + 1;
      if (directories.size() == 200 || bytes > 96 * 1024) {
        truncated = true;
        break;
      }
      directories.push_back(std::move(directory));
    }
    std::sort(directories.begin(), directories.end(), [](const Json &a, const Json &b) {
      return a.at("name").get<std::string>() < b.at("name").get<std::string>();
    });
    return {{"path", path.u8string()},
            {"parent", path.parent_path().u8string()},
            {"directories", directories},
            {"truncated", truncated}};
  }
  if (operation != "add" && operation != "rename" && operation != "remove")
    throw Error("INVALID_REQUEST", "Unknown project operation");
  if (!d.at("revision").is_number_integer() || d.at("revision").get<int64_t>() < 0 ||
      d.at("revision").get<int64_t>() > 9007199254740991LL)
    throw Error("INVALID_REQUEST", "Invalid project revision");
  const auto request_id = d.at("requestId").get<std::string>();
  if (!valid_id(request_id) || !valid_id(owner))
    throw Error("INVALID_REQUEST", "Invalid project request ID");
  if (d.dump().size() > credit::record_bytes)
    throw Error("INVALID_REQUEST", "Project request exceeds its metadata budget");
  const auto key = delivery_digest(Json{{"owner", owner}, {"requestId", request_id}}.dump());
  const auto digest = delivery_digest(d.dump());
  const auto &journal = state_.at("journal");
  if (journal.at("keys").contains(key)) {
    const auto &entry = journal.at("keys").at(key);
    if (entry.at("digest") != digest)
      throw Error("IDEMPOTENCY_CONFLICT", "Project request ID reused with different arguments");
    if (entry.at("phase") == "started" || entry.at("phase") == "unknown")
      throw Error("RESULT_UNKNOWN",
                  "Original project operation was interrupted; inspect the catalog");
    for (const auto &receipt : journal.at("tail")) {
      if (receipt.at("id") != key)
        continue;
      if (receipt.contains("error"))
        throw Error(receipt.at("error").at("code"), receipt.at("error").at("message"));
      return receipt.at("result");
    }
    throw Error("RESULT_UNAVAILABLE",
                "Original project result was retired; the request cannot reopen");
  }
  if (d.at("revision") != state_.at("revision"))
    throw Error("PROJECT_CONFLICT", "Projects changed; refresh before retrying");
  if (state_.at("revision") == 9007199254740991LL)
    throw Error("BACKPRESSURE", "Project revision space exhausted");
  if (journal.at("keys").size() >= credit::project_records)
    throw Error("BACKPRESSURE", "Project request identity budget exhausted");
  std::filesystem::path create_path, expected_path;
  auto next = state_;
  auto &projects = next["projects"];
  if (operation == "add") {
    const auto id = d.value("id", uuid());
    if (!valid_id(id))
      throw Error("INVALID_REQUEST", "Invalid project ID");
    for (const auto &retired : state_.value("retiredIds", Json::array()))
      if (retired == id)
        throw Error("PROJECT_CONFLICT", "Project ID belongs to removed project history");
    for (const auto &p : projects)
      if (p["id"] == id)
        throw Error("PROJECT_CONFLICT", "Project ID already registered");
    const auto raw = d.at("path").get<std::string>();
    if (raw.empty() || raw.size() > 4096 || raw.find('\0') != std::string::npos)
      throw Error("INVALID_REQUEST", "Invalid directory path");
    auto path = std::filesystem::u8path(raw);
    if (!path.is_absolute())
      throw Error("INVALID_REQUEST", "Remote project path must be absolute");
    auto real = std::filesystem::weakly_canonical(path);
    for (const auto &p : projects)
      if (overlaps(real, std::filesystem::u8path(p.at("path").get<std::string>())))
        throw Error("PROJECT_CONFLICT", "Project directories must not duplicate or overlap");
    if (real.u8string().size() > 4096)
      throw Error("INVALID_REQUEST", "Canonical project path exceeds its budget");
    const auto name = display_name(
        d.value("name", real.filename().u8string().empty() ? id : real.filename().u8string()));
    if (d.value("mkdir", false) && !std::filesystem::exists(path)) {
      create_path = path;
      expected_path = real;
    } else
      real = std::filesystem::canonical(path);
    if (create_path.empty() && !readable_directory(real))
      throw Error("PROJECT_PATH", "Agent system user cannot read the directory");
    if (create_path.empty() && !std::filesystem::is_directory(real))
      throw Error("INVALID_REQUEST", "Project must be a directory");
    for (const auto &p : projects)
      if (overlaps(real, std::filesystem::u8path(p.at("path").get<std::string>())))
        throw Error("PROJECT_CONFLICT", "Project directories must not duplicate or overlap");
    projects.push_back({{"id", id}, {"name", name}, {"path", real.u8string()}});
  } else {
    const auto id = d.at("id").get<std::string>();
    auto it = std::find_if(projects.begin(), projects.end(),
                           [&](const Json &p) { return p.at("id") == id; });
    if (it == projects.end())
      throw Error("PROJECT_NOT_FOUND", "Project not registered");
    if (operation == "rename")
      (*it)["name"] = display_name(d.at("name"));
    else {
      if (busy(id))
        throw Error("PROJECT_BUSY", "Project has active sessions or file operations");
      if (next.at("retiredIds").size() >= credit::project_retired_ids)
        throw Error("BACKPRESSURE", "Retired project identity budget exhausted");
      next["retiredIds"].push_back(id);
      projects.erase(it);
    }
  }
  next["revision"] = state_.at("revision").get<int64_t>() + 1;
  Json result = {{"revision", next["revision"]}, {"projects", next["projects"]}};
  check_catalog(next);
  auto started = state_;
  started["journal"]["keys"][key] = {
      {"owner", owner}, {"requestId", request_id}, {"digest", digest}, {"phase", "started"}};
  trim_tail(started["journal"]["tail"], max_frame + next.at("projects").size() * 512);
  if (project_bytes(started) + result_reservation(started) > credit::project_budget)
    throw Error("BACKPRESSURE", "Project result reservation exhausted");
  next["journal"] = started.at("journal");
  next["journal"]["keys"][key]["phase"] = "finished";
  next["journal"]["tail"].push_back({{"id", key}, {"result", result}});
  trim_tail(next["journal"]["tail"]);
  if (project_bytes(next) > credit::project_budget)
    throw Error("BACKPRESSURE", "Project storage budget exhausted");
  // Both identity and terminal-result space are durable before mkdir or catalog
  // publication. Crashes after this point never execute the original again.
  commit(std::move(started));
  try {
    if (!create_path.empty()) {
      std::filesystem::create_directories(create_path);
      const auto real = std::filesystem::canonical(create_path);
      if (real != expected_path || !std::filesystem::is_directory(real) ||
          !readable_directory(real))
        throw Error("PROJECT_PATH", "Created project directory changed or is not readable");
    }
    commit(std::move(next));
  } catch (const std::exception &error) {
    if (failed_)
      throw Error("RESULT_UNKNOWN",
                  "Project completion could not be persisted; inspect the catalog");
    auto failure = error_data(error);
    if (const auto *fs = dynamic_cast<const std::filesystem::filesystem_error *>(&error))
      failure = {{"code", "PROJECT_PATH"},
                 {"message", "Cannot access project directory: " + fs->code().message()}};
    auto failed = state_;
    failed["journal"]["keys"][key]["phase"] = "failed";
    failed["journal"]["tail"].push_back({{"id", key}, {"error", failure}});
    trim_tail(failed["journal"]["tail"]);
    try {
      commit(std::move(failed));
    } catch (...) {
      throw Error("RESULT_UNKNOWN", "Project failure could not be persisted; inspect the catalog");
    }
    throw Error(failure.at("code"), failure.at("message"));
  }
  return result;
}
Json project_arguments(const Options &options, bool remote) {
  const auto &args = options.args;
  if (args.size() < 2)
    throw Error("USAGE", "project list|browse PATH|add PATH [--mkdir]|rename ID NAME|remove ID");
  auto op = args[1];
  size_t count = op == "list" ? 2 : op == "rename" ? 4 : 3;
  if (args.size() != count ||
      (op != "list" && op != "browse" && op != "add" && op != "rename" && op != "remove"))
    throw Error("USAGE", "project list|browse PATH|add PATH [--mkdir]|rename ID NAME|remove ID");
  Json d = {{"operation", op}};
  if (op == "browse" || op == "add") {
    auto path = std::filesystem::u8path(args[2]);
    d["path"] = remote ? args[2] : std::filesystem::absolute(path).lexically_normal().u8string();
  }
  if (op == "add") {
    d["mkdir"] = options.get("mkdir") == "true";
    if (!options.get("name").empty())
      d["name"] = options.get("name");
    if (!options.get("project-id").empty())
      d["id"] = options.get("project-id");
  }
  if (op == "rename" || op == "remove")
    d["id"] = args[2];
  if (op == "rename")
    d["name"] = args[3];
  if (op == "add" || op == "rename" || op == "remove") {
    if (!options.get("request-id").empty() && options.get("revision").empty())
      throw Error("USAGE", "Retries with --request-id also require the original --revision");
    d["requestId"] = options.get("request-id", uuid());
    if (!options.get("revision").empty())
      d["revision"] = std::stoll(options.get("revision"));
  }
  return d;
}
struct ProjectControl::Impl : std::enable_shared_from_this<ProjectControl::Impl> {
  asio::io_context &io;
  asio::ip::tcp::acceptor acceptor;
  std::string secret = uuid() + uuid();
  std::function<Json(Json)> handler;
  size_t active = 0;
  struct Connection {
    asio::ip::tcp::socket socket;
    asio::steady_timer timer;
    asio::streambuf buffer{16384};
    std::string output;
    explicit Connection(asio::io_context &io) : socket(io), timer(io) {}
  };
  Impl(asio::io_context &context, std::function<Json(Json)> fn)
      : io(context), acceptor(io, {asio::ip::make_address("127.0.0.1"), 0}),
        handler(std::move(fn)) {}
  void accept() {
    auto c = std::make_shared<Connection>(io);
    auto self = shared_from_this();
    acceptor.async_accept(c->socket, [self, c](auto ec) {
      if (ec)
        return;
      self->accept();
      if (self->active >= 16)
        return;
      ++self->active;
      c->timer.expires_after(std::chrono::seconds(5));
      c->timer.async_wait([c](auto error) {
        if (!error) {
          boost::system::error_code ignored;
          c->socket.close(ignored);
        }
      });
      asio::async_read_until(c->socket, c->buffer, '\n', [self, c](auto error, size_t) {
        if (error) {
          --self->active;
          c->timer.cancel();
          return;
        }
        Json response;
        try {
          std::istream input(&c->buffer);
          std::string line;
          std::getline(input, line);
          auto d = Json::parse(line);
          auto supplied = d.value("token", "");
          if (supplied.size() != self->secret.size() ||
              CRYPTO_memcmp(supplied.data(), self->secret.data(), supplied.size()) != 0)
            throw Error("FORBIDDEN", "Invalid local Agent credential");
          response["data"] = self->handler(d.at("data"));
        } catch (const std::exception &failure) {
          response["error"] = error_data(failure);
        }
        c->output = response.dump() + "\n";
        asio::async_write(c->socket, asio::buffer(c->output), [self, c](auto, size_t) {
          --self->active;
          c->timer.cancel();
          boost::system::error_code ignored;
          c->socket.close(ignored);
        });
      });
    });
  }
};
ProjectControl::ProjectControl(asio::io_context &io, const Json &config,
                               std::function<Json(Json)> handler)
    : impl_(std::make_shared<Impl>(io, std::move(handler))) {
  save_private(endpoint_file(config), {{"port", impl_->acceptor.local_endpoint().port()},
                                       {"token", impl_->secret},
                                       {"hostId", config.at("hostId")}});
  impl_->accept();
}
ProjectControl::~ProjectControl() {
  boost::system::error_code ignored;
  impl_->acceptor.close(ignored);
}
Json local_project_request(const Json &config, Json d) {
  std::unique_ptr<Store::Lock> lock;
  try {
    lock = std::make_unique<Store::Lock>(config.at("dataDir"), true);
  } catch (const Error &e) {
    if (e.code != "STATE_LOCKED")
      throw;
  }
  if (lock) {
    Projects projects(config);
    if (d.contains("requestId") && !d.contains("revision"))
      d["revision"] = projects.list().at("revision");
    if (d.contains("requestId"))
      std::cerr << "Project request " << d["requestId"] << " revision " << d["revision"] << '\n';
    return projects.request(d, [](const std::string &) { return false; });
  }
  if (d.contains("requestId") && !d.contains("revision"))
    d["revision"] = local_project_request(config, {{"operation", "list"}}).at("revision");
  if (d.contains("requestId"))
    std::cerr << "Project request " << d["requestId"] << " revision " << d["revision"] << '\n';
  auto endpoint = read_json(endpoint_file(config));
  if (endpoint.at("hostId") != config.at("hostId"))
    throw Error("FORBIDDEN", "Local Agent identity mismatch");
  asio::io_context io;
  asio::ip::tcp::socket socket(io);
  asio::steady_timer timer(io);
  asio::streambuf buffer(max_frame);
  Json response;
  std::string failure;
  const auto port = endpoint.at("port").get<unsigned>();
  if (!port || port > 65535)
    throw Error("CONFIG_ERROR", "Invalid local Agent port");
  const auto wire = Json({{"token", endpoint.at("token")}, {"data", d}}).dump() + "\n";
  timer.expires_after(std::chrono::seconds(10));
  timer.async_wait([&](auto ec) {
    if (!ec) {
      failure = "Local Agent request timed out; outcome may be unknown";
      boost::system::error_code ignored;
      socket.close(ignored);
    }
  });
  socket.async_connect(
      {asio::ip::make_address("127.0.0.1"), static_cast<unsigned short>(port)}, [&](auto ec) {
        if (ec) {
          failure = "Agent is starting or unavailable; retry";
          timer.cancel();
          return;
        }
        asio::async_write(socket, asio::buffer(wire), [&](auto error, size_t) {
          if (error) {
            failure = error.message();
            timer.cancel();
            return;
          }
          asio::async_read_until(socket, buffer, '\n', [&](auto read_error, size_t) {
            timer.cancel();
            if (read_error) {
              failure = read_error.message();
              return;
            }
            try {
              std::istream input(&buffer);
              input >> response;
            } catch (...) {
              failure = "Invalid local Agent response";
            }
          });
        });
      });
  io.run();
  if (!failure.empty())
    throw Error("RESULT_UNKNOWN", failure);
  return unwrap(response);
}
} // namespace coc
