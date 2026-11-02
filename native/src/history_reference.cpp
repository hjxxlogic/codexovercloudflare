#include "coc/credit.hpp"
#include "coc/delivery.hpp"
#include <memory>
#include <openssl/evp.h>
#include <regex>
namespace coc {
Json history_reference_descriptor(const Json &value) {
  static const std::regex digest("^[a-f0-9]{64}$");
  if (!value.is_object() || !value.contains("type") || !value.at("type").is_string() ||
      !value.contains("retention") || !value.at("retention").is_string() ||
      value.at("type") != "delivery-content" || value.at("retention") != "history")
    throw Error("INVALID_REQUEST", "Invalid history reference");
  for (const auto &key : {"agentInstance", "sessionId", "contentId", "digest"})
    if (!value.contains(key) || !value.at(key).is_string())
      throw Error("INVALID_REQUEST", "Invalid history reference identity");
  const auto session = value.at("sessionId").get<std::string>();
  static const std::regex session_id("^[a-zA-Z0-9_-]{1,100}~[a-zA-Z0-9_-]{1,100}$");
  if (!valid_id(value.at("agentInstance")) || !std::regex_match(session, session_id) ||
      !std::regex_match(value.at("digest").get<std::string>(), digest) ||
      value.at("contentId") != value.at("digest"))
    throw Error("INVALID_REQUEST", "Invalid history reference identity");
  for (const auto &key : {"seq", "revision", "length"})
    if (!value.contains(key) || !value.at(key).is_number_integer() ||
        value.at(key) < -9007199254740991LL || value.at(key) > 9007199254740991LL)
      throw Error("INVALID_REQUEST", "Invalid history reference counter");
  if (value.at("revision") < 0 || value.at("length") < 0 ||
      value.at("length") > credit::history_reference_bytes)
    throw Error("INVALID_REQUEST", "Invalid history reference size or revision");
  return value;
}
Json Store::history_reference(const std::string &id, int64_t seq) {
  const auto rows =
      query("SELECT revision,recovery FROM history WHERE session=? AND seq=?", {id, seq});
  if (rows.empty())
    throw Error("CONTENT_UNAVAILABLE", "Original history content is unavailable");
  const auto revision = rows.at(0).at("revision").get<int64_t>();
  if (!rows.at(0).at("recovery").is_null()) {
    const auto proof = Json::parse(rows.at(0).at("recovery").get<std::string>());
    return history_reference_descriptor({{"type", "delivery-content"},
                                         {"retention", "history"},
                                         {"agentInstance", delivery_instance_},
                                         {"sessionId", id},
                                         {"seq", seq},
                                         {"revision", revision},
                                         {"length", proof.at("length")},
                                         {"digest", proof.at("digest")},
                                         {"contentId", proof.at("digest")}});
  }
  std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> hash(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  if (!hash || EVP_DigestInit_ex(hash.get(), EVP_sha256(), nullptr) != 1)
    throw Error("STORAGE_ERROR", "Cannot initialize history content digest");
  int64_t offset = 0, bytes = 0;
  while (true) {
    const auto part = content(id, seq, offset, revision);
    const auto text = part.at("text").get<std::string>();
    bytes += static_cast<int64_t>(text.size());
    if (bytes > credit::history_reference_bytes)
      throw Error("BACKPRESSURE", "History reference exceeds content budget");
    if (EVP_DigestUpdate(hash.get(), text.data(), text.size()) != 1)
      throw Error("STORAGE_ERROR", "Cannot hash history content");
    if (!part.at("more").get<bool>())
      break;
    const auto next = part.at("nextOffset").get<int64_t>();
    if (next <= offset)
      throw Error("CONTENT_UNAVAILABLE", "Original history content is incomplete");
    offset = next;
  }
  unsigned char digest[EVP_MAX_MD_SIZE];
  unsigned length = 0;
  if (EVP_DigestFinal_ex(hash.get(), digest, &length) != 1 || length != 32)
    throw Error("STORAGE_ERROR", "Cannot finalize history content digest");
  const char hex[] = "0123456789abcdef";
  std::string encoded;
  for (unsigned n = 0; n < length; ++n) {
    encoded += hex[digest[n] >> 4];
    encoded += hex[digest[n] & 15];
  }
  return {{"type", "delivery-content"},
          {"retention", "history"},
          {"agentInstance", delivery_instance_},
          {"sessionId", id},
          {"seq", seq},
          {"revision", revision},
          {"length", bytes},
          {"contentId", encoded},
          {"digest", encoded}};
}
Json Store::history_content(const std::string &id, const Json &input, int64_t offset) {
  const auto reference = history_reference_descriptor(input);
  if (reference.at("sessionId") != id)
    throw Error("FORBIDDEN", "History reference belongs to another session");
  if (reference.at("agentInstance") != delivery_instance_)
    throw Error("DELIVERY_STATE_MISMATCH", "History reference belongs to another Agent store");
  try {
    const auto proof =
        query("SELECT recovery FROM history WHERE session=? AND seq=?", {id, reference.at("seq")});
    if (!proof.empty() && !proof.at(0).at("recovery").is_null() &&
        history_reference(id, reference.at("seq")) != reference)
      throw Error("CONTENT_UNAVAILABLE", "History reference does not match original durable proof");
    return content(id, reference.at("seq"), offset, reference.at("revision"));
  } catch (const Error &error) {
    if (error.code == "CONTENT_NOT_FOUND" || error.code == "CONTENT_CHANGED")
      throw Error("CONTENT_UNAVAILABLE", "Original history revision is unavailable");
    throw;
  }
}
} // namespace coc
