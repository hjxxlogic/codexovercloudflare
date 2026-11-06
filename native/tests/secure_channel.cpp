#include "coc/secure_channel.hpp"
#include <iostream>
int main(int argc, char **) {
  try {
    if (argc > 1) {
      coc::SecureChannel channel(false, "coc-channel-1:interop");
      std::cout << coc::Json{{"key", channel.public_key()}}.dump() << std::endl;
      for (std::string line; std::getline(std::cin, line);) {
        try {
          auto request = coc::Json::parse(line);
          coc::Json reply;
          if (request.contains("key"))
            reply["header"] = channel.exchange(request.at("key"));
          if (request.contains("header")) {
            channel.accept(request.at("header"));
            reply["ready"] = channel.ready();
          }
          if (request.contains("cipher"))
            reply["plain"] = channel.open(request.at("cipher"));
          if (request.contains("plain"))
            reply["cipher"] = channel.seal(request.at("plain"));
          std::cout << reply.dump() << std::endl;
        } catch (const std::exception &) {
          std::cout << "{\"failed\":true}" << std::endl;
        }
      }
      return 0;
    }
    coc::SecureChannel a(true, "binding"), b(false, "binding");
    auto ah = a.exchange(b.public_key()), bh = b.exchange(a.public_key());
    a.accept(bh);
    b.accept(ah);
    auto cipher = a.seal("sensitive utf8: 中文");
    if (b.open(cipher) != "sensitive utf8: 中文" || a.open(b.seal("reply")) != "reply")
      return 1;
    bool refused = false;
    try {
      b.open(cipher);
    } catch (...) {
      refused = true;
    }
    if (!refused || b.ready())
      return 2;
    coc::SecureChannel c(true, "one"), d(false, "two");
    auto ch = c.exchange(d.public_key()), dh = d.exchange(c.public_key());
    c.accept(dh);
    d.accept(ch);
    refused = false;
    try {
      d.open(c.seal("wrong binding"));
    } catch (...) {
      refused = true;
    }
    if (!refused)
      return 3;
    std::cout << "Encrypted channel roundtrip, replay and binding checks passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
