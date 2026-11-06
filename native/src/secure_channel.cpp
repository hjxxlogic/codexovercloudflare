#include "coc/secure_channel.hpp"
namespace coc {
std::vector<std::string> secure_fragments(const Json &packet) {
  const auto text = packet.dump();
  if (text.size() > max_queue)
    throw Error("BACKPRESSURE", "Endpoint message exceeds budget");
  std::vector<std::string> parts;
  for (size_t start = 0; start < text.size();) {
    size_t end = std::min(start + 64 * 1024, text.size());
    // libsodium's browser wrapper decodes each chunk as UTF-8.
    while (end < text.size() && (static_cast<unsigned char>(text[end]) & 0xc0) == 0x80)
      --end;
    parts.push_back(std::string(end == text.size() ? "1" : "0") + text.substr(start, end - start));
    start = end;
  }
  return parts;
}

namespace {
std::string encode(const unsigned char *bytes, size_t size) {
  std::string output(sodium_base64_ENCODED_LEN(size, sodium_base64_VARIANT_ORIGINAL), '\0');
  sodium_bin2base64(output.data(), output.size(), bytes, size, sodium_base64_VARIANT_ORIGINAL);
  output.resize(output.find('\0'));
  return output;
}
std::string decode(const std::string &text, size_t limit) {
  if (text.size() > sodium_base64_ENCODED_LEN(limit, sodium_base64_VARIANT_ORIGINAL))
    throw Error("SECURE_CHANNEL_FAILED", "Invalid encrypted channel record");
  std::string output(text.size(), '\0');
  size_t size = 0;
  const char *end = nullptr;
  if (sodium_base642bin(reinterpret_cast<unsigned char *>(output.data()), output.size(),
                        text.data(), text.size(), nullptr, &size, &end,
                        sodium_base64_VARIANT_ORIGINAL) ||
      end != text.data() + text.size() || size > limit)
    throw Error("SECURE_CHANNEL_FAILED", "Invalid encrypted channel record");
  output.resize(size);
  return output;
}
} // namespace
SecureChannel::SecureChannel(bool client, std::string binding)
    : binding_(std::move(binding)), client_(client) {
  if (sodium_init() < 0 || binding_.empty() || binding_.size() > 4096)
    fail();
  crypto_kx_keypair(public_.data(), secret_.data());
}
SecureChannel::~SecureChannel() {
  sodium_memzero(secret_.data(), secret_.size());
  sodium_memzero(rx_.data(), rx_.size());
  sodium_memzero(tx_.data(), tx_.size());
  sodium_memzero(&push_, sizeof push_);
  sodium_memzero(&pull_, sizeof pull_);
}
[[noreturn]] void SecureChannel::fail() {
  failed_ = true;
  throw Error("SECURE_CHANNEL_FAILED", "Encrypted channel authentication failed");
}
std::string SecureChannel::public_key() const { return encode(public_.data(), public_.size()); }
std::string SecureChannel::exchange(const std::string &peer) {
  try {
    if (failed_ || exchanged_)
      fail();
    const auto bytes = decode(peer, crypto_kx_PUBLICKEYBYTES);
    if (bytes.size() != crypto_kx_PUBLICKEYBYTES)
      fail();
    const auto p = reinterpret_cast<const unsigned char *>(bytes.data());
    const auto status = client_ ? crypto_kx_client_session_keys(rx_.data(), tx_.data(),
                                                                public_.data(), secret_.data(), p)
                                : crypto_kx_server_session_keys(rx_.data(), tx_.data(),
                                                                public_.data(), secret_.data(), p);
    if (status)
      fail();
    exchanged_ = true;
    sodium_memzero(secret_.data(), secret_.size());
    std::array<unsigned char, crypto_secretstream_xchacha20poly1305_HEADERBYTES> header{};
    if (crypto_secretstream_xchacha20poly1305_init_push(&push_, header.data(), tx_.data()))
      fail();
    sodium_memzero(tx_.data(), tx_.size());
    sending_ = true;
    return encode(header.data(), header.size());
  } catch (...) {
    failed_ = true;
    throw;
  }
}
void SecureChannel::accept(const std::string &header) {
  try {
    if (failed_ || !exchanged_ || receiving_)
      fail();
    const auto bytes = decode(header, crypto_secretstream_xchacha20poly1305_HEADERBYTES);
    if (bytes.size() != crypto_secretstream_xchacha20poly1305_HEADERBYTES ||
        crypto_secretstream_xchacha20poly1305_init_pull(
            &pull_, reinterpret_cast<const unsigned char *>(bytes.data()), rx_.data()))
      fail();
    sodium_memzero(rx_.data(), rx_.size());
    receiving_ = true;
  } catch (...) {
    failed_ = true;
    throw;
  }
}
std::string SecureChannel::seal(const std::string &plain) {
  if (!ready() || plain.size() > 128 * 1024)
    fail();
  std::string bytes(plain.size() + crypto_secretstream_xchacha20poly1305_ABYTES, '\0');
  unsigned long long size = 0;
  if (crypto_secretstream_xchacha20poly1305_push(
          &push_, reinterpret_cast<unsigned char *>(bytes.data()), &size,
          reinterpret_cast<const unsigned char *>(plain.data()), plain.size(),
          reinterpret_cast<const unsigned char *>(binding_.data()), binding_.size(),
          crypto_secretstream_xchacha20poly1305_TAG_MESSAGE))
    fail();
  return encode(reinterpret_cast<const unsigned char *>(bytes.data()), size);
}
std::string SecureChannel::open(const std::string &cipher) {
  try {
    if (!ready())
      fail();
    const auto bytes = decode(cipher, 128 * 1024 + crypto_secretstream_xchacha20poly1305_ABYTES);
    if (bytes.size() < crypto_secretstream_xchacha20poly1305_ABYTES)
      fail();
    std::string plain(bytes.size(), '\0');
    unsigned long long size = 0;
    unsigned char tag = 0;
    if (crypto_secretstream_xchacha20poly1305_pull(
            &pull_, reinterpret_cast<unsigned char *>(plain.data()), &size, &tag,
            reinterpret_cast<const unsigned char *>(bytes.data()), bytes.size(),
            reinterpret_cast<const unsigned char *>(binding_.data()), binding_.size()) ||
        tag != crypto_secretstream_xchacha20poly1305_TAG_MESSAGE)
      fail();
    plain.resize(size);
    return plain;
  } catch (...) {
    failed_ = true;
    throw;
  }
}
} // namespace coc
