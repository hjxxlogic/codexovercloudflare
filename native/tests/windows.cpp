#include "coc/windows.hpp"
#include "coc/files.hpp"
#include "coc/network.hpp"
#include "coc/process.hpp"
#include "coc/store.hpp"
#include "coc/tls.hpp"
#include "coc/update.hpp"
#include "external-approvals.hpp"
#include <aclapi.h>
#include <algorithm>
#include <cctype>
#include <fstream>
#include <iostream>
#include <thread>
namespace {
using namespace coc;
void check(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class F> void rejects(F operation, const char *code) {
  try {
    operation();
  } catch (const Error &error) {
    check(error.code == code, error.what());
    return;
  }
  throw std::runtime_error("Expected rejection");
}
} // namespace
int main() {
  using namespace coc;
  auto root = std::filesystem::temp_directory_path() / wide("coc-windows-" + uuid());
  std::filesystem::create_directories(root);
  try {
    std::cout << "RUN: private credentials and ACL" << std::endl;
    auto config = root / L"配置.json";
    save_private(config, {{"token", "secret"}}, true);
    check(read_json(config).at("token") == "secret", "Private Unicode configuration roundtrip");
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    PACL acl = nullptr;
    auto config_name = config.wstring();
    check(GetNamedSecurityInfoW(config_name.data(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                nullptr, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS,
          "Read credential ACL");
    SECURITY_DESCRIPTOR_CONTROL control;
    DWORD revision;
    check(GetSecurityDescriptorControl(descriptor, &control, &revision) &&
              (control & SE_DACL_PROTECTED) && acl && acl->AceCount == 2,
          "Credential ACL contains only current user and SYSTEM");
    LocalFree(descriptor);
    rejects([&] { save_private(config, Json::object(), true); }, "CONFIG_ERROR");
    save_private(config, {{"token", "replacement"}});
    check(read_json(config).at("token") == "replacement", "Atomic replacement");
    {
      PrivateLock lock(config);
      rejects([&] { PrivateLock duplicate(config); }, "CONFIG_BUSY");
    }
    { PrivateLock lock(config); }
    std::cout << "RUN: SQLite state and exclusive lock" << std::endl;
    auto data = (root / "data").u8string();
    {
      Store store(data);
      rejects([&] { Store duplicate(data); }, "STATE_LOCKED");
      store.cache_put("value", {{"ok", true}});
      check(store.cache_get("value").at("ok") == true, "SQLite cache");
      store.save({{"id", "session"}, {"state", "closed"}});
      store.event("session", "user", {{"text", "hello"}});
      check(store.history("session").at("events").size() == 1, "Persistent history");
      Json item = {{"id", "reply"}, {"type", "agentMessage"}, {"text", "hello"}};
      auto first = store.external_item("session", "turn", item);
      check(store.external_item("session", "turn", item).is_null(),
            "External unchanged poll deduplicated");
      item["text"] = "hello again";
      auto updated = store.external_item("session", "turn", item);
      check(updated["seq"] == first["seq"] && updated["revision"] > first["revision"],
            "External snapshot revision");
      store.begin("request", "fingerprint");
      rejects([&] { store.begin("request", "fingerprint"); }, "RESULT_UNKNOWN");
    }
    std::cout << "RUN: workspace files and directory locks" << std::endl;
    auto project = root / L"项目";
    std::filesystem::create_directory(project);
    auto validated = agent_config({{"hostId", "windows"},
                                   {"token", std::string(24, 'x')},
                                   {"dataDir", data},
                                   {"projects", Json::array({{{"id", "project"},
                                                              {"name", "Windows project"},
                                                              {"path", project.u8string()}}})}});
    auto path = validated.at("projects").at(0).at("path").get<std::string>();
    shared_approval_fixture(path);
    auto duplicate = validated;
    auto upper_path = path;
    std::transform(upper_path.begin(), upper_path.end(), upper_path.begin(),
                   [](unsigned char c) { return char(std::toupper(c)); });
    duplicate["projects"].push_back(
        {{"id", "duplicate"}, {"name", "Duplicate"}, {"path", upper_path}});
    rejects([&] { agent_config(duplicate); }, "CONFIG_ERROR");
    WorkspaceFiles files;
    auto request = [&](Json value, const std::string &policy = "workspace-write") {
      std::cout << "FILE: " << value.at("operation").get<std::string>() << " "
                << value.value("path", "") << std::endl;
      return files.request(path, policy, "owner", value);
    };
    for (auto bad : {"../outside", "C:/outside", "a\\b", "file:stream", "CON", "a.", "a ", "a//b",
                     ".COC-UPLOAD-secret", "COM\xc2\xb9", "NUL .txt"})
      rejects([&] { request({{"operation", "read"}, {"path", bad}}); }, "INVALID_PATH");
    rejects(
        [&] {
          request({{"operation", "begin"}, {"uploadId", "readonly"}, {"path", "a"}, {"size", 1}},
                  "read-only");
        },
        "FORBIDDEN");
    request({{"operation", "begin"}, {"uploadId", "test"}, {"path", "hello.txt"}, {"size", 5}});
    request({{"operation", "chunk"}, {"uploadId", "test"}, {"offset", 0}, {"data", "aGVsbG8="}});
    auto done = request({{"operation", "finish"}, {"uploadId", "test"}});
    check(done.at("size") == 5, "Upload committed");
    check(request({{"operation", "finish"}, {"uploadId", "test"}}) == done, "Finish deduplicated");
    auto read = request({{"operation", "read"}, {"path", "hello.txt"}});
    check(read.at("data") == "aGVsbG8=", "File read roundtrip");
    const auto stale_read = [&] {
      request({{"operation", "read"}, {"path", "hello.txt"}, {"version", "stale"}});
    };
    rejects(stale_read, "FILE_CHANGED");
    check(request({{"operation", "list"}}).at("entries").size() == 1, "Directory listing");
    request({{"operation", "begin"},
             {"uploadId", "replace"},
             {"path", "hello.txt"},
             {"size", 0},
             {"overwrite", true}});
    request({{"operation", "finish"}, {"uploadId", "replace"}});
    check(request({{"operation", "read"}, {"path", "hello.txt"}}).at("size") == 0, "Overwrite");
    std::filesystem::create_directory(project / "nested");
    request(
        {{"operation", "begin"}, {"uploadId", "locked"}, {"path", "nested/file.txt"}, {"size", 0}});
    check(!MoveFileExW((project / "nested").c_str(), (project / "moved").c_str(), 0),
          "Held upload ancestors cannot be moved");
    request({{"operation", "cancel"}, {"uploadId", "locked"}});
    check(MoveFileExW((project / "nested").c_str(), (project / "moved").c_str(), 0) != FALSE,
          "Cancel releases ancestor handles");
    std::filesystem::remove(project / "moved");
    // Symlink creation is available on CI with developer mode or elevated token.
    std::error_code ec;
    std::filesystem::create_directory_symlink(root, project / "escape", ec);
    if (!ec)
      rejects([&] { request({{"operation", "list"}, {"path", "escape"}}); }, "FORBIDDEN");
    std::cout << "RUN: process arguments, jobs and RPC" << std::endl;
    auto child = (executable_path().parent_path() / "coc-test-child.exe").u8string();
    Json arguments =
        Json::array({"", "a b", "quote\"here", "trailing\\", "space \\", "x&echo unsafe"});
    std::vector<std::string> args{child, "--echo-args"};
    for (auto &argument : arguments)
      args.push_back(argument);
    check(Json::parse(windows_capture(args)) == arguments, "Windows argv quoting");
    {
      WindowsChild family({child, "--spawn-child"});
      boost::asio::io_context family_io;
      boost::asio::windows::stream_handle output(family_io, family.output.release());
      boost::asio::streambuf buffer;
      boost::asio::read_until(output, buffer, '\n');
      std::istream line(&buffer);
      DWORD pid = 0;
      line >> pid;
      WinHandle descendant(OpenProcess(SYNCHRONIZE, FALSE, pid));
      check(bool(descendant), "Open test descendant");
      family.terminate();
      check(WaitForSingleObject(descendant.get(), 3000) == WAIT_OBJECT_0,
            "Codex job terminates the complete process tree");
    }
    Json settings{{"codexPath", child}, {"codexArgs", Json::array()}, {"sandbox", "read-only"}};
    verify_codex(settings);
    boost::asio::io_context io;
    bool initialized = false, exited = false;
    const auto on_exit = [&] { exited = true; };
    const auto on_message = [](Json) {};
    auto process = std::make_shared<CodexProcess>(io, settings, path, on_message, on_exit);
    process->start();
    process->initialize([&](Json result, Json error) {
      initialized = error.is_null() && result.at("ok");
      process->close();
    });
    io.run();
    check(initialized && exited, "Async Codex RPC and process exit");
    {
      std::cout << "RUN: Windows trust, DNS and HTTP" << std::endl;
      boost::asio::ssl::context trust(boost::asio::ssl::context::tls_client);
      configure_trust(trust);
      check(sk_X509_OBJECT_num(
                X509_STORE_get0_objects(SSL_CTX_get_cert_store(trust.native_handle()))) > 0,
            "Windows trusted roots loaded");
      boost::asio::io_context server_io;
      using tcp = boost::asio::ip::tcp;
      tcp::acceptor acceptor(server_io,
                             tcp::endpoint(boost::asio::ip::make_address("127.0.0.1"), 0));
      auto port = acceptor.local_endpoint().port();
      std::thread server([&] {
        tcp::socket socket(server_io);
        boost::system::error_code error;
        acceptor.accept(socket, error);
        if (error)
          return;
        boost::asio::streambuf request;
        boost::asio::read_until(socket, request, "\r\n\r\n", error);
        if (error)
          return;
        const std::string reply =
            "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}";
        boost::asio::write(socket, boost::asio::buffer(reply), error);
      });
      try {
        auto result =
            http_json(relay_url("http://localhost:" + std::to_string(port)), "/health", nullptr);
        check(result.at("ok") == true, "Windows asynchronous DNS and HTTP");
      } catch (...) {
        // Wake a server still waiting in accept before joining it on failure.
        boost::system::error_code ignored;
        tcp::socket wake(server_io);
        wake.connect(tcp::endpoint(boost::asio::ip::make_address("127.0.0.1"), port), ignored);
        if (!ignored) {
          const std::string fallback = "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n";
          boost::asio::write(wake, boost::asio::buffer(fallback), ignored);
        }
        server.join();
        throw;
      }
      server.join();
    }
    check(!update_settings(Json::object()).enabled, "Windows defaults to manual upgrade");
    rejects([&] { prepare_update(Json::object(), "https://example.com", true); },
            "UPDATE_PLATFORM");
    std::filesystem::remove_all(root);
    std::cout << "PASS: Windows x64 credentials, locks, history, file policy, transfers, argv, RPC "
                 "and exit\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    std::error_code ignored;
    std::filesystem::remove_all(root, ignored);
    return 1;
  }
}
