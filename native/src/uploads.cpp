#include "coc/credit.hpp"
#include "coc/delivery.hpp"
#include "coc/files.hpp"
#include "coc/store.hpp"
namespace coc {
std::string workspace_upload_identity(const std::string &root, const std::string &owner,
                                      const std::string &id) {
  if (root.empty() || root.size() > 4096 || owner.empty() || owner.size() > 128 || !valid_id(id))
    throw Error("INVALID_REQUEST", "Invalid upload identity");
  return delivery_digest(Json::array({root, owner, id}).dump());
}
namespace {
bool valid_checksum(const Json &value) {
  if (!value.is_string())
    return false;
  const auto checksum = value.get<std::string>();
  return checksum.size() == 64 &&
         checksum.find_first_not_of("0123456789abcdef") == std::string::npos;
}
} // namespace
void validate_workspace_upload(const Json &data, const std::string &instance) {
  if (!data.is_object() || !data.contains("operation") || !data.at("operation").is_string())
    throw Error("INVALID_REQUEST", "Invalid file operation");
  const auto operation = data.at("operation").get<std::string>();
  if (operation == "list" || operation == "read")
    return;
  if (operation != "begin" && operation != "chunk" && operation != "finish" &&
      operation != "cancel" && operation != "status")
    throw Error("INVALID_REQUEST", "Unknown file operation");
  if (!data.contains("uploadId") || !data.at("uploadId").is_string() ||
      !valid_id(data.at("uploadId")))
    throw Error("INVALID_REQUEST", "Invalid upload identity");
  // begin is already pinned by its mandatory original-operation intent.
  if (operation != "begin") {
    if (!data.contains("agentInstance") || !data.at("agentInstance").is_string() ||
        !valid_id(data.at("agentInstance")))
      throw Error("INVALID_REQUEST", "Upload requires its original Agent instance");
    if (data.at("agentInstance") != instance)
      throw Error("DELIVERY_STATE_MISMATCH", "Upload belongs to another Agent store");
  }
  if ((operation == "begin" || operation == "finish") &&
      (!data.contains("sha256") || !valid_checksum(data.at("sha256"))))
    throw Error("INVALID_REQUEST", "Upload requires its original complete SHA-256");
}
Json WorkspaceFiles::upload_receipt(const std::string &root, const std::string &owner,
                                    const std::string &id) {
  return store_.upload_record(root, owner, id);
}
void WorkspaceFiles::begin_receipt(const std::string &root, const std::string &owner,
                                   const std::string &id, const Json &body) {
  store_.upload_prepare(root, owner, id, body);
}
void WorkspaceFiles::finish_receipt(const std::string &root, const std::string &owner,
                                    const std::string &id, const Json &result, bool reclaimed) {
  store_.upload_complete(root, owner, id, result, reclaimed);
}
Json Store::upload_record(const std::string &root, const std::string &owner,
                          const std::string &id) {
  const auto rows = query("SELECT phase,result,digest FROM transport2_uploads WHERE key=?",
                          {workspace_upload_identity(root, owner, id)});
  if (rows.empty())
    return nullptr;
  auto result = rows.at(0);
  if (!result.at("result").is_null())
    result["result"] = Json::parse(result.at("result").get<std::string>());
  return result;
}
Json Store::upload_prepare(const std::string &root, const std::string &owner, const std::string &id,
                           const Json &input) {
  const auto key = workspace_upload_identity(root, owner, id);
  if (!input.contains("sha256") || !valid_checksum(input.at("sha256")))
    throw Error("INVALID_REQUEST", "Upload intention requires its complete SHA-256");
  const Json body = {{"path", input.at("path")},
                     {"sha256", input.at("sha256")},
                     {"size", input.at("size")},
                     {"overwrite", input.value("overwrite", false)}};
  const auto size = body.at("size").get<int64_t>();
  if (!body.at("path").is_string() || size < 0 || size > credit::upload_file ||
      body.dump().size() > 4096)
    throw Error("INVALID_REQUEST", "Invalid upload intention");
  const auto digest = delivery_digest(body.dump());
  run("BEGIN IMMEDIATE");
  try {
    auto previous = upload_record(root, owner, id);
    if (!previous.is_null()) {
      if (previous.at("digest") != digest)
        throw Error("IDEMPOTENCY_CONFLICT", "Original upload intention changed");
      if (previous.at("phase") == "completed")
        throw Error("UPLOAD_EXISTS", "Upload identity already completed");
      if (previous.at("phase") != "started")
        throw Error("RESULT_UNKNOWN", "Upload was retired; reconcile its original result");
      run("COMMIT");
      return {{"new", false}};
    }
    const auto all = query("SELECT COUNT(*) AS records,COALESCE(SUM(reserved),0) AS bytes,"
                           "COALESCE(SUM(active),0) AS active FROM transport2_uploads")[0];
    const auto owned = query("SELECT COUNT(*) AS records,COALESCE(SUM(active),0) AS active "
                             "FROM transport2_uploads WHERE owner=?",
                             {owner})[0];
    if (all.at("records").get<int64_t>() >= credit::upload_records ||
        owned.at("records").get<int64_t>() >= credit::upload_owner_records ||
        all.at("active").get<int64_t>() >= 4 || owned.at("active").get<int64_t>() >= 2 ||
        all.at("bytes").get<int64_t>() + size + credit::upload_metadata > credit::upload_budget)
      throw Error("BACKPRESSURE", "Upload resource or refusal identity budget exhausted");
    run("INSERT INTO transport2_uploads VALUES(?,?,?,'started',NULL,?,1)",
        {key, owner, digest, size + credit::upload_metadata});
    run("COMMIT");
    return {{"new", true}};
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
void Store::upload_complete(const std::string &root, const std::string &owner,
                            const std::string &id, const Json &result, bool reclaimed) {
  const auto key = workspace_upload_identity(root, owner, id);
  if (!result.is_object() || result.dump().size() > 4096)
    throw Error("INVALID_REQUEST", "Invalid upload terminal result");
  run("BEGIN IMMEDIATE");
  try {
    const auto previous = upload_record(root, owner, id);
    if (previous.is_null())
      throw Error("UPLOAD_NOT_FOUND", "Unknown original upload");
    if (previous.at("phase") != "started") {
      if (previous.at("result") != result)
        throw Error("RESULT_UNKNOWN", "Original upload was already retired");
    } else {
      const auto phase = result.value("state", "") == "completed" ? "completed" : "retired";
      // A failed unlink must retain the full disk promise, including after restart.
      run("UPDATE transport2_uploads SET phase=?,result=?,reserved=CASE WHEN ? THEN ? ELSE "
          "reserved END,active=CASE WHEN ? THEN 0 ELSE active END WHERE key=?",
          {phase, result.dump(), reclaimed ? 1 : 0, credit::upload_metadata, reclaimed ? 1 : 0,
           key});
    }
    run("COMMIT");
  } catch (...) {
    run("ROLLBACK");
    throw;
  }
}
Json Store::upload_budget() {
  return query("SELECT COUNT(*) AS records,COALESCE(SUM(reserved),0) AS bytes,"
               "COALESCE(SUM(active),0) AS active FROM transport2_uploads")[0];
}
} // namespace coc
