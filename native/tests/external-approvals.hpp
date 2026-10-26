#pragma once
#include "coc/approvals.hpp"
#include <boost/beast.hpp>
#include <thread>
inline void approval_configuration_fixture(const std::string &cwd) {
  using namespace coc;
  asio::io_context io;
  auto verify = [&](Json config, const std::string &expected) {
    std::string failure;
    auto bridge = std::make_shared<ExternalApprovals>(
        io, config, "thread", cwd, [](Json) {}, [](Json) {},
        [&](bool connected, std::string message) {
          if (!connected)
            failure = std::move(message);
        });
    bridge->start();
    bridge->close();
    if (failure.find(expected) == std::string::npos)
      throw std::runtime_error("Approval configuration diagnostic missing: " + failure);
  };
  verify({{"approvalEndpoint", "https://127.0.0.1"}},
         "Approval endpoint must be a private Unix socket or loopback ws:// URL");
#ifdef _WIN32
  verify(Json::object(), "Windows requires externalSessions.approvalEndpoint=ws://");
#endif
}
// Cross-platform loopback contract: no Codex installation, model or process execution.
inline void shared_approval_fixture(const std::string &cwd) {
  using namespace coc;
  namespace beast = boost::beast;
  using tcp = asio::ip::tcp;
  asio::io_context server_io;
  tcp::acceptor acceptor(server_io, {asio::ip::make_address("127.0.0.1"), 0});
  const auto port = acceptor.local_endpoint().port();
  std::string server_error;
  bool answered = false;
  std::thread server([&] {
    try {
      beast::websocket::stream<tcp::socket> socket(server_io);
      acceptor.accept(socket.next_layer());
      socket.accept();
      for (;;) {
        beast::flat_buffer buffer;
        socket.read(buffer);
        auto message = Json::parse(beast::buffers_to_string(buffer.data()));
        auto send = [&](Json value) {
          socket.text(true);
          socket.write(asio::buffer(value.dump()));
        };
        if (!message.contains("method")) {
          if (message.at("id") != 0 || message.at("result") != Json{{"decision", "accept"}})
            throw std::runtime_error("Incorrect approval response");
          answered = true;
          send({{"method", "serverRequest/resolved"},
                {"params", {{"threadId", "shared-thread"}, {"requestId", 0}}}});
          break;
        }
        const auto method = message.at("method").get<std::string>();
        if (method == "initialized")
          continue;
        Json result = Json::object();
        if (method == "thread/read")
          result = {{"thread",
                     {{"id", "shared-thread"}, {"cwd", cwd}, {"status", {{"type", "active"}}}}}};
        else if (method == "thread/resume") {
          if (message.at("params") != Json{{"threadId", "shared-thread"}, {"excludeTurns", true}})
            throw std::runtime_error("Original thread policy must not be overridden");
        } else if (method != "initialize")
          throw std::runtime_error("Unexpected original server RPC");
        send({{"id", message.at("id")}, {"result", result}});
        if (method == "thread/resume")
          send({{"id", 0},
                {"method", "item/commandExecution/requestApproval"},
                {"params",
                 {{"threadId", "shared-thread"},
                  {"turnId", "turn"},
                  {"itemId", "item"},
                  {"command", "echo shared-fixture"},
                  {"availableDecisions", Json::array({"accept", "decline"})}}}});
      }
      boost::system::error_code ignored;
      socket.next_layer().shutdown(tcp::socket::shutdown_both, ignored);
      socket.next_layer().close(ignored);
    } catch (const std::exception &error) {
      server_error = error.what();
    }
  });
  asio::io_context io;
  asio::steady_timer deadline(io, std::chrono::seconds(10));
  std::shared_ptr<ExternalApprovals> bridge;
  std::string failure;
  bool resolved = false;
  auto end = [&] {
    bridge->close();
    deadline.cancel();
    io.stop();
  };
  bridge = std::make_shared<ExternalApprovals>(
      io, Json{{"approvalEndpoint", "ws://127.0.0.1:" + std::to_string(port)}}, "shared-thread",
      cwd, [&](Json approval) { bridge->answer(approval.at("approvalId"), true); },
      [&](Json) {
        resolved = true;
        end();
      },
      [&](bool connected, std::string error) {
        if (!connected) {
          failure = error;
          end();
        }
      });
  deadline.async_wait([&](auto error) {
    if (!error) {
      failure = "Approval fixture timed out";
      end();
    }
  });
  bridge->start();
  io.run();
  bridge->close();
  server.join();
  if (!failure.empty() || !server_error.empty() || !answered || !resolved)
    throw std::runtime_error("Shared approval fixture: " + failure + " " + server_error);
}
