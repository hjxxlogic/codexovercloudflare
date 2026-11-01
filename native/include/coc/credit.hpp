#pragma once
#include <cstdint>
namespace coc::credit {
// Budgets charge payload plus conservative record/index overhead. Filesystem
// exhaustion is still a storage fault, never a reason to acknowledge a write.
constexpr int64_t record_limit = 1024;
constexpr int64_t record_bytes = 8192;
constexpr int64_t flow_limit = 1024;
constexpr int64_t result_bytes = 2 * 1024 * 1024 + 16384;
constexpr int64_t normal_budget = 512 * 1024 * 1024;
constexpr int64_t priority_budget = 256 * 1024 * 1024;
constexpr int64_t normal_session = 128 * 1024 * 1024;
constexpr int64_t priority_session = 64 * 1024 * 1024;
constexpr int64_t control_budget = 16 * 1024 * 1024;
// Charge both the catalog and one atomic replacement, including metadata.
constexpr int64_t project_budget = 16 * 1024 * 1024;
constexpr int64_t project_records = 1024;
constexpr int64_t project_result_reservation = 2 * (256 * 1024 + 16384);
constexpr int64_t project_retired_ids = 1024;
constexpr int64_t project_tail = 16;
constexpr int64_t project_tail_bytes = 4 * 1024 * 1024;
constexpr int64_t management_records = 256;
constexpr int64_t management_record_bytes = 8192;
constexpr int64_t local_command_reservation = 32 * 1024 * 1024;
constexpr int64_t local_command_budget = 512 * 1024 * 1024;
constexpr int64_t local_output_reservation = 8 * 1024 * 1024;
constexpr int64_t local_output_budget = 128 * 1024 * 1024;
constexpr int64_t output_budget = 64 * 1024 * 1024;
constexpr int64_t output_session = 8 * 1024 * 1024;
constexpr int64_t output_records = 16384;
constexpr int64_t output_session_records = 4096;
constexpr int64_t cache_budget = 64 * 1024 * 1024;
constexpr int64_t cache_scope = 16 * 1024 * 1024;
constexpr int64_t cache_records = 100000;
constexpr int64_t cache_scope_records = 10000;
constexpr int64_t history_budget = 256 * 1024 * 1024;
constexpr int64_t history_session = 64 * 1024 * 1024;
constexpr int64_t history_records = 250000;
constexpr int64_t history_session_records = 64000;
constexpr int64_t history_scopes = 1024;
constexpr int64_t upload_file = 20 * 1024 * 1024;
constexpr int64_t upload_records = 1024;
constexpr int64_t upload_owner_records = 256;
constexpr int64_t upload_metadata = 16 * 1024;
constexpr int64_t upload_budget = 4 * upload_file + upload_records * upload_metadata;
constexpr int64_t operation_budget = 128 * 1024 * 1024;
constexpr int64_t operation_owner = 32 * 1024 * 1024;
constexpr int64_t operation_records = 1024;
constexpr int64_t operation_slot = 256 * 1024 + record_bytes;
constexpr int64_t local_operation_pending = 32;
constexpr int64_t local_operation_tail = 16;
constexpr int64_t local_operation_tail_bytes = 4 * 1024 * 1024;
} // namespace coc::credit
