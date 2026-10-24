#pragma once
#include "common.hpp"
#include <arpa/inet.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>
namespace coc {
inline void verify_tls_hostname(SSL *ssl, const std::string &host) {
  unsigned char address[16];
  const bool ip = inet_pton(AF_INET, host.c_str(), address) == 1 ||
                  inet_pton(AF_INET6, host.c_str(), address) == 1;
  // OpenSSL's verifier prefers SAN and never falls back to CN when DNS SAN exists.
  const int ok = ip ? X509_VERIFY_PARAM_set1_ip_asc(SSL_get0_param(ssl), host.c_str())
                    : SSL_set1_host(ssl, host.c_str());
  if (ok != 1 || SSL_set_tlsext_host_name(ssl, host.c_str()) != 1)
    throw Error("TLS_ERROR", "Cannot configure TLS peer identity");
}
} // namespace coc
