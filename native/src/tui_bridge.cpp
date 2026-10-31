#include "coc/tui_bridge.hpp"
#include "coc/delivery.hpp"
#include <boost/asio/thread_pool.hpp>
#include <boost/beast.hpp>
#include <iostream>
namespace coc {
namespace beast = boost::beast;
namespace http = beast::http;
namespace ws = beast::websocket;
using tcp = asio::ip::tcp;
std::string remote_address(const Url &u, const std::string &path) {
  return std::string(u.tls ? "wss://" : "ws://") +
         (u.host.find(':') == std::string::npos ? u.host : "[" + u.host + "]") + ":" + u.port +
         path;
}
class TuiBridge::Impl : public std::enable_shared_from_this<TuiBridge::Impl> {
  asio::io_context &io_;
  tcp::acceptor acceptor_;
  std::unique_ptr<ws::stream<beast::tcp_stream>> local_;
  asio::steady_timer poll_, credit_timer_;
  asio::thread_pool resume_pool_{1};
  std::unique_ptr<CommandDelivery> delivery_;
  std::function<Json(Json)> resume_;
  std::string controller_;
  unsigned generation_ = 0, attempts_ = 0;
  bool credit_pending_ = false, delivery_connected_ = false, connection_confirmed_ = false;
  std::map<std::string, Json> reads_;
  std::set<std::string> completed_reads_;
  beast::flat_buffer buffer_{max_queue};
  std::unique_ptr<http::request_parser<http::empty_body>> request_;
  Url relay_;
  std::string ticket_, path_;
  std::shared_ptr<Socket> remote_;
  struct Write {
    std::string body;
    int64_t seq = 0, end = 0;
    bool deliver = true;
  };
  std::deque<Write> writes_;
  Store *delivery_store_ = nullptr;
  Json output_progress_ = {{"received", 0}, {"bytes", 0}};
  int64_t queued_output_ = 0, output_head_ = 0;
  size_t queued_ = 0;
  bool open_ = false, ended_ = false;
  void accept() {
    local_ = std::make_unique<ws::stream<beast::tcp_stream>>(io_);
    request_ = std::make_unique<http::request_parser<http::empty_body>>();
    request_->body_limit(0);
    request_->header_limit(16384);
    auto self = shared_from_this();
    acceptor_.async_accept(local_->next_layer().socket(), [self](auto ec) {
      if (ec) {
        self->close();
        return;
      }
      self->local_->next_layer().expires_after(std::chrono::seconds(15));
      http::async_read(
          self->local_->next_layer(), self->buffer_, *self->request_, [self](auto ec, size_t) {
            if (self->ended_)
              return;
            if (ec ||
                self->request_->get()[http::field::authorization] != "Bearer " + self->ticket_ ||
                self->request_->get().target() != "/" || !ws::is_upgrade(self->request_->get())) {
              boost::system::error_code ignored;
              self->local_->next_layer().socket().close(ignored);
              self->buffer_.consume(self->buffer_.size());
              self->accept();
              return;
            }
            // Accept only one authenticated TUI. Proxy credentials remain in this process.
            self->acceptor_.close();
            self->connect_remote();
            self->wait_remote(std::chrono::steady_clock::now() + std::chrono::seconds(30));
          });
    });
  }
  void connect_remote() {
    const auto generation = ++generation_;
    delivery_connected_ = false;
    connection_confirmed_ = false;
    std::weak_ptr<Impl> weak = shared_from_this();
    remote_ = connect_socket(
        io_, relay_, ticket_,
        [weak, generation](Json message) {
          auto self = weak.lock();
          if (!self || self->ended_ || generation != self->generation_)
            return;
          try {
            if (message.contains("receiptId"))
              self->remote_->send({{"type", "receipt"}, {"receiptId", message["receiptId"]}});
            message.erase("receiptId");
            if (message.contains("heads") && message["heads"].is_object())
              self->output_head_ =
                  std::max(self->output_head_, message["heads"].value("rpc", int64_t(0)));
            message.erase("heads");
            if (self->delivery_) {
              if (message.value("type", "") == "delivery-data") {
                const auto seq = message.at("seq").get<int64_t>();
                const auto end = message.at("end").get<int64_t>();
                const auto body = message.at("body").get<std::string>();
                if (seq <= self->queued_output_) {
                  self->request_output(false);
                  return;
                }
                if (seq != self->queued_output_ + 1) {
                  self->request_output(true);
                  return;
                }
                self->queued_output_ = seq;
                const auto payload = Json::parse(body);
                bool deliver = true;
                if (payload.contains("id") && !payload.contains("method")) {
                  const auto id = id_key(payload["id"]);
                  deliver = !self->completed_reads_.count(id) || self->reads_.count(id);
                  if (self->reads_.erase(id)) {
                    self->completed_reads_.insert(id);
                    if (self->completed_reads_.size() > 1000)
                      self->completed_reads_.erase(self->completed_reads_.begin());
                  }
                }
                self->send(body, seq, end, deliver);
                return;
              }
              if (message.value("type", "") == "delivery-ready") {
                const auto instance = message.at("instance").get<std::string>();
                if (!valid_id(instance) || (self->output_progress_.contains("instance") &&
                                            self->output_progress_["instance"] != instance))
                  throw Error("DELIVERY_STATE_MISMATCH", "Agent journal identity changed");
                self->output_progress_["instance"] = instance;
                self->delivery_store_->cache_put(self->path_ + ":output", self->output_progress_);
                self->controller_ = message.at("controller");
                self->connection_confirmed_ = true;
                self->attempts_ = 0;
                return;
              }
              if (self->delivery_->receive(message)) {
                self->schedule_credit();
                return;
              }
              if (message.value("type", "") == "delivery-rejected")
                throw Error("DELIVERY_REJECTED", "Reliable command identity rejected");
            }
            if (message.contains("id") && !message.contains("method")) {
              const auto id = id_key(message["id"]);
              if (self->completed_reads_.count(id) && !self->reads_.count(id))
                return;
              if (self->reads_.erase(id)) {
                self->completed_reads_.insert(id);
                if (self->completed_reads_.size() > 1000)
                  self->completed_reads_.erase(self->completed_reads_.begin());
              }
            }
            self->send(message.dump());
          } catch (const std::exception &error) {
            std::cerr << "Reliable CLI: " << error_data(error).dump() << '\n';
            self->close();
          }
        },
        [weak, generation](unsigned code) {
          auto self = weak.lock();
          if (!self || self->ended_ || generation != self->generation_)
            return;
          self->disconnected(code);
        },
        path_);
    remote_->start();
  }
  void disconnected(unsigned code) {
    if (!delivery_ || !resume_ || !open_ || code == 4001 || code == 4009 || controller_.empty() ||
        attempts_ >= 5) {
      close();
      return;
    }
    delivery_->disconnect();
    credit_timer_.cancel();
    credit_pending_ = false;
    poll_.expires_after(std::chrono::seconds(std::min(15U, 1U << attempts_++)));
    const auto proof = Json{{"stream", delivery_->stream()}, {"controller", controller_}};
    auto self = shared_from_this();
    poll_.async_wait([self, proof](auto ec) {
      if (ec || self->ended_)
        return;
      asio::post(self->resume_pool_, [self, proof] {
        Json ticket, error;
        try {
          ticket = self->resume_(proof);
        } catch (const std::exception &e) {
          error = error_data(e);
        }
        asio::post(self->io_, [self, ticket, error] {
          if (self->ended_)
            return;
          if (!error.is_null()) {
            const auto code = error.value("code", "");
            if (code == "UNAUTHORIZED" || code == "FORBIDDEN" || code == "SESSION_CLOSED" ||
                code == "STALE_CONTROLLER")
              self->close();
            else
              self->disconnected(1011);
            return;
          }
          self->ticket_ = ticket.at("ticket");
          self->connect_remote();
          self->wait_remote(std::chrono::steady_clock::now() + std::chrono::seconds(30));
        });
      });
    });
  }
  void request_output(bool replay) {
    if (!delivery_ || !delivery_connected_ || ended_ || !remote_->ready())
      return;
    const auto received = output_progress_.at("received").get<int64_t>();
    const auto bytes = output_progress_.at("bytes").get<int64_t>();
    remote_->send({{"type", "delivery-output"},
                   {"received", received},
                   {"credit", received + 32},
                   {"byteCredit", bytes + 2 * 1024 * 1024},
                   {"replay", replay}});
  }
  void schedule_credit() {
    if (!delivery_ || ended_ || !delivery_connected_ || credit_pending_ ||
        (!delivery_->pending() && delivery_->ready()))
      return;
    credit_pending_ = true;
    credit_timer_.expires_after(std::chrono::seconds(2));
    auto self = shared_from_this();
    credit_timer_.async_wait([self](auto ec) {
      self->credit_pending_ = false;
      if (ec || self->ended_ || !self->delivery_connected_)
        return;
      self->delivery_->retry();
      self->schedule_credit();
    });
  }
  void wait_remote(std::chrono::steady_clock::time_point deadline) {
    if (ended_)
      return;
    if (!remote_->ready() || (delivery_ && !connection_confirmed_)) {
      if (std::chrono::steady_clock::now() >= deadline) {
        if (open_ && delivery_ && resume_ && !controller_.empty()) {
          ++generation_;
          remote_->close();
          disconnected(1011);
        } else
          close();
        return;
      }
      poll_.expires_after(std::chrono::milliseconds(10));
      auto self = shared_from_this();
      poll_.async_wait([self, deadline](auto ec) {
        if (!ec)
          self->wait_remote(deadline);
      });
      return;
    }
    if (delivery_ && !delivery_connected_) {
      delivery_connected_ = true;
      std::weak_ptr<Impl> weak = shared_from_this();
      delivery_->connect([weak](Json frame) {
        if (auto self = weak.lock())
          if (!self->ended_ && self->remote_->ready())
            self->remote_->send(frame);
      });
      request_output(true);
      schedule_credit();
    }
    if (open_) {
      for (const auto &[id, request] : reads_) {
        (void)id;
        remote_->send(request);
      }
      return;
    }
    local_->next_layer().expires_never();
    local_->set_option(ws::stream_base::timeout::suggested(beast::role_type::server));
    local_->read_message_max(max_frame);
    auto self = shared_from_this();
    local_->async_accept(request_->get(), [self](auto ec) {
      if (ec) {
        self->close();
        return;
      }
      self->open_ = true;
      if (!self->writes_.empty())
        self->write();
      self->read();
    });
  }
  void read() {
    auto self = shared_from_this();
    local_->async_read(buffer_, [self](auto ec, size_t) {
      if (ec || !self->local_->got_text()) {
        self->close();
        return;
      }
      try {
        const auto text = beast::buffers_to_string(self->buffer_.data());
        if (self->delivery_) {
          const auto message = Json::parse(text);
          if (rpc_delivery_lane(message).empty() && message.contains("id") &&
              (!self->remote_->ready() || !self->delivery_connected_)) {
            self->send(
                Json{{"id", message["id"]},
                     {"error",
                      {{"code", -32001},
                       {"message", "Read transport temporarily unavailable; retry the read"}}}}
                    .dump());
            self->buffer_.consume(self->buffer_.size());
            self->read();
            return;
          }
          if (rpc_delivery_lane(message).empty() && message.contains("id")) {
            if (self->reads_.size() >= 100)
              throw Error("BACKPRESSURE", "Too many outstanding reads");
            self->completed_reads_.erase(id_key(message["id"]));
            self->reads_[id_key(message["id"])] = message;
          }
          self->delivery_->submit(message);
          self->schedule_credit();
        } else
          self->remote_->send_text(text);
      } catch (const std::exception &error) {
        std::cerr << "CLI command delivery: " << error_data(error).dump() << '\n';
        self->close();
        return;
      }
      self->buffer_.consume(self->buffer_.size());
      if (!self->ended_)
        self->read();
    });
  }
  void send(std::string message, int64_t seq = 0, int64_t end = 0, bool deliver = true) {
    if (ended_)
      return;
    if (message.size() > max_frame || queued_ + message.size() > max_queue) {
      close();
      return;
    }
    const bool idle = writes_.empty();
    queued_ += message.size();
    writes_.push_back({std::move(message), seq, end, deliver});
    if (open_ && idle)
      write();
  }
  void written(boost::system::error_code ec) {
    if (ec) {
      close();
      return;
    }
    const auto &sent = writes_.front();
    if (sent.seq) {
      try {
        if (sent.seq != output_progress_.at("received").get<int64_t>() + 1)
          throw Error("DELIVERY_GAP", "Local TUI output lost ordering");
        Json progress = {{"received", sent.seq},
                         {"bytes", sent.end},
                         {"instance", output_progress_.at("instance")}};
        delivery_store_->cache_put(path_ + ":output", progress);
        output_progress_ = progress;
        request_output(false);
      } catch (const std::exception &error) {
        std::cerr << "CLI output receipt: " << error_data(error).dump() << '\n';
        close();
        return;
      }
    }
    queued_ -= sent.body.size();
    writes_.pop_front();
    if (!ended_ && !writes_.empty())
      write();
  }
  void write() {
    auto self = shared_from_this();
    if (!writes_.front().deliver) {
      asio::post(io_, [self] { self->written({}); });
      return;
    }
    local_->text(true);
    local_->async_write(asio::buffer(writes_.front().body),
                        [self](auto ec, size_t) { self->written(ec); });
  }

public:
  Impl(asio::io_context &io, Url relay, std::string ticket, std::string path, Store *store,
       std::function<Json(Json)> resume)
      : io_(io), acceptor_(io, {asio::ip::address_v4::loopback(), 0}), poll_(io), credit_timer_(io),
        resume_(std::move(resume)), relay_(std::move(relay)), ticket_(std::move(ticket)),
        path_(std::move(path)) {
    delivery_store_ = store;
    if (store) {
      const auto saved = store->cache_get(path_ + ":output");
      if (!saved.is_null())
        output_progress_ = saved;
      queued_output_ = output_progress_.at("received");
      store->cache_put(path_ + ":output", output_progress_);
    }
    if (store)
      delivery_ = std::make_unique<CommandDelivery>(*store, path_ + ":delivery",
                                                    [this](Json payload) { send(payload.dump()); });
  }
  void observe_output_head(int64_t head) {
    if (head < 0 || head > 9007199254740991LL)
      return;
    output_head_ = std::max(output_head_, head);
    if (output_head_ > queued_output_)
      request_output(true);
  }
  void start() { accept(); }
  std::string url() const {
    return "ws://127.0.0.1:" + std::to_string(acceptor_.local_endpoint().port()) + "/";
  }
  void close() {
    if (ended_)
      return;
    ended_ = true;
    poll_.cancel();
    credit_timer_.cancel();
    delivery_connected_ = false;
    if (delivery_)
      delivery_->disconnect();
    resume_pool_.stop();
    resume_pool_.join();
    boost::system::error_code ignored;
    acceptor_.close(ignored);
    if (local_) {
      // Cancel Beast's server idle timer as well as the underlying socket.
      local_->set_option(
          ws::stream_base::timeout{ws::stream_base::none(), ws::stream_base::none(), false});
      local_->next_layer().socket().close(ignored);
    }
    if (remote_)
      remote_->close();
  }
};
TuiBridge::TuiBridge(asio::io_context &io, const Url &relay, const std::string &ticket,
                     const std::string &path, Store *store, std::function<Json(Json)> resume)
    : impl_(std::make_shared<Impl>(io, relay, ticket, path, store, std::move(resume))) {
  impl_->start();
}
TuiBridge::~TuiBridge() { impl_->close(); }
std::string TuiBridge::url() const { return impl_->url(); }
void TuiBridge::observe_output_head(int64_t head) { impl_->observe_output_head(head); }
} // namespace coc
