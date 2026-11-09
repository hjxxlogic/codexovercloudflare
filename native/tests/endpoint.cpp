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
void project_sessions() {
  Fixture f;
  Peer a(f), b(f, "other");
  auto first = a.claim();
  auto active_a = a.controller(first.at("data").at("ticket"));
  auto second = b.claim("host~two");
  check(second.contains("data"), "Same project sessions claim independent controls");
  auto active_b = b.controller(second.at("data").at("ticket"), "host~two");
  check(f.endpoint.can_dispatch("host~one", active_a.at("epoch")) &&
            f.endpoint.can_dispatch("host~two", active_b.at("epoch")),
        "Both sessions remain writable in the same project");
  Peer rival(f, "rival");
  check(rival.claim().at("error").at("code") == "SESSION_BUSY",
        "Each session still requires explicit takeover");
  auto taken = rival.claim("host~one", true);
  rival.controller(taken.at("data").at("ticket"));
  check(!f.endpoint.can_dispatch("host~one", active_a.at("epoch")) &&
            f.endpoint.can_dispatch("host~two", active_b.at("epoch")),
        "Taking over one session does not fence another in the same project");
  f.endpoint.receive({{"type", "channel-close"}, {"link", rival.link}});
  check(f.endpoint.can_dispatch("host~two", active_b.at("epoch")),
        "Closing one controller preserves the other session");
}
void browser_handoff() {
  Fixture f;
  Peer desktop(f), phone(f), reopened(f);
  auto first = desktop.claim("host~one", false, "desktop");
  auto old = desktop.controller(first.at("data").at("ticket"));
  check(phone.claim("host~one", false, "phone").at("error").at("code") == "SESSION_BUSY",
        "A live desktop requires explicit takeover");
  auto taken = phone.claim("host~one", true, "phone");
  auto active = phone.controller(taken.at("data").at("ticket"));
  check(!f.endpoint.can_dispatch("host~one", old.at("epoch")), "Phone takeover fences the desktop");
  f.endpoint.receive({{"type", "channel-close"}, {"link", desktop.link}});
  check(reopened.claim("host~one", false, "reopened").at("error").at("code") == "SESSION_BUSY",
        "Closing a fenced desktop does not release the phone");
  f.endpoint.receive({{"type", "channel-close"}, {"link", phone.link}});
  auto next = reopened.claim("host~one", false, "reopened");
  check(next.contains("data"), "A new browser can attach immediately after the phone closes");
  Peer rival(f);
  check(rival.claim("host~one", false, "rival").at("error").at("code") == "SESSION_BUSY",
        "An unused ticket reserves control before the browser connects");
  auto resumed = reopened.controller(next.at("data").at("ticket"));
  check(resumed.at("control").at("controlEpoch").get<int64_t>() >
            active.at("control").at("controlEpoch").get<int64_t>(),
        "Reopening advances the control epoch and fences old commands");
  reopened.send({{"type", "close"}, {"id", reopened.controller_id}});
  check(rival.claim("host~one", false, "rival").contains("data"),
        "Closing only the control stream also releases control");
  auto reserved = f.store.get("host~one");
  reserved["endpointLease"]["reservedUntil"] = now() - 1;
  f.store.save(reserved);
  check(reopened.claim("host~one", false, "new-tab").contains("data"),
        "An expired unused reservation does not block a new page");
  auto attached = reopened.controller(reopened.packets.back().at("data").at("ticket"));
  check(attached.at("type") == "attached", "New page attaches after reservation expiry");
  f.endpoint.disconnected();
  Peer after_restart(f);
  check(after_restart.claim("host~one", false, "after-restart").contains("data"),
        "Persisted connection generations do not block a fresh browser after disconnection");
}
} // namespace
int main() {
  try {
    permissions();
    expiry_and_private_state();
    fencing();
    takeover_and_restart();
    persisted_claim();
    project_sessions();
    browser_handoff();
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
      check(b.claim("host~two").contains("data"),
            "Pending claims for different sessions in one project are independent");
      check(b.claim().at("error").at("code") == "SESSION_BUSY",
            "Pending claims for the same session remain exclusive");
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
