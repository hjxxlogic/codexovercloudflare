#pragma once
#include "coc/proxy.hpp"
#include "coc/tui_bridge.hpp"
#include <boost/beast.hpp>
#include <iostream>
#include <thread>
namespace coc {
inline void proxy_tests() {
  namespace beast = boost::beast;
  namespace http = beast::http;
  using tcp = asio::ip::tcp;
  const auto require = [](bool ok) {
    if (!ok)
      throw std::runtime_error("Proxy contract failed");
  };
  for (const auto &ip :
       {"127.0.0.2", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.2", "169.254.1.2",
        "100.64.0.1", "::1", "fe80::1", "fd01::1", "::ffff:192.168.1.2"})
    require(local_address(asio::ip::make_address(ip)));
  for (const auto &ip : {"172.15.0.1", "172.32.0.1", "8.8.8.8", "2001:4860::8888"})
    require(!local_address(asio::ip::make_address(ip)));
  for (const auto &url :
       {"https://proxy:443", "socks4://proxy:1080", "http://proxy:0", "http://proxy:65536",
        "http://u:%0d%0a@proxy:80", "socks5://u:@proxy:1080"}) {
    bool rejected = false;
    try {
      configure_proxy(url);
    } catch (const Error &e) {
      rejected = e.code == "CONFIG_ERROR";
    }
    require(rejected);
  }
  require(display_name("  办公室电脑  ") == "办公室电脑");
  for (const auto &name : {"", "  ", "bad\nname"}) {
    bool rejected = false;
    try {
      display_name(name);
    } catch (const Error &) {
      rejected = true;
    }
    require(rejected);
  }
  require(remote_address(relay_url("https://r.xlogic.cc"), "/test") ==
          "wss://r.xlogic.cc:443/test");
  require(remote_address(relay_url("https://[::1]"), "/test") == "wss://[::1]:443/test");
  require(remote_address(relay_url("http://localhost:8787"), "/test") ==
          "ws://localhost:8787/test");
  Url target{"http://203.0.113.10", "203.0.113.10", "203.0.113.10", "443", false};
  // A deterministic proxy peer terminates the tunnel locally; no external traffic.
  for (unsigned scenario : {0, 1, 2, 3})
    for (bool auth : {false, true})
      for (bool ws : {false, true}) {
        const bool domain = scenario >= 2, socks = scenario % 2;
        // Construct a plain transport target directly, as in the original IP test.
        const std::string host = domain ? "relay.invalid" : "203.0.113.10";
        const Url target{"http://" + host, host, host, "443", false};
        std::cout << "RUN: proxy domain=" << domain << " " << (socks ? "SOCKS5" : "HTTP")
                  << " auth=" << auth << " ws=" << ws << std::endl;
        asio::io_context server_io;
        tcp::acceptor acceptor(server_io, {asio::ip::address_v4::loopback(), 0});
        auto credentials = auth ? "user:p%40ss@" : "";
        configure_proxy(std::string(socks ? "socks5://" : "http://") + credentials +
                        "127.0.0.1:" + std::to_string(acceptor.local_endpoint().port()));
        require(proxy_route(target).has_value());
        for (const auto &host :
             {"10.1.2.3", "127.0.0.1", "[::1]", "[fd01::1]", "localhost", "LOCALHOST."})
          require(!proxy_route(relay_url(std::string("https://") + host)));
        struct Journals {
          std::string path =
              (std::filesystem::temp_directory_path() / ("coc-proxy-" + uuid())).u8string();
          ~Journals() { std::filesystem::remove_all(path); }
        } journals;
        std::exception_ptr failure;
        std::thread server([&] {
          try {
            tcp::socket socket(server_io);
            acceptor.accept(socket);
            beast::flat_buffer buffer;
            const auto read = [&](size_t size) {
              std::vector<unsigned char> bytes(size);
              asio::read(socket, asio::buffer(bytes));
              return bytes;
            };
            const auto send = [&](std::initializer_list<unsigned char> bytes) {
              std::vector<unsigned char> data(bytes);
              // Fragment replies to exercise exact reads across packet boundaries.
              for (auto byte : data)
                asio::write(socket, asio::buffer(&byte, 1));
            };
            if (socks) {
              auto greeting = read(3);
              require(greeting ==
                      std::vector<unsigned char>({5, 1, static_cast<unsigned char>(auth ? 2 : 0)}));
              send({5, static_cast<unsigned char>(auth ? 2 : 0)});
              if (auth) {
                require(read(2) == std::vector<unsigned char>({1, 4}));
                auto user = read(4);
                require(std::string(user.begin(), user.end()) == "user");
                require(read(1)[0] == 4);
                auto pass = read(4);
                require(std::string(pass.begin(), pass.end()) == "p@ss");
                send({1, 0});
              }
              if (domain) {
                require(read(5) == std::vector<unsigned char>({5, 1, 0, 3, 13}));
                const auto host = read(13);
                require(std::string(host.begin(), host.end()) == "relay.invalid");
                require(read(2) == std::vector<unsigned char>({1, 187}));
              } else
                require(read(10) ==
                        std::vector<unsigned char>({5, 1, 0, 1, 203, 0, 113, 10, 1, 187}));
              send({5, 0, 0, 1, 127, 0, 0, 1, 0, 0});
            } else {
              http::request<http::empty_body> request;
              http::read(socket, buffer, request);
              require(request.method() == http::verb::connect &&
                      request.target() == target.host + ":443");
              require(request[http::field::authorization].empty());
              require(request[http::field::proxy_authorization] ==
                      (auth ? "Basic dXNlcjpwQHNz" : ""));
              std::string reply = "HTTP/1.1 200 Connection Established\r\n\r\n";
              asio::write(socket, asio::buffer(reply));
            }
            http::request<http::string_body> request;
            http::read(socket, buffer, request);
            require(request[http::field::host] == target.authority);
            require(request[http::field::authorization] == "Bearer target-token");
            require(request[http::field::proxy_authorization].empty());
            if (ws) {
              beast::websocket::stream<tcp::socket> websocket(std::move(socket));
              websocket.accept(request);
              const auto transmit = [&](const Json &value) {
                websocket.write(asio::buffer(value.dump()));
              };
              boost::system::error_code ignored;
              if (auth) {
                Store receiver(journals.path + "/receiver");
                const Json control = {{"controlEpoch", 1},
                                      {"connectionGeneration", 1},
                                      {"controlId", "proxy-claim"},
                                      {"owner", "proxy-owner"}};
                transmit({{"type", "delivery-ready"},
                          {"delivery", 2},
                          {"instance", receiver.delivery_instance()},
                          {"controller", "proxy-controller"},
                          {"control", control}});
                websocket.read(buffer);
                const auto opening = Json::parse(beast::buffers_to_string(buffer.data()));
                buffer.consume(buffer.size());
                require(opening.at("type") == "delivery-open");
                for (const auto &lane : {"normal", "priority"}) {
                  const auto window =
                      receiver.delivery_open(opening.at("stream").get<std::string>() + "_" + lane,
                                             "proxy-session", 4, max_frame, lane);
                  auto ready = control;
                  ready["instance"] = receiver.delivery_instance();
                  ready["exchangeId"] = opening.at("exchangeId");
                  transmit({{"type", "delivery-window"},
                            {"lane", lane},
                            {"window", window},
                            {"exchangeId", opening.at("exchangeId")},
                            {"controlReady", ready}});
                }
                transmit({{"type", "hello"}});
                Json request;
                do {
                  websocket.read(buffer);
                  request = Json::parse(beast::buffers_to_string(buffer.data()));
                  buffer.consume(buffer.size());
                } while (request.value("type", "") == "delivery-output");
                require(request.at("method") == "model/list" && request.at("id") == 7);
                const auto body = Json{{"id", 7}, {"result", {{"ack", true}}}}.dump();
                transmit(
                    {{"type", "delivery-data"}, {"seq", 1}, {"end", body.size()}, {"body", body}});
                do {
                  websocket.read(buffer, ignored);
                  buffer.consume(buffer.size());
                } while (!ignored);
              } else {
                transmit({{"type", "hello"}});
                websocket.read(buffer, ignored);
              }
            } else {
              http::response<http::string_body> response{http::status::ok, 11};
              response.body() = "{\"ok\":true}";
              response.prepare_payload();
              http::write(socket, response);
            }
          } catch (...) {
            failure = std::current_exception();
          }
        });
        std::exception_ptr client_failure;
        try {
          if (!ws)
            require(http_json(target, "/test", nullptr, "target-token").at("ok") == true);
          else {
            asio::io_context io;
            bool received = false;
            std::shared_ptr<Socket> connection;
            if (auth) {
              Store sender(journals.path + "/sender", false);
              TuiBridge bridge(io, target, "target-token", "/ws/v1/cli/session", sender);
              std::exception_ptr local_failure;
              std::thread tui([&] {
                try {
                  auto port = bridge.url();
                  port = port.substr(std::string("ws://127.0.0.1:").size());
                  port.pop_back();
                  asio::io_context local_io;
                  tcp::resolver resolver(local_io);
                  // An unauthenticated local process cannot claim the tunnel.
                  {
                    beast::websocket::stream<tcp::socket> unauthorized(local_io);
                    asio::connect(unauthorized.next_layer(), resolver.resolve("127.0.0.1", port));
                    boost::system::error_code ec;
                    unauthorized.handshake("127.0.0.1", "/", ec);
                    require(bool(ec));
                  }
                  beast::websocket::stream<tcp::socket> websocket(local_io);
                  asio::connect(websocket.next_layer(), resolver.resolve("127.0.0.1", port));
                  websocket.set_option(beast::websocket::stream_base::decorator([](auto &request) {
                    request.set(http::field::authorization, "Bearer target-token");
                  }));
                  websocket.handshake("127.0.0.1", "/");
                  beast::flat_buffer buffer;
                  websocket.read(buffer);
                  received =
                      Json::parse(beast::buffers_to_string(buffer.data())).at("type") == "hello";
                  buffer.consume(buffer.size());
                  websocket.write(asio::buffer(
                      std::string("{\"id\":7,\"method\":\"model/list\",\"params\":{}}")));
                  websocket.read(buffer);
                  require(
                      Json::parse(beast::buffers_to_string(buffer.data())).at("result").at("ack") ==
                      true);
                  boost::system::error_code ignored;
                  websocket.next_layer().close(ignored);
                } catch (...) {
                  local_failure = std::current_exception();
                  asio::post(io, [&] { io.stop(); });
                }
              });
              io.run();
              tui.join();
              if (local_failure)
                std::rethrow_exception(local_failure);
            } else {
              connection = connect_socket(
                  io, target, "target-token",
                  [&](Json message) {
                    received = message.at("type") == "hello";
                    connection->close();
                  },
                  [](unsigned) {});
              connection->start();
              io.run();
            }
            require(received);
          }
        } catch (...) {
          client_failure = std::current_exception();
        }
        server.join();
        if (failure)
          std::rethrow_exception(failure);
        if (client_failure)
          std::rethrow_exception(client_failure);
      }
  for (bool socks : {false, true})
    for (bool stall : {false, true}) {
      asio::io_context server_io;
      tcp::acceptor acceptor(server_io, {asio::ip::address_v4::loopback(), 0});
      configure_proxy(std::string(socks ? "socks5://" : "http://") +
                      "127.0.0.1:" + std::to_string(acceptor.local_endpoint().port()));
      std::exception_ptr failure;
      std::thread server([&] {
        try {
          tcp::socket socket(server_io);
          acceptor.accept(socket);
          if (socks) {
            std::array<unsigned char, 3> greeting{};
            asio::read(socket, asio::buffer(greeting));
            require(greeting[0] == 5);
            if (!stall) {
              std::array<unsigned char, 2> rejected{{5, 255}};
              asio::write(socket, asio::buffer(rejected));
            }
          } else {
            beast::flat_buffer buffer;
            http::request<http::empty_body> request;
            http::read(socket, buffer, request);
            require(request[http::field::authorization].empty());
            if (!stall) {
              std::string denied =
                  "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n";
              asio::write(socket, asio::buffer(denied));
            }
          }
          // Refused or stalled proxies must not receive target application data.
          std::array<char, 1> byte{};
          boost::system::error_code ec;
          require(socket.read_some(asio::buffer(byte), ec) == 0 && bool(ec));
        } catch (...) {
          failure = std::current_exception();
        }
      });
      bool rejected = false;
      try {
        http_json(target, "/test", nullptr, "target-token", "", std::chrono::milliseconds(200));
      } catch (const Error &e) {
        rejected = e.code == (stall ? "HTTP_TIMEOUT" : "HTTP_NETWORK");
      }
      server.join();
      if (failure)
        std::rethrow_exception(failure);
      require(rejected);
    }
  configure_proxy("");
  require(!proxy_route(relay_url("https://relay.invalid")));
}
} // namespace coc
