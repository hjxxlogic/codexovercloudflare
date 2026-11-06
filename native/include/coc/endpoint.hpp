#pragma once
#include "network.hpp"
#include "secure_channel.hpp"
#include "store.hpp"
#include <map>
namespace coc {
std::shared_ptr<Socket> endpoint_socket(asio::io_context &, const Url &, const std::string &,
                                        SocketMessage, SocketClosed, const std::string &path,
                                        const std::string &host);
Json endpoint_http(const Url &, const std::string &, const Json &, const std::string &,
                   const std::string &, std::chrono::milliseconds, const HttpIntent *);
std::string business_host(const std::string &, const Json & = nullptr);
// Runs on the Agent business executor. All callbacks re-enter that executor.
class EndpointService {
public:
  using Send = std::function<void(const Json &)>;
  using Receive = std::function<void(const Json &)>;

private:
  struct Stream {
    std::string id, path, session, kind;
    Json state = Json::object();
  };
  struct Link {
    Json identity;
    std::unique_ptr<SecureChannel> cipher;
    std::map<std::string, Stream> streams;
    std::string partial;
  };
  Store &store_;
  std::string host_;
  Send wire_;
  Receive business_;
  std::map<std::string, Link> links_;
  struct Pending {
    std::string link, id;
    int64_t expires;
    std::function<void(Json)> done;
  };
  std::map<std::string, Pending> pending_;
  void detach(const std::string &, const Stream &);
  void fence(const std::string &, const Json &);
  void emit(const std::string &, const Json &);
  void call(const std::string &, const std::string &, Json, Json, std::function<void(Json)>);
  void packet(const std::string &, const Json &);
  void request(const std::string &, const Json &);
  void stream(const std::string &, Stream &, const Json &);
  void require_access(const std::string &, const std::string & = "");
  void check_session(const std::string &, const std::string &);
  std::string owner(const std::string &) const;

public:
  EndpointService(Store &, std::string host, Send, Receive);
  bool receive(const Json &);
  bool outgoing(const Json &);
  void disconnected();
  bool can_dispatch(const std::string &, int64_t);
};
} // namespace coc
