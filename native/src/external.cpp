#include "coc/external.hpp"
#include "coc/delivery.hpp"
#include <algorithm>
#include <cctype>
#include <cwchar>
namespace coc {
std::string queue_submission_id(const std::string &instance, const std::string &session,
                                const std::string &request) {
  if (instance.empty() || session.empty() || request.empty())
    throw Error("INVALID_REQUEST", "Queue correlation requires its original scope");
  return "coc-" + delivery_digest(Json::array({"queue-v1", instance, session, request}).dump());
}
namespace {
bool queue_matches(const Json &entry, const std::string &client, const std::string &text) {
  if (!entry.is_object() || !entry.contains("id") || !entry.at("id").is_string() ||
      entry.at("id").get_ref<const std::string &>().empty() ||
      entry.at("id").get_ref<const std::string &>().size() > 200 ||
      entry.value("clientUserMessageId", "") != client)
    return false;
  const auto input = entry.value("input", Json::array());
  return input.is_array() && input.size() == 1 && input.at(0).is_object() &&
         input.at(0).value("type", "") == "text" && input.at(0).value("text", "") == text &&
         input.at(0).value("text_elements", Json::array()) == Json::array();
}
Json queue_unknown() {
  return {{"code", "RESULT_UNKNOWN"},
          {"message", "Original queue submission could not be uniquely verified; it may already "
                      "have been consumed. Do not resubmit automatically"}};
}
} // namespace
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
  std::error_code error;
  auto a = std::filesystem::canonical(std::filesystem::u8path(left), error);
  if (error)
    return false;
  auto b = std::filesystem::canonical(std::filesystem::u8path(right), error);
  if (error)
    return false;
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
void read_history_thread(std::shared_ptr<CodexProcess> process, const std::string &thread,
                         const std::string &cwd, Completion done) {
  process->request(
      "thread/read", {{"threadId", thread}, {"includeTurns", false}},
      [thread, cwd, done](Json result, Json error) {
        if (!error.is_null()) {
          done(nullptr, error);
          return;
        }
        if (!result.is_object() || !result.contains("thread") || !result.at("thread").is_object()) {
          done(nullptr, {{"code", "INVALID_FRAME"}, {"message", "Invalid thread metadata"}});
          return;
        }
        const auto &source = result.at("thread");
        if (!source.contains("id") || source.at("id") != thread || !source.contains("cwd") ||
            !source.at("cwd").is_string() || !same_project_path(source.at("cwd"), cwd)) {
          done(nullptr,
               {{"code", "FORBIDDEN"}, {"message", "History thread belongs to another project"}});
          return;
        }
        if (source.contains("historyMode") && source.at("historyMode") != "paginated" &&
            source.at("historyMode") != "legacy") {
          done(nullptr,
               {{"code", "EXTERNAL_HISTORY_UNSUPPORTED"}, {"message", "Unknown history mode"}});
          return;
        }
        done(source, nullptr);
      });
}
static void read_history_entry(std::shared_ptr<CodexProcess> process, const std::string &thread,
                               const std::string &cwd, const std::string &turn,
                               const std::string &item, size_t max_bytes, Completion done,
                               const std::filesystem::path &home, const Json &expected_origin) {
  if (thread.empty() || turn.empty() || item.empty() || thread.size() > 256 || turn.size() > 256 ||
      item.size() > 256 || max_bytes == 0 || max_bytes > 1024 * 1024) {
    done(nullptr, {{"code", "INVALID_REQUEST"}, {"message", "Invalid bounded history read"}});
    return;
  }
  read_history_thread(
      process, thread, cwd,
      [process, thread, cwd, turn, item, max_bytes, done, home, expected_origin](Json source,
                                                                                 Json error) {
        if (!error.is_null()) {
          done(nullptr, error);
          return;
        }
        if (source.value("historyMode", "paginated") != "paginated") {
          done(nullptr, {{"code", "EXTERNAL_HISTORY_UNSUPPORTED"},
                         {"message", "Direct item reads require paginated history"}});
          return;
        }
        Json origin;
        if (!home.empty()) {
          try {
            origin = history_source_origin(source, home, cwd);
            if (!expected_origin.is_null() && origin != expected_origin)
              throw Error("DELIVERY_STATE_MISMATCH", "History source identity changed");
          } catch (const std::exception &failure) {
            done(nullptr, error_data(failure));
            return;
          }
        }
        process->request(
            "thread/items/read",
            {{"threadId", thread}, {"turnId", turn}, {"itemIds", Json::array({item})}},
            [process, thread, cwd, turn, item, max_bytes, done, home, origin](Json result,
                                                                              Json error) {
              if (!error.is_null()) {
                done(nullptr, error);
                return;
              }
              if (!result.is_object() || !result.contains("data") ||
                  !result.at("data").is_array()) {
                done(nullptr,
                     {{"code", "INVALID_FRAME"}, {"message", "Invalid persisted item response"}});
                return;
              }
              const auto &data = result.at("data");
              if (data.empty()) {
                done(nullptr, {{"code", "CONTENT_UNAVAILABLE"},
                               {"message", "Persisted item is unavailable"}});
                return;
              }
              if (data.size() != 1 || !data.at(0).is_object() || !data.at(0).contains("turnId") ||
                  data.at(0).at("turnId") != turn || !data.at(0).contains("item") ||
                  !data.at(0).at("item").is_object() || !data.at(0).at("item").contains("id") ||
                  data.at(0).at("item").at("id") != item) {
                done(nullptr,
                     {{"code", "INVALID_FRAME"}, {"message", "Persisted item identity mismatch"}});
                return;
              }
              if (data.at(0).dump().size() > max_bytes) {
                done(nullptr,
                     {{"code", "BACKPRESSURE"}, {"message", "Persisted item exceeds read budget"}});
                return;
              }
              const auto entry = data.at(0);
              read_history_thread(
                  process, thread, cwd, [entry, done, home, cwd, origin](Json source, Json error) {
                    if (error.is_null() && source.value("historyMode", "paginated") != "paginated")
                      error = {{"code", "CONTENT_CHANGED"},
                               {"message", "History mode changed during read"}};
                    if (error.is_null() && !home.empty()) {
                      try {
                        if (history_source_origin(source, home, cwd) != origin)
                          throw Error("DELIVERY_STATE_MISMATCH",
                                      "History source changed during read");
                      } catch (const std::exception &failure) {
                        error = error_data(failure);
                      }
                    }
                    done(error.is_null()
                             ? (home.empty() ? entry : Json{{"origin", origin}, {"entry", entry}})
                             : Json(),
                         error);
                  });
            });
      });
}
void read_history_item(std::shared_ptr<CodexProcess> process, const std::string &thread,
                       const std::string &cwd, const std::string &turn, const std::string &item,
                       size_t max_bytes, Completion done) {
  read_history_entry(std::move(process), thread, cwd, turn, item, max_bytes, std::move(done), {},
                     nullptr);
}
void read_history_source(std::shared_ptr<CodexProcess> process, const std::filesystem::path &home,
                         const std::string &thread, const std::string &cwd, const std::string &turn,
                         const std::string &item, size_t max_bytes, Completion done,
                         const Json &expected_origin) {
  if (home.empty()) {
    done(nullptr,
         {{"code", "CONTENT_UNAVAILABLE"}, {"message", "Codex source home is unavailable"}});
    return;
  }
  read_history_entry(std::move(process), thread, cwd, turn, item, max_bytes, std::move(done), home,
                     expected_origin);
}
void ExternalThread::validate(Completion done) {
  auto self = shared_from_this();
  read_history_thread(process_, thread_, cwd_, [self, done](Json source, Json error) {
    if (error.is_null())
      self->legacy_ = source.value("historyMode", "paginated") == "legacy";
    done(source, error);
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
void ExternalThread::forward(Json cursor, const std::string &turn, Json anchor, Completion done) {
  if (stopped_) {
    done(nullptr, {{"code", "SESSION_CLOSED"}, {"message", "Reader closed"}});
    return;
  }
  auto self = shared_from_this();
  Json params = {{"threadId", thread_}, {"cursor", cursor}, {"limit", 1}, {"sortDirection", "asc"}};
  if (legacy_)
    params["itemsView"] = "full";
  process_->request(legacy_ ? "thread/turns/list" : "thread/items/list", params,
                    [self, cursor, turn, anchor, done](Json result, Json error) mutable {
                      if (!error.is_null()) {
                        done(nullptr, error);
                        return;
                      }
                      try {
                        for (auto &entry : result.at("data")) {
                          const auto entry_turn = entry.at(self->legacy_ ? "id" : "turnId");
                          // Revisit the whole observed current turn: items older than
                          // the rolling tail can still grow or finish asynchronously.
                          if (anchor.is_null() && entry_turn == turn)
                            anchor = cursor;
                          self->deliver(entry, false, false);
                        }
                        auto next = result.value("nextCursor", Json());
                        if (!next.is_null()) {
                          if (next == cursor)
                            throw Error("INVALID_FRAME", "History cursor did not advance");
                          self->forward(next, turn, anchor, done);
                        } else
                          done(anchor, nullptr);
                      } catch (const std::exception &error) {
                        done(nullptr, error_data(error));
                      }
                    });
}
void ExternalThread::latest(Completion done) {
  auto self = shared_from_this();
  validate([self, done](Json, Json error) {
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
            const auto turn = known ? data[0].value("id", "") : "";
            const bool running = known && data[0].value("status", "") == "inProgress";
            self->state_({{"running", running},
                          {"externalStatus", known ? (running ? "active" : "idle") : "unknown"}});
            self->probe(nullptr, self->legacy_ ? 1 : 16, 0, Json::array(), nullptr,
                        [self, turn, done](Json result, Json error) {
                          if (!error.is_null()) {
                            done(nullptr, error);
                            return;
                          }
                          try {
                            auto finish = [self, result, done](Json anchor, Json error) {
                              if (error.is_null() && !anchor.is_null())
                                self->anchor_ = anchor;
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
                              finish(result.at("anchor"), nullptr);
                            } else
                              self->forward(self->anchor_, turn, nullptr, finish);
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
      self->process_->request(
          "thread/queue/add",
          {{"threadId", self->thread_},
           {"clientUserMessageId", client_id},
           {"input",
            Json::array({{{"type", "text"}, {"text", text}, {"text_elements", Json::array()}}})}},
          [client_id, text, done](Json result, Json error) {
            if (error.is_null()) {
              try {
                if (!queue_matches(result.at("queuedSubmission"), client_id, text))
                  error = queue_unknown();
              } catch (const std::exception &) {
                error = queue_unknown();
              }
            }
            done(error.is_null() ? result : Json(), error);
          },
          submitted);
    } catch (const std::exception &error) {
      done(nullptr, error_data(error));
    }
  });
}
void ExternalThread::find_queued(const std::string &client_id, const std::string &text,
                                 Completion done) {
  auto self = shared_from_this();
  validate([self, client_id, text, done](Json, Json error) {
    if (!error.is_null())
      done(nullptr, error);
    else
      self->queue_page(client_id, text, done, nullptr, 20, nullptr);
  });
}
void ExternalThread::queue_page(const std::string &client_id, const std::string &text,
                                Completion done, Json cursor, int pages, Json found) {
  auto self = shared_from_this();
  process_->request(
      "thread/queue/list", {{"threadId", thread_}, {"cursor", cursor}, {"limit", 100}},
      [self, client_id, text, cursor, pages, found, done](Json result, Json error) mutable {
        if (!error.is_null()) {
          done(nullptr, error);
          return;
        }
        Json next;
        try {
          const auto &data = result.at("data");
          if (!data.is_array() || data.size() > 100)
            throw Error("INVALID_FRAME", "Queue page exceeds its bound");
          for (const auto &entry : data)
            if (entry.value("clientUserMessageId", "") == client_id) {
              if (!found.is_null() || !queue_matches(entry, client_id, text))
                throw Error("RESULT_UNKNOWN", "Queue correlation is ambiguous or changed");
              found = entry;
            }
          next = result.at("nextCursor");
          if (!next.is_null() && (!next.is_string() || next == cursor || pages <= 1))
            throw Error("RESULT_UNKNOWN", "Queue scan did not reach a verified end");
        } catch (const std::exception &) {
          done(nullptr, queue_unknown());
          return;
        }
        if (!next.is_null()) {
          self->queue_page(client_id, text, done, next, pages - 1, found);
          return;
        }
        if (found.is_null()) {
          done(nullptr, queue_unknown());
          return;
        }
        self->validate([found, done](Json, Json error) {
          done(error.is_null() ? Json{{"queuedSubmission", found}} : Json(), error);
        });
      });
}
} // namespace coc
