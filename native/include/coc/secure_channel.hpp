#pragma once
#include "common.hpp"
#include <array>
#include <sodium.h>
namespace coc {
std::vector<std::string> secure_fragments(const Json &);
// One instance per physical link. Worker authenticates the public-key binding;
// only endpoints own the ephemeral secret keys and ordered stream states.
class SecureChannel {
  std::array<unsigned char, crypto_kx_PUBLICKEYBYTES> public_{};
  std::array<unsigned char, crypto_kx_SECRETKEYBYTES> secret_{};
  std::array<unsigned char, crypto_kx_SESSIONKEYBYTES> rx_{}, tx_{};
  crypto_secretstream_xchacha20poly1305_state push_{}, pull_{};
  std::string binding_;
  bool client_, exchanged_ = false, sending_ = false, receiving_ = false, failed_ = false;
  [[noreturn]] void fail();

public:
  SecureChannel(bool client, std::string binding);
  ~SecureChannel();
  SecureChannel(const SecureChannel &) = delete;
  SecureChannel &operator=(const SecureChannel &) = delete;
  void binding(std::string value) {
    if (receiving_ || value.empty() || value.size() > 4096)
      fail();
    binding_ = std::move(value);
  }
  std::string public_key() const;
  std::string exchange(const std::string &peer);
  void accept(const std::string &header);
  std::string seal(const std::string &plain);
  std::string open(const std::string &cipher);
  bool ready() const { return sending_ && receiving_ && !failed_; }
};
} // namespace coc
