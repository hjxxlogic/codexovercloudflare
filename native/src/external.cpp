#include "coc/external.hpp"
#include <algorithm>
#include <cctype>
#include <cwchar>
namespace coc {
bool active_writer_error(const Json &error) {
  if (!error.is_object() || error.value("code", "") != "CODEX_ERROR")
    return false;
  auto text = error.value("message", "");
  std::transform(text.begin(), text.end(), text.begin(),
                 [](unsigned char c) { return char(std::tolower(c)); });
  return text.find("already has an active writer") != std::string::npos;
}
bool same_project_path(const std::string &left, const std::string &right) {
  if (left.empty() || right.empty() || left.find('\0') != std::string::npos ||
      right.find('\0') != std::string::npos)
    return false;
  auto a = std::filesystem::canonical(std::filesystem::u8path(left));
  auto b = std::filesystem::canonical(std::filesystem::u8path(right));
#ifdef _WIN32
  return _wcsicmp(a.c_str(), b.c_str()) == 0;
#else
  return a == b;
#endif
}
ExternalThread::ExternalThread(asio::io_context &io, std::shared_ptr<CodexProcess> process,
                               std::string thread, std::string cwd,
                               std::function<void(std::string, Json, bool)> item,
                               std::function<void(Json)> state, std::function<void(Json)> failure)
    : process_(std::move(process)), timer_(io), thread_(std::move(thread)), cwd_(std::move(cwd)),
      item_(std::move(item)), state_(std::move(state)), failure_(std::move(failure)) {}
void ExternalThread::validate(Completion done) {
  auto self = shared_from_this();
  process_->request("thread/read", {{"threadId", thread_}, {"includeTurns", false}},
                    [self, done](Json result, Json error) {
                      if (!error.is_null()) {
                        done(nullptr, error);
                        return;
                      }
                      try {
                        if (result.at("thread").at("id") != self->thread_ ||
                            !same_project_path(result.at("thread").value("cwd", ""), self->cwd_))
                          throw Error("FORBIDDEN", "External thread belongs to another project");
                        self->legacy_ =
                            result.at("thread").value("historyMode", "paginated") == "legacy";
                        done(result.at("thread"), nullptr);
                      } catch (const std::exception &error) {
                        done(nullptr, error_data(error));
                      }
                    });
}
void ExternalThread::deliver(const Json &entry, bool historical, bool descending) {
  if (legacy_) {
    auto items = entry.value("items", Json::array());
    if (descending)
      std::reverse(items.begin(), items.end());
    for (auto &item : items)
      item_(entry.at("id"), item, historical);
  } else
    item_(entry.at("turnId"), entry.at("item"), historical);
}
void ExternalThread::probe(Json cursor, int remaining, size_t bytes, Json entries, Json reverse,
                           Completion done) {
  auto self = shared_from_this();
  Json params = {
      {"threadId", thread_}, {"cursor", cursor}, {"limit", 1}, {"sortDirection", "desc"}};
  if (legacy_)
    params["itemsView"] = "full";
  process_->request(legacy_ ? "thread/turns/list" : "thread/items/list", params,
                    [self, remaining, bytes, entries = std::move(entries), reverse,
                     done](Json result, Json error) mutable {
                      if (!error.is_null()) {
                        done(nullptr, error);
                        return;
                      }
                      try {
                        for (auto &entry : result.at("data")) {
                          bytes += entry.dump().size();
                          entries.push_back(entry);
                        }
                        if (!result.at("data").empty())
                          reverse = result.value("backwardsCursor", Json());
                        auto next = result.value("nextCursor", Json());
                        if (!next.is_null() && remaining > 1 && bytes < max_queue) {
                          self->probe(next, remaining - 1, bytes, std::move(entries), reverse,
                                      done);
                          return;
                        }
                        if (!entries.empty() && reverse.is_null())
                          throw Error("EXTERNAL_HISTORY_UNSUPPORTED",
                                      "Codex did not return a read-only live history cursor");
                        done({{"entries", entries}, {"anchor", reverse}, {"older", next}}, nullptr);
                      } catch (const std::exception &error) {
                        done(nullptr, error_data(error));
                      }
                    });
}
void ExternalThread::forward(Json cursor, Completion done) {
  if (stopped_) {
    done(nullptr, {{"code", "SESSION_CLOSED"}, {"message", "Reader closed"}});
    return;
  }
  auto self = shared_from_this();
  Json params = {{"threadId", thread_}, {"cursor", cursor}, {"limit", 1}, {"sortDirection", "asc"}};
  if (legacy_)
    params["itemsView"] = "full";
  process_->request(legacy_ ? "thread/turns/list" : "thread/items/list", params,
                    [self, cursor, done](Json result, Json error) {
                      if (!error.is_null()) {
                        done(nullptr, error);
                        return;
                      }
                      try {
                        for (auto &entry : result.at("data"))
                          self->deliver(entry, false, false);
                        auto next = result.value("nextCursor", Json());
                        if (!next.is_null()) {
                          if (next == cursor)
                            throw Error("INVALID_FRAME", "History cursor did not advance");
                          self->forward(next, done);
                        } else
                          done(nullptr, nullptr);
                      } catch (const std::exception &error) {
                        done(nullptr, error_data(error));
                      }
                    });
}
void ExternalThread::latest(Completion done) {
  auto self = shared_from_this();
  validate([self, done](Json metadata, Json error) {
    if (!error.is_null()) {
      done(nullptr, error);
      return;
    }
    self->process_->request(
        "thread/turns/list",
        {{"threadId", self->thread_},
         {"limit", 1},
         {"sortDirection", "desc"},
         {"itemsView", "summary"}},
        [self, done](Json turns, Json error) {
          if (!error.is_null()) {
            done(nullptr, error);
            return;
          }
          try {
            const auto data = turns.value("data", Json::array());
            const bool known = !data.empty();
            const bool running = known && data[0].value("status", "") == "inProgress";
            self->state_({{"running", running},
                          {"externalStatus", known ? (running ? "active" : "idle") : "unknown"}});
            self->probe(nullptr, self->legacy_ ? 1 : 16, 0, Json::array(), nullptr,
                        [self, done](Json result, Json error) {
                          if (!error.is_null()) {
                            done(nullptr, error);
                            return;
                          }
                          try {
                            auto finish = [self, result, done](Json, Json error) {
                              if (error.is_null())
                                self->anchor_ = result.at("anchor");
                              done({{"archiveCursor", result.at("older")},
                                    {"historyMode", self->legacy_ ? "legacy" : "paginated"},
                                    {"seeded", !result.at("entries").empty()}},
                                   error);
                            };
                            if (self->anchor_.is_null()) {
                              auto entries = result.at("entries");
                              std::reverse(entries.begin(), entries.end());
                              for (auto &entry : entries)
                                self->deliver(entry, false, false);
                              finish(nullptr, nullptr);
                            } else
                              self->forward(self->anchor_, finish);
                          } catch (const std::exception &error) {
                            done(nullptr, error_data(error));
                          }
                        });
          } catch (const std::exception &error) {
            done(nullptr, error_data(error));
          }
        });
  });
}
void ExternalThread::bootstrap(Completion done) {
  auto self = shared_from_this();
  latest([self, done](Json result, Json error) {
    done(result, error);
    if (error.is_null())
      self->schedule(2);
  });
}
void ExternalThread::schedule(int seconds) {
  if (stopped_)
    return;
  auto self = shared_from_this();
  timer_.expires_after(std::chrono::seconds(seconds));
  timer_.async_wait([self](auto error) {
    if (error || self->stopped_)
      return;
    self->latest([self](Json result, Json error) {
      if (!self->stopped_) {
        if (!error.is_null())
          self->failure_(error);
        else
          self->state_({{"seed", result}});
        self->schedule(error.is_null() ? 2 : 15);
      }
    });
  });
}
void ExternalThread::close() {
  stopped_ = true;
  timer_.cancel();
}
void ExternalThread::enqueue(const std::string &text, const std::string &client_id,
                             std::function<void()> submitted, Completion done) {
  auto self = shared_from_this();
  validate([self, text, client_id, submitted, done](Json, Json error) {
    if (!error.is_null()) {
      done(nullptr, error);
      return;
    }
    try {
      submitted();
      self->process_->request(
          "thread/queue/add",
          {{"threadId", self->thread_},
           {"clientUserMessageId", client_id},
           {"input",
            Json::array({{{"type", "text"}, {"text", text}, {"text_elements", Json::array()}}})}},
          [done](Json result, Json error) {
            if (!error.is_null() && error.value("code", "") != "CODEX_ERROR")
              error = {{"code", "RESULT_UNKNOWN"},
                       {"message",
                        "Queue submission unconfirmed; query its request status before retrying"}};
            done(result, error);
          });
    } catch (const std::exception &error) {
      done(nullptr, error_data(error));
    }
  });
}
void ExternalThread::find_queued(const std::string &client_id, Completion done, Json cursor,
                                 int pages) {
  auto self = shared_from_this();
  process_->request(
      "thread/queue/list", {{"threadId", thread_}, {"cursor", cursor}, {"limit", 100}},
      [self, client_id, cursor, pages, done](Json result, Json error) {
        if (!error.is_null()) {
          done(nullptr, error);
          return;
        }
        for (auto &entry : result.value("data", Json::array()))
          if (entry.value("clientUserMessageId", "") == client_id) {
            done({{"queuedSubmission", entry}}, nullptr);
            return;
          }
        auto next = result.value("nextCursor", Json());
        if (!next.is_null() && pages > 1 && next != cursor)
          self->find_queued(client_id, done, next, pages - 1);
        else
          done(nullptr, {{"code", "RESULT_UNKNOWN"},
                         {"message", "Submission is absent from the pending queue; it may already "
                                     "have been consumed. Do not resubmit automatically"}});
      });
}
} // namespace coc
