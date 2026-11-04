#include "coc/endpoint.hpp"
#include <filesystem>
#include <iostream>
using namespace coc;
namespace {
void check(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
struct Fixture {
  std::string dir = (std::filesystem::temp_directory_path() / ("coc-endpoint-" + uuid())).string();
  struct Cleanup {
    std::string path;
    ~Cleanup() {
      std::error_code ec;
      std::filesystem::remove_all(path, ec);
    }
  } cleanup{dir};
  Store store{dir};
  std::vector<Json> wire, business;
  EndpointService endpoint{
      store, "host", [this](const Json &d) { wire.push_back(d); },
      [this](const Json &d) {
        business.push_back(d);
        if (d.at("type") == "control") {
          Json data = {{"ok", true}};
          if (d.at("action") == "get")
            data = store.get(d.at("data").at("sessionId"));
          endpoint.outgoing({{"type", "result"}, {"requestId", d.at("requestId")}, {"data", data}});
        }
      }};
  Fixture() {
    for (const auto *id : {"host~one", "host~two"})
      store.save({{"id", id},
                  {"mode", "web"},
                  {"projectId", "project"},
                  {"state", "ready"},
                  {"createdAt", now()}});
  }
  ~Fixture() { endpoint.disconnected(); }
};
struct Peer {
  Fixture &f;
  std::string link = uuid(), own;
  SecureChannel cipher;
  size_t cursor = 0;
  std::string partial;
  std::string controller_id;
  std::vector<Json> packets;
  Peer(Fixture &f, std::string owner = "owner", bool manage = false, int64_t expiry = now() + 60000)
      : f(f), own(std::move(owner)), cipher(true, "binding:" + link) {
    f.endpoint.receive(
        {{"type", "channel-open"},
         {"link", link},
         {"key", cipher.public_key()},
         {"binding", "binding:" + link},
         {"identity",
          {{"hostId", "host"},
           {"owner", own},
           {"role", "web"},
           {"accountId", "mailbox"},
           {"expires", expiry},
           {"permissions", {{"access", true}, {"projects", manage}, {"configuration", manage}}}}}});
    std::string header;
    for (const auto &d : f.wire)
      if (d.value("link", "") == link) {
        if (d.at("type") == "channel-key")
          header = cipher.exchange(d.at("data"));
        if (d.at("type") == "channel-header")
          cipher.accept(d.at("data"));
      }
    f.endpoint.receive({{"type", "channel-header"}, {"link", link}, {"data", header}});
    pump();
  }
  void pump() {
    for (; cursor < f.wire.size(); ++cursor) {
      const auto d = f.wire[cursor];
      if (d.value("link", "") != link || d.at("type") != "channel-data")
        continue;
      const auto part = cipher.open(d.at("data"));
      partial += part.substr(1);
      if (part[0] == '1') {
        packets.push_back(Json::parse(partial));
        partial.clear();
      }
    }
  }
  void send(Json packet) {
    for (const auto &part : secure_fragments(packet))
      f.endpoint.receive({{"type", "channel-data"}, {"link", link}, {"data", cipher.seal(part)}});
    pump();
  }
  Json request(const std::string &path, Json body = nullptr, std::string request = "request") {
    send({{"type", "request"},
          {"id", uuid()},
          {"path", path},
          {"body", body},
          {"requestId", request}});
    return packets.back();
  }
  Json claim(const std::string &session = "host~one", bool takeover = false,
             const std::string &id = "claim") {
    return request("/sessions/" + session + (takeover ? "/takeover" : "/attach"),
                   {{"claimId", id}, {"delivery", 2}});
  }
  Json controller(const std::string &ticket, const std::string &session = "host~one") {
    const auto id = uuid();
    controller_id = id;
    send({{"type", "open"}, {"id", id}, {"path", "/ws/v1/web/" + session}});
    send({{"type", "stream"}, {"id", id}, {"frame", {{"type", "auth"}, {"ticket", ticket}}}});
    for (auto it = packets.rbegin(); it != packets.rend(); ++it)
      if (it->contains("frame"))
        return it->at("frame");
    throw std::runtime_error("Controller did not reply");
  }
};
void permissions() {
  Fixture f;
  Peer a(f);
  check(a.request("/hosts/host/project-management", {{"operation", "register"}})
                .at("error")
                .at("code") == "FORBIDDEN",
        "Ordinary client cannot manage projects");
  check(a.request("/admin/hosts/host/configuration").at("error").at("code") == "FORBIDDEN",
        "Self reported admin path cannot elevate role");
  check(a.request("/hosts/other/projects").at("error").at("code") == "FORBIDDEN",
        "Host binding prevents cross host calls");
  check(f.business.empty(), "Denied calls never reach business handler");
  a.request("/hosts/host/projects");
  check(f.business.size() == 1, "Ordinary project reads remain supported");
  auto reply = a.claim();
  const auto ticket = reply.at("data").at("ticket").get<std::string>();
  Peer b(f, "other");
  auto rejected = b.controller(ticket);
  check(rejected.at("error").at("code") == "STALE_CONTROLLER",
        "Ticket cannot be copied to another owner");
}
void fencing() {
  Fixture f;
  Peer a(f);
  auto ticket = a.claim().at("data").at("ticket");
  auto active = a.controller(ticket);
  const auto epoch = active.at("epoch").get<int64_t>();
  f.endpoint.receive({{"type", "channel-retire"}, {"link", a.link}, {"event", "revocation-event"}});
  check(!f.endpoint.can_dispatch("host~one", epoch),
        "Revocation removes dispatch eligibility before acknowledgement");
  check(f.wire.back().at("type") == "channel-retired",
        "Endpoint confirms retirement after local fence");
  const auto count = f.business.size();
  a.send(
      {{"type", "request"}, {"id", uuid()}, {"path", "/hosts/host/projects"}, {"body", nullptr}});
  check(f.business.size() == count, "Late encrypted packets after revocation cannot dispatch");
}
void expiry_and_private_state() {
  Fixture f;
  Peer a(f);
  auto ticket = a.claim().at("data").at("ticket");
  auto session = f.store.get("host~one");
  session["endpointLease"]["reservedUntil"] = now() - 1;
  f.store.save(session);
  auto expired = a.controller(ticket);
  check(expired.at("error").at("code") == "ATTACH_EXPIRED", "Expired unused ticket cannot attach");
  auto renewed = a.claim();
  auto active = a.controller(renewed.at("data").at("ticket"));
  check(!a.request("/sessions/host~one").at("data").contains("endpointLease"),
        "Private lease is not returned in session data");
  f.endpoint.receive({{"type", "channel-retire"}, {"link", "*"}, {"event", "endpoint-revoked"}});
  check(!f.endpoint.can_dispatch("host~one", active.at("epoch")),
        "Endpoint credential retirement fences every link");
  check(f.wire.back().at("type") == "channel-retired",
        "Wildcard retirement is acknowledged after fencing");
}
void takeover_and_restart() {
  Fixture f;
  Peer a(f), b(f, "other");
  auto ticket = a.claim().at("data").at("ticket");
  const auto old = a.controller(ticket);
  auto next = b.claim("host~one", true, "takeover");
  check(next.contains("data"), "Explicit takeover succeeds");
  check(!f.endpoint.can_dispatch("host~one", old.at("epoch")),
        "Control epoch replacement fences old controller");
  auto current = b.controller(next.at("data").at("ticket"));
  check(current.at("epoch").get<int64_t>() > old.at("epoch").get<int64_t>(),
        "Connection generations remain monotonic across takeovers");
  check(current.at("control").at("controlEpoch") == 2, "Takeover increments control epoch once");
  b.claim("host~one", true, "takeover");
  check(f.store.control_state("host~one").at("controlEpoch") == 2,
        "Lost takeover reply does not add epochs");
  f.endpoint.disconnected();
  check(!f.endpoint.can_dispatch("host~one", current.at("epoch")),
        "Relay loss disables dispatch but preserves durable proof");
  check(f.store.control_state("host~one").at("controlEpoch") == 2,
        "Relay loss preserves persisted control");
}
void persisted_claim() {
  const auto dir = (std::filesystem::temp_directory_path() / ("coc-claim-" + uuid())).string();
  Fixture::Cleanup cleanup{dir};
  Json original;
  {
    Store store(dir);
    store.save({{"id", "host~persisted"},
                {"mode", "web"},
                {"projectId", "project"},
                {"state", "ready"},
                {"createdAt", now()}});
    original = store.endpoint_claim("host~persisted", "owner", "claim", false, nullptr);
    original = store.endpoint_attach("host~persisted", "owner", original.at("ticket"));
    store.endpoint_stream("host~persisted", "owner", "original-stream");
  }
  {
    Store store(dir);
    check(store.control_state("host~persisted").at("controlId") == original.at("controlId"),
          "Control identity survives closing and reopening the Agent database");
    auto resumed = store.endpoint_claim("host~persisted", "owner", "claim", false, nullptr);
    check(resumed.at("controlEpoch") == original.at("controlEpoch") &&
              resumed.at("stream") == "original-stream" &&
              resumed.at("ticket") != original.at("ticket"),
          "Restart resumes the same control with a fresh one-use ticket");
    auto attached = store.endpoint_attach("host~persisted", "owner", resumed.at("ticket"));
    check(attached.at("connectionGeneration").get<int64_t>() >
              original.at("connectionGeneration").get<int64_t>(),
          "Reopened database advances the connection generation");
  }
}
void project_handoff() {
  Fixture f;
  Peer a(f), b(f, "other");
  auto first = a.claim();
  a.controller(first.at("data").at("ticket"));
  check(b.claim("host~two").at("error").at("code") == "PROJECT_READ_ONLY",
        "A live controller excludes other writers in the project");
  f.endpoint.receive({{"type", "channel-close"}, {"link", a.link}});
  check(b.claim("host~two").contains("data"),
        "Disconnect releases the project immediately after the one-use ticket was consumed");
}
} // namespace
int main() {
  try {
    permissions();
    expiry_and_private_state();
    fencing();
    takeover_and_restart();
    persisted_claim();
    project_handoff();
    // Resume requires a stream that has actually been allocated.
    {
      Fixture f;
      Peer a(f);
      auto first = a.claim();
      auto active = a.controller(first.at("data").at("ticket"));
      a.send({{"type", "stream"},
              {"id", a.controller_id},
              {"frame",
               {{"type", "delivery-open"},
                {"stream", "stream"},
                {"exchangeId", "exchange"},
                {"received", {{"normal", 0}, {"priority", 0}}},
                {"receivedBytes", {{"normal", 0}, {"priority", 0}}}}}});
      a.send(
          {{"type", "stream"},
           {"id", a.controller_id},
           {"frame",
            {{"type", "delivery-query"}, {"stream", "stream"}, {"lane", "normal"}, {"seq", 7}}}});
      check(a.packets.back().at("frame").at("seq") == 7,
            "Recovery replies preserve the requested command sequence");
      f.store.endpoint_stream("host~one", "owner", "stream");
      auto lease = f.store.get("host~one").at("endpointLease");
      auto next =
          f.store.endpoint_claim("host~one", "owner", "new-claim", false,
                                 {{"stream", "stream"}, {"controller", lease.at("controller")}});
      check(next.at("controlEpoch") == active.at("control").at("controlEpoch"),
            "Original delivery resume preserves epoch");
    }
    {
      Fixture f;
      Peer a(f), b(f, "other");
      auto first = a.claim();
      auto original = f.store.get("host~one").at("endpointLease");
      check(a.claim().at("data") == first.at("data"), "Lost claim reply is stable");
      check(b.claim("host~two").at("error").at("code") == "PROJECT_READ_ONLY",
            "Pending project claims are exclusive");
      auto ready = a.controller(first.at("data").at("ticket"));
      auto replay = a.controller(first.at("data").at("ticket"));
      check(replay.at("error").at("code") == "STALE_CONTROLLER",
            "An attached ticket cannot be replayed");
      auto renewed = a.claim();
      auto again = a.controller(renewed.at("data").at("ticket"));
      check(!f.endpoint.can_dispatch("host~one", ready.at("epoch")),
            "Previous generation is fenced");
      check(again.at("control").at("controlEpoch") == original.at("controlEpoch"),
            "Attach preserves control epoch");
    }
    std::cout
        << "Endpoint encrypted authorization, claims, takeover, resume and retirement passed\n";
    return 0;
  } catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
}
