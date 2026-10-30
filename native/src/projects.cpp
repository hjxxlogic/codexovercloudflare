#include "coc/projects.hpp"
#include "coc/store.hpp"
#include <algorithm>
#include <boost/asio/read_until.hpp>
#include <boost/asio/write.hpp>
#include <iostream>
#include <openssl/crypto.h>
#ifdef _WIN32
#include <io.h>
#else
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
  if (std::filesystem::exists(file_))
    state_ = read_json(file_);
  else {
    state_ = {{"version", 1},
              {"hostId", config.at("hostId")},
              {"revision", 0},
              {"projects", config.at("projects")},
              {"receipts", Json::array()}};
    save_private(file_, state_);
  }
  if (state_.value("version", 0) != 1 || state_.at("hostId") != config.at("hostId") ||
      !state_.at("projects").is_array() || state_.at("projects").size() > 20 ||
      !state_.at("receipts").is_array())
    throw Error("CONFIG_ERROR", "Invalid project catalog");
}
Json Projects::list() const {
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
Json Projects::request(const Json &d, const std::function<bool(const std::string &)> &busy) {
  try {
    return execute(d, busy);
  } catch (const std::filesystem::filesystem_error &error) {
    throw Error("PROJECT_PATH", "Cannot access project directory: " + error.code().message());
  }
}
Json Projects::execute(const Json &d, const std::function<bool(const std::string &)> &busy) {
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
  const auto key = d.at("requestId").get<std::string>();
  if (!valid_id(key))
    throw Error("INVALID_REQUEST", "Invalid project request ID");
  const auto fingerprint = d.dump();
  for (const auto &r : state_.at("receipts"))
    if (r.at("id") == key) {
      if (r.at("fingerprint") != fingerprint)
        throw Error("IDEMPOTENCY_CONFLICT", "Project request ID reused with different arguments");
      return r.at("result");
    }
  if (d.at("revision") != state_.at("revision"))
    throw Error("PROJECT_CONFLICT", "Projects changed; refresh before retrying");
  auto next = state_;
  auto &projects = next["projects"];
  if (operation == "add") {
    if (projects.size() >= 20)
      throw Error("CAPACITY", "At most twenty projects");
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
    const auto name = display_name(
        d.value("name", real.filename().u8string().empty() ? id : real.filename().u8string()));
    if (d.value("mkdir", false))
      std::filesystem::create_directories(path);
    real = std::filesystem::canonical(path);
    if (!readable_directory(real))
      throw Error("PROJECT_PATH", "Agent system user cannot read the directory");
    if (!std::filesystem::is_directory(real))
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
      if (!next.contains("retiredIds"))
        next["retiredIds"] = Json::array();
      next["retiredIds"].push_back(id);
      projects.erase(it);
    }
  }
  next["revision"] = state_.at("revision").get<int64_t>() + 1;
  Json result = {{"revision", next["revision"]}, {"projects", next["projects"]}};
  if (result.dump().size() > max_frame - 8192)
    throw Error("MESSAGE_TOO_LARGE", "Project catalog exceeds frame budget");
  next["receipts"].push_back({{"id", key}, {"fingerprint", fingerprint}, {"result", result}});
  if (next["receipts"].size() > 64)
    next["receipts"].erase(next["receipts"].begin());
  save_private(file_, next);
  state_ = std::move(next);
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
