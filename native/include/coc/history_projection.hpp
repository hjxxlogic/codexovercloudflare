#pragma once
#include "common.hpp"
namespace coc {
struct HistoryItemProjection {
  Json item, data;
  std::string type, text, fingerprint;
};
// Version 1 preserves the existing external snapshot serialization and redaction.
HistoryItemProjection project_history_item(Json item, const std::string &turn, int version = 1);
// Rebuild only the content view. Retained event metadata is not replaced with
// current source metadata, and callers must verify the original content digest.
std::string recover_history_text(const Json &event, Json item, const std::string &projection);
bool history_text_matches(const std::string &text, const Json &reference);
// Returns only bytes matching the original descriptor. A later append may still
// reconstruct an earlier text prefix or verified span. The span offset must be
// captured while registering the original body; it is never an authorization.
std::string recover_history_content(const Json &event, Json item, const std::string &projection,
                                    const Json &reference, size_t source_byte_offset = 0);

} // namespace coc
