#pragma once
#include "common.hpp"
#include <boost/asio/ssl.hpp>
#ifdef _WIN32
#include <wincrypt.h>
#undef X509_NAME
#undef X509_EXTENSIONS
#undef X509_CERT_PAIR
#undef PKCS7_ISSUER_AND_SERIAL
#undef OCSP_REQUEST
#undef OCSP_RESPONSE
#else
#include <arpa/inet.h>
#endif
#include <openssl/ssl.h>
#include <openssl/x509v3.h>
namespace coc {
inline void configure_trust(boost::asio::ssl::context &context) {
  context.set_default_verify_paths();
#ifdef _WIN32
  auto roots = CertOpenSystemStoreW(0, L"ROOT");
  if (!roots)
    throw Error("TLS_ERROR", "Cannot open Windows trusted roots");
  auto store = SSL_CTX_get_cert_store(context.native_handle());
  PCCERT_CONTEXT certificate = nullptr;
  while ((certificate = CertEnumCertificatesInStore(roots, certificate))) {
    const unsigned char *bytes = certificate->pbCertEncoded;
    auto decoded = d2i_X509(nullptr, &bytes, certificate->cbCertEncoded);
    if (decoded) {
      X509_STORE_add_cert(store, decoded);
      X509_free(decoded);
    }
  }
  CertCloseStore(roots, 0);
  ERR_clear_error();
#endif
}
inline void verify_tls_hostname(SSL *ssl, const std::string &host) {
  boost::system::error_code error;
  boost::asio::ip::make_address(host, error);
  const bool ip = !error;
  // OpenSSL's verifier prefers SAN and never falls back to CN when DNS SAN exists.
  const int ok = ip ? X509_VERIFY_PARAM_set1_ip_asc(SSL_get0_param(ssl), host.c_str())
                    : SSL_set1_host(ssl, host.c_str());
  if (ok != 1 || SSL_set_tlsext_host_name(ssl, host.c_str()) != 1)
    throw Error("TLS_ERROR", "Cannot configure TLS peer identity");
}
} // namespace coc
