#include "coc/terminal.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <openssl/evp.h>
using namespace coc;
namespace {
void check(bool value, const std::string &message) {
  if (!value)
    throw std::runtime_error(message);
}
std::string b64(const std::string &s) {
  std::string out(4 * ((s.size() + 2) / 3), '\0');
  EVP_EncodeBlock(reinterpret_cast<unsigned char *>(&out[0]),
                  reinterpret_cast<const unsigned char *>(s.data()), int(s.size()));
  return out;
}
std::string text(const std::string &s) {
  if (s.empty())
    return "";
  std::string out(s.size(), '\0');
  int count = EVP_DecodeBlock(reinterpret_cast<unsigned char *>(&out[0]),
                              reinterpret_cast<const unsigned char *>(s.data()), int(s.size()));
  if (s.back() == '=')
    --count;
  if (s.size() > 1 && s[s.size() - 2] == '=')
    --count;
  out.resize(size_t(count));
  return out;
}
template <class F> void rejects(F run, const std::string &code) {
  try {
    run();
  } catch (const Error &error) {
    check(error.code == code, error.what());
    return;
  }
  throw std::runtime_error("Expected " + code);
}
} // namespace
int main() {
  try {
    boost::asio::io_context io;
    Terminals disabled(io, {{"sandbox", "workspace-write"}});
    check(disabled.metadata().at("enabled") == false, "Terminal must default off");
    Terminals terminals(io, {{"sandbox", "workspace-write"}, {"terminal", {{"enabled", true}}}});
#ifndef __linux__
    check(terminals.metadata().at("enabled") == false, "Unsupported platforms must fail closed");
#else
    if (!terminals.metadata().at("enabled").get<bool>()) {
      std::cout << "SKIP: install root-owned /usr/bin/bwrap for Linux PTY integration\n";
      return 77;
    }
    const auto root = std::filesystem::temp_directory_path() / ("coc-terminal-" + uuid());
    std::filesystem::create_directory(root);
    const auto secret = root.parent_path() / ("coc-terminal-secret-" + uuid());
    {
      std::ofstream file(secret);
      file << "HOST_SECRET";
    }
    std::filesystem::create_symlink(secret, root / "escape");
    Json base = {{"projectId", "project"},
                 {"sessionId", "host~session"},
                 {"owner", std::string(64, 'a')},
                 {"control", {{"controlId", "controller"}}}};
    auto call = [&](Json data) {
      auto request = base;
      request.update(data);
      return terminals.request(request, root.u8string());
    };
    const auto opened = call({{"operation", "open"}, {"cols", 90}, {"rows", 30}});
    base["terminalId"] = opened.at("terminalId");
    std::string output;
    int64_t offset = 0;
    auto until = [&](auto condition, int seconds = 10) {
      const auto deadline = now() + seconds * 1000;
      while (!condition()) {
        check(now() < deadline, "Terminal integration timed out: " + output.substr(0, 2000));
        io.restart();
        io.run_for(std::chrono::milliseconds(20));
      }
    };
    bool exited = false, gap = false;
    int exit_code = -1;
    auto receive = [&](Json frame) {
      if (frame.at("type") == "output") {
        output += text(frame.at("data"));
        offset = frame.at("offset");
        gap = gap || frame.at("gap").get<bool>();
      } else if (frame.at("type") == "exit") {
        exited = true;
        exit_code = frame.at("exitCode");
      }
    };
    auto stream = [&](Json frame) { terminals.stream(base, "test", frame, receive); };
    auto drain = [&]() { stream({{"type", "ack"}, {"offset", offset}}); };
    stream({{"type", "bind"}, {"offset", 0}});
    for (const auto *operation : {"read", "input", "resize"})
      rejects([&] { call({{"operation", operation}}); }, "UPGRADE_REQUIRED");
    const auto input =
        Json{{"type", "input"},
             {"seq", 1},
             {"data", b64("printf 'CW_%s\\n' READY; pwd; test ! -e /workspace/escape && printf "
                          "'CW_%s\\n' ISOLATED; printf 'ONE\\n' >> count\n")}};
    stream(input);
    stream(input); // Same runtime sequence cannot execute twice.
    until([&] {
      drain();
      return output.find("CW_ISOLATED\r\n") != std::string::npos;
    });
    check(output.find("/workspace\r\n") != std::string::npos,
          "Terminal must start in isolated project mount");
    std::ifstream count(root / "count");
    std::string line, extra;
    std::getline(count, line);
    std::getline(count, extra);
    check(line == "ONE" && extra.empty(), "Duplicate input executed twice");
    auto other = base;
    other["owner"] = std::string(64, 'b');
    other["operation"] = "close";
    rejects([&] { terminals.request(other, root.u8string()); }, "FORBIDDEN");
    rejects([&] { stream({{"type", "input"}, {"seq", 1}, {"data", b64("echo different\n")}}); },
            "TERMINAL_INPUT_ORDER");
    stream({{"type", "resize"}, {"seq", 2}, {"cols", 100}, {"rows", 35}});
    stream({{"type", "input"}, {"seq", 3}, {"data", b64("stty size; sleep 30\n")}});
    until([&] {
      drain();
      return output.find("35 100\r\n") != std::string::npos;
    });
    stream({{"type", "input"}, {"seq", 4}, {"data", b64(std::string(1, '\3'))}});
    stream({{"type", "input"}, {"seq", 5}, {"data", b64("printf 'CW_%s\\n' INTERRUPTED\n")}});
    until([&] {
      drain();
      return output.find("CW_INTERRUPTED\r\n") != std::string::npos;
    });
    rejects([&] { stream({{"type", "input"}, {"seq", 0}, {"data", b64("x")}}); },
            "INVALID_REQUEST");
    rejects([&] { stream({{"type", "input"}, {"seq", 6}, {"data", b64(std::string(4097, 'x'))}}); },
            "INVALID_REQUEST");
    stream({{"type", "input"},
            {"seq", 6},
            {"data", b64("head -c 350000 /dev/zero | tr '\\0' x; echo done > gap-done\n")}});
    // Detached output is bounded; rebinding exposes discarded bytes explicitly.
    terminals.detach("test");
    until([&] { return std::filesystem::exists(root / "gap-done"); });
    io.restart();
    io.run_for(std::chrono::milliseconds(100));
    stream({{"type", "bind"}, {"offset", 0}});
    check(gap, "Terminal output ring must expose dropped bytes");
    stream({{"type", "input"}, {"seq", 7}, {"data", b64("exit 7\n")}});
    until([&] {
      drain();
      return exited;
    });
    check(exit_code == 7, "Terminal exit code lost");
    check(!terminals.busy("project"), "Exited terminal holds project lock");
    // A second terminal is torn down by session closure, including its children.
    auto fresh = base;
    fresh.erase("terminalId");
    fresh["operation"] = "open";
    const auto second = terminals.request(fresh, root.u8string());
    base["terminalId"] = second.at("terminalId");
    offset = 0;
    exited = false;
    stream({{"type", "bind"}, {"offset", 0}});
    terminals.close_session("host~session");
    until([&] {
      drain();
      return exited;
    });
    std::filesystem::remove_all(root);
    std::filesystem::remove(secret);
#endif
    std::cout << "Terminal sandbox, PTY, deduplication, resize, interrupt and cleanup passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
