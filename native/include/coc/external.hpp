#pragma once
#include "process.hpp"
namespace coc {
bool active_writer_error(const Json &error);
bool same_project_path(const std::string &left, const std::string &right);
void read_history_thread(std::shared_ptr<CodexProcess>, const std::string &thread,
                         const std::string &cwd, Completion);
std::filesystem::path history_source_home(const std::string &cwd);
Json history_source_origin(const Json &thread, const std::filesystem::path &home,
                           const std::string &cwd);
// Returns {origin, entry}, with the source identity checked before and after the read.
void read_history_source(std::shared_ptr<CodexProcess>, const std::filesystem::path &home,
                         const std::string &thread, const std::string &cwd, const std::string &turn,
                         const std::string &item, size_t max_bytes, Completion,
                         const Json &expected_origin = nullptr);
// Returns one current persisted entry, not a proof that any old revision can be
// reconstructed. Source binding and projected digest checks precede eviction.
void read_history_item(std::shared_ptr<CodexProcess>, const std::string &thread,
                       const std::string &cwd, const std::string &turn, const std::string &item,
                       size_t max_bytes, Completion);

// A reader never resumes a thread or starts/interrupts a turn. Queue execution
// and approval handling remain with the original Codex client.
class ExternalThread : public std::enable_shared_from_this<ExternalThread> {
  std::shared_ptr<CodexProcess> process_;
  asio::steady_timer timer_;
  std::string thread_, cwd_;
  bool legacy_ = false, stopped_ = false;
  Json anchor_;
  std::function<void(std::string, Json, bool)> item_;
  std::function<void(Json)> state_;
  std::function<void(Json)> failure_;
  void validate(Completion);
  void probe(Json, int, size_t, Json, Json, Completion);
  void forward(Json, const std::string &, Json, Completion);
  void latest(Completion);
  void schedule(int);
  void queue_page(const std::string &, Completion, Json, int);
  void deliver(const Json &, bool, bool);

public:
  ExternalThread(asio::io_context &, std::shared_ptr<CodexProcess>, std::string thread,
                 std::string cwd, std::function<void(std::string, Json, bool)> item,
                 std::function<void(Json)> state, std::function<void(Json)> failure);
  void bootstrap(Completion);
  void close();
  void enqueue(const std::string &text, const std::string &client_id,
               std::function<void()> submitted, Completion);
  void find_queued(const std::string &client_id, Completion);
};
} // namespace coc
