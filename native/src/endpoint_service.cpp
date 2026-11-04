#include "coc/delivery.hpp"
#include "coc/endpoint.hpp"
#include <regex>
namespace coc {
namespace {
std::string decode_url(std::string text) {
  std::string out;
  for (size_t i = 0; i < text.size(); ++i) {
    if (text[i] == '%' && i + 2 < text.size()) {
      const auto hex = text.substr(i + 1, 2);
      if (!std::regex_match(hex, std::regex("[0-9a-fA-F]{2}")))
        throw Error("INVALID_REQUEST", "Invalid URL encoding");
      out += static_cast<char>(std::stoi(hex, nullptr, 16));
      i += 2;
    } else
      out += text[i] == '+' ? ' ' : text[i];
  }
  return out;
}
Json parameters(const std::string &path) {
  Json args = Json::object();
  auto at = path.find('?');
  if (at == std::string::npos)
    return args;
  std::string query = path.substr(at + 1);
  for (size_t i = 0; i < query.size();) {
    const auto end = query.find('&', i), equal = query.find('=', i);
    const auto length = end == std::string::npos ? query.size() : end;
    if (equal < length) {
      const auto key = decode_url(query.substr(i, equal - i)),
                 value = decode_url(query.substr(equal + 1, length - equal - 1));
      if (std::regex_match(key,
                           std::regex("after|before|historyVersion|snapshotGeneration|offset|"
                                      "contentSeq|seq|resultReceived|resultBytes|streamSerial"))) {
        if (!std::regex_match(value, std::regex("[0-9]{1,16}")))
          throw Error("INVALID_REQUEST", "Invalid numeric query");
        const auto number = std::stoll(value);
        if (number > 9007199254740991LL)
          throw Error("INVALID_REQUEST", "Query counter too large");
        args[key] = number;
      } else if (key == "paged" || key == "mine")
        args[key] = value == "true";
      else
        args[key] = value;
    }
    if (end == std::string::npos)
      break;
    i = end + 1;
  }
  return args;
}
Json proof(const Json &lease) {
  Json result;
  for (const auto *key : {"controlEpoch", "controlId", "owner", "connectionGeneration"})
    result[key] = lease.at(key);
  return result;
}
std::string lane_stream(const std::string &owner, const std::string &session,
                        const std::string &stream, const std::string &lane) {
  if (!valid_id(stream) || (lane != "normal" && lane != "priority"))
    throw Error("INVALID_REQUEST", "Invalid stream identity");
  return delivery_digest(Json::array({owner, session, stream, lane}).dump());
}
} // namespace
EndpointService::EndpointService(Store &store, std::string host, Send wire, Receive receive)
    : store_(store), host_(std::move(host)), wire_(std::move(wire)), business_(std::move(receive)) {
}
std::string EndpointService::owner(const std::string &link) const {
  return links_.at(link).identity.at("owner");
}
void EndpointService::require_access(const std::string &link, const std::string &permission) {
  const auto it = links_.find(link);
  if (it == links_.end() || it->second.identity.value("expires", int64_t(0)) <= now())
    throw Error("UNAUTHORIZED", "Endpoint connection expired");
  const auto &p = it->second.identity.at("permissions");
  if (!permission.empty() && !p.value(permission, false))
    throw Error("FORBIDDEN", "Connection permission does not allow this operation");
}
void EndpointService::check_session(const std::string &link, const std::string &id) {
  require_access(link, "access");
  if (id.rfind(host_ + "~", 0) != 0)
    throw Error("FORBIDDEN", "Session belongs to another host");
  const auto session = store_.get(id);
  if (session.at("mode") != links_.at(link).identity.at("role"))
    throw Error("FORBIDDEN", "Credential mode mismatch");
}
void EndpointService::emit(const std::string &link, const Json &packet) {
  auto it = links_.find(link);
  if (it == links_.end())
    return;
  if (it->second.identity.value("expires", int64_t(0)) <= now())
    return;
  if (!it->second.cipher->ready())
    throw Error("AGENT_NEGOTIATING", "Encrypted channel not ready");
  for (const auto &part : secure_fragments(packet))
    wire_({{"type", "channel-data"}, {"link", link}, {"data", it->second.cipher->seal(part)}});
}
void EndpointService::call(const std::string &link, const std::string &action, Json data,
                           Json original, std::function<void(Json)> done) {
  require_access(link);
  for (auto it = pending_.begin(); it != pending_.end();)
    if (it->second.expires <= now())
      it = pending_.erase(it);
    else
      ++it;
  if (pending_.size() >= 128)
    throw Error("BACKPRESSURE", "Endpoint request budget exhausted");
  const auto id = uuid();
  Json command = {{"type", "control"}, {"requestId", id}, {"action", action}, {"data", data}};
  if (!original.is_null()) {
    original["owner"] = owner(link);
    command["intent"] = original;
  }
  pending_[id] = {link, id, now() + 30000, std::move(done)};
  try {
    business_(command);
  } catch (...) {
    pending_.erase(id);
    throw;
  }
}
bool EndpointService::receive(const Json &d) {
  const auto type = d.value("type", "");
  if (type == "channel-welcome" || type == "channel-registered")
    return false;
  if (type == "channel-open") {
    const auto id = d.at("link").get<std::string>();
    if (links_.size() >= 256 || links_.count(id))
      throw Error("BACKPRESSURE", "Endpoint link budget exhausted");
    const auto identity = d.at("identity");
    if (identity.at("hostId") != host_ || !valid_id(id) ||
        identity.at("expires").get<int64_t>() <= now())
      throw Error("FORBIDDEN", "Invalid endpoint binding");
    Link link;
    link.identity = identity;
    link.cipher = std::make_unique<SecureChannel>(false, d.at("binding"));
    auto header = link.cipher->exchange(d.at("key"));
    const auto key = link.cipher->public_key();
    links_.emplace(id, std::move(link));
    wire_({{"type", "channel-key"}, {"link", id}, {"data", key}});
    wire_({{"type", "channel-header"}, {"link", id}, {"data", header}});
    return true;
  }
  if (type.rfind("channel-", 0) != 0)
    return false;
  const auto id = d.value("link", "");
  if (type == "channel-close" || type == "channel-retire") {
    if (id == "*") {
      disconnected();
      if (type == "channel-retire")
        wire_({{"type", "channel-retired"}, {"event", d.at("event")}});
      return true;
    }
    auto it = links_.find(id);
    if (it != links_.end()) {
      auto streams = std::move(it->second.streams);
      links_.erase(it);
      for (const auto &[key, stream] : streams)
        detach(id, stream);
    }
    for (auto p = pending_.begin(); p != pending_.end();)
      if (p->second.link == id)
        p = pending_.erase(p);
      else
        ++p;
    if (type == "channel-retire")
      wire_({{"type", "channel-retired"}, {"event", d.at("event")}});
    return true;
  }
  auto it = links_.find(id);
  if (it == links_.end())
    return true;
  try {
    require_access(id);
    if (type == "channel-header")
      it->second.cipher->accept(d.at("data"));
    else if (type == "channel-data") {
      const auto chunk = it->second.cipher->open(d.at("data"));
      if (chunk.empty() || (chunk[0] != '0' && chunk[0] != '1') ||
          it->second.partial.size() + chunk.size() - 1 > max_queue)
        throw Error("INVALID_REQUEST", "Invalid endpoint fragments");
      it->second.partial += chunk.substr(1);
      if (chunk[0] == '1') {
        auto payload = Json::parse(it->second.partial);
        it->second.partial.clear();
        packet(id, payload);
      }
    }
  } catch (...) {
    receive({{"type", "channel-close"}, {"link", id}});
    wire_({{"type", "channel-close"}, {"link", id}});
  }
  return true;
}
void EndpointService::detach(const std::string &link, const Stream &stream) {
  try {
    if (stream.kind == "controller" && stream.state.contains("control"))
      business_({{"type", "detach"},
                 {"sessionId", stream.session},
                 {"epoch", stream.state.at("control").at("connectionGeneration")}});
    if (stream.kind == "history")
      business_({{"type", "history-detached"}, {"route", link + "-" + stream.id}});
    if (stream.kind == "terminal")
      business_(
          {{"type", "terminal-stream"}, {"route", link + "-" + stream.id}, {"detached", true}});
  } catch (const std::exception &) { /* Already closed runtimes need no further cleanup. */
  }
}
void EndpointService::fence(const std::string &session, const Json &lease) {
  for (auto &[link, peer] : links_) {
    for (auto it = peer.streams.begin(); it != peer.streams.end();) {
      const auto &s = it->second;
      if (s.session != session || (s.kind != "controller" && s.kind != "terminal") ||
          !s.state.contains(s.kind == "controller" ? "control" : "scope")) {
        ++it;
        continue;
      }
      const auto control =
          s.kind == "controller" ? s.state.at("control") : s.state.at("scope").at("control");
      if (control == proof(lease)) {
        ++it;
        continue;
      }
      auto old = s;
      it = peer.streams.erase(it);
      emit(link, {{"type", "closed"}, {"id", old.id}, {"code", 4009}});
      detach(link, old);
    }
  }
}
void EndpointService::disconnected() {
  while (!links_.empty())
    receive({{"type", "channel-close"}, {"link", links_.begin()->first}});
  pending_.clear();
}
bool EndpointService::can_dispatch(const std::string &session, int64_t generation) {
  const auto lease = store_.get(session).value("endpointLease", Json());
  if (lease.is_null() || lease.at("connectionGeneration") != generation)
    return false;
  const auto current = store_.control_state(session);
  if (current.is_null())
    return false;
  for (const auto &[link, peer] : links_) {
    if (peer.identity.value("expires", int64_t(0)) <= now())
      continue;
    for (const auto &[id, stream] : peer.streams)
      if (stream.kind == "controller" && stream.session == session &&
          stream.state.contains("control")) {
        const auto control = stream.state.at("control");
        if (control.at("controlEpoch") == current.at("controlEpoch") &&
            control.at("controlId") == current.at("controlId") &&
            control.at("connectionGeneration") == generation &&
            peer.identity.at("owner") == current.at("owner"))
          return true;
      }
  }
  return false;
}
void EndpointService::packet(const std::string &link, const Json &d) {
  const auto type = d.value("type", ""), id = d.value("id", "");
  if (!valid_id(id))
    throw Error("INVALID_REQUEST", "Invalid endpoint message identity");
  if (type == "request") {
    try {
      request(link, d);
    } catch (const std::exception &error) {
      emit(link, {{"type", "response"}, {"id", id}, {"error", error_data(error)}});
    }
    return;
  }
  if (type == "open") {
    auto &peer = links_.at(link);
    if (peer.streams.size() >= 128 || peer.streams.count(id))
      throw Error("BACKPRESSURE", "Logical stream budget exhausted");
    Stream stream;
    stream.id = id;
    stream.path = d.at("path");
    std::smatch match;
    if (std::regex_search(stream.path, match, std::regex("/ws/v1/(web|cli|history)/([\\w~-]+)"))) {
      stream.kind = match[1] == "history" ? "history" : "controller";
      stream.session = match[2];
      check_session(link, stream.session);
      if (stream.kind == "controller" && match[1] != peer.identity.at("role"))
        throw Error("FORBIDDEN", "Wrong stream mode");
    } else if (stream.path.find("/terminal") != std::string::npos) {
      require_access(link, "access");
      if (peer.identity.at("role") != "web")
        throw Error("FORBIDDEN", "Web required");
      stream.kind = "terminal";
    } else if (stream.path.find("/hosts/") != std::string::npos) {
      require_access(link, "access");
      stream.kind = "notification";
    } else
      throw Error("UNSUPPORTED_ACTION", "Unknown logical stream");
    peer.streams[id] = stream;
    if (stream.kind == "history")
      emit(link, {{"type", "opened"}, {"id", id}, {"frame", {{"type", "history-ready"}}}});
    else if (stream.kind == "notification")
      emit(link,
           {{"type", "opened"}, {"id", id}, {"frame", {{"type", "subscribed"}, {"demand", 1}}}});
    else {
      emit(link, {{"type", "opened"}, {"id", id}});
      if (stream.path.find("?ticket=") != std::string::npos)
        stream = peer.streams[id],
        this->stream(link, peer.streams[id],
                     {{"type", "auth"}, {"ticket", parameters(stream.path).at("ticket")}});
    }
    return;
  }
  if (type == "stream") {
    auto &streams = links_.at(link).streams;
    auto it = streams.find(id);
    if (it == streams.end())
      throw Error("NOT_FOUND", "Unknown logical stream");
    try {
      stream(link, it->second, d.at("frame"));
    } catch (const std::exception &error) {
      emit(link, {{"type", "stream"},
                  {"id", id},
                  {"frame",
                   {{"type", "error"},
                    {"requestId", d.at("frame").value("requestId", Json())},
                    {"error", error_data(error)}}}});
      if (d.at("frame").value("type", "") == "auth") {
        streams.erase(id);
        emit(link, {{"type", "closed"}, {"id", id}, {"code", 4009}});
      }
    }
    return;
  }
  if (type == "close") {
    auto &streams = links_.at(link).streams;
    auto it = streams.find(id);
    if (it != streams.end()) {
      auto copy = it->second;
      streams.erase(it);
      detach(link, copy);
    }
    return;
  }
  throw Error("INVALID_REQUEST", "Unknown endpoint packet");
}
void EndpointService::request(const std::string &link, const Json &d) {
  std::string path = d.at("path"), id = d.at("id");
  if (path.rfind("/api/v1", 0) == 0)
    path = path.substr(7);
  auto args = parameters(path);
  const auto q = path.find('?');
  if (q != std::string::npos)
    path.resize(q);
  const auto body = d.value("body", Json());
  if (!body.is_null()) {
    if (!body.is_object())
      throw Error("INVALID_REQUEST", "Request body must be an object");
    args.update(body);
  }
  const auto &identity = links_.at(link).identity;
  const auto own = owner(link);
  std::string action, session;
  std::smatch match;
  if (std::regex_match(
          path, match,
          std::regex(
              "/(?:admin/)?hosts/([\\w-]+)/"
              "(projects|project-management|probe|threads|files|terminal|configuration|build)"))) {
    if (match[1] != host_)
      throw Error("FORBIDDEN", "Wrong host");
    const auto name = match[2].str();
    action = name == "project-management" ? "projectManage" : name;
    if (action == "projectManage") {
      if (!args.contains("operation"))
        args["operation"] = "list";
      if (args.value("operation", "list") != "list")
        require_access(link, "projects");
      else if (!identity.at("permissions").value("projects", false))
        require_access(link, "access");
      if (args.contains("requestId"))
        args["requestId"] = delivery_digest(own + ":" + args.at("requestId").get<std::string>());
    } else if (action == "configuration" || action == "build")
      require_access(link, "configuration");
    else if (action != "probe")
      require_access(link, "access");
    if ((action == "files" || action == "terminal") && identity.at("role") != "web")
      throw Error("FORBIDDEN", "Web credential required");
    if (action == "terminal" &&
        (args.value("operation", "") == "read" || args.value("operation", "") == "input" ||
         args.value("operation", "") == "resize"))
      throw Error("UPGRADE_REQUIRED", "Use Terminal stream");
    if (action == "configuration") {
      Json command = body.is_null() ? Json{{"action", "metadata"}} : args.at("command");
      business_({{"type", "management-request"},
                 {"wire", id},
                 {"data", command},
                 {"endpointLink", link}});
      return;
    }
  } else if (path == "/sessions") {
    require_access(link, "access");
    action = body.is_null() ? "list" : "create";
    if (args.contains("mode") && args.at("mode") != identity.at("role"))
      throw Error("FORBIDDEN", "Session mode must match credential");
    if (args.contains("hostId") && args.at("hostId") != host_)
      throw Error("FORBIDDEN", "Session host must match connection");
    args["hostId"] = host_;
    args.erase("endpointLease");
    args["mode"] = identity.at("role");
    args["cwAccountId"] = identity.at("accountId");
    if (args.value("mine", false)) {
      if (identity.value("accountId", "").empty())
        throw Error("FORBIDDEN", "Verified mailbox required");
      args["cwAccountId"] = identity.at("accountId");
    } else if (action == "list")
      args.erase("cwAccountId");
  } else if (std::regex_match(path, match,
                              std::regex("/sessions/([\\w~-]+)(?:/"
                                         "(attach|takeover|stop|approvals|approval|queue|delivery|"
                                         "snapshot|history))?"))) {
    session = match[1];
    const auto name = match[2].str();
    require_access(link, "access");
    if ((name == "stop" || name == "queue" || name == "approval") && !d.contains("intent"))
      throw Error("UPGRADE_REQUIRED", "Mutation requires persisted original request");
    check_session(link, session);
    if (name == "attach" || name == "takeover") {
      if (args.value("delivery", 0) != 2)
        throw Error("UPGRADE_REQUIRED", "delivery:2 required");
      const auto info = store_.get(session);
      // Project ownership stays local; another live controller cannot be bypassed.
      for (const auto &other : store_.sessions(true)) {
        if (other.at("id") == session || other.at("projectId") != info.at("projectId"))
          continue;
        const auto lease = other.value("endpointLease", Json());
        if (!lease.is_null() && ((!lease.value("ticketUsed", false) &&
                                  lease.value("reservedUntil", int64_t(0)) > now()) ||
                                 can_dispatch(other.at("id"), lease.at("connectionGeneration"))))
          throw Error("PROJECT_READ_ONLY", "Another session controls this project");
      }
      if (info.at("state") != "ready")
        throw Error("SESSION_CLOSED", "Session is not ready");
      const auto claim = args.value("claimId", d.value("requestId", uuid()));
      const auto lease = store_.endpoint_claim(session, own, claim, name == "takeover",
                                               args.value("resume", Json()));
      fence(session, lease);
      emit(link, {{"type", "response"},
                  {"id", id},
                  {"data",
                   {{"ticket", lease.at("ticket")},
                    {"delivery", 2},
                    {"mode", info.at("mode")},
                    {"sandbox", info.value("sandbox", "workspace-write")}}}});
      return;
    }
    action = name == "approvals"  ? "approvals"
             : name == "approval" ? "answer"
             : name.empty()       ? "get"
                                  : name;
    args["sessionId"] = session;
    args["mode"] = identity.at("role");
    if (action == "delivery") {
      const auto external = args.at("stream").get<std::string>();
      const auto lane = args.at("lane").get<std::string>();
      if (d.contains("headers") && d.at("headers").contains("X-CoC-Controller"))
        args["controller"] = d.at("headers").at("X-CoC-Controller");
      if (args.contains("controller")) {
        const auto lease = store_.get(session).value("endpointLease", Json());
        if (lease.is_null() || lease.at("owner") != own ||
            args.value("controller", "") != lease.value("controller", ""))
          throw Error("STALE_CONTROLLER", "Wrong controller identity");
        store_.endpoint_stream(session, own, external);
        if (args.contains("exchangeId"))
          args["control"] = proof(lease);
      }
      args["stream"] = lane_stream(own, session, external, lane);
      args.erase("operation");
      const auto frameType = args.value("type", "");
      if (frameType == "delivery-receipt") {
        business_(args);
        emit(link, {{"type", "response"}, {"id", id}, {"data", {{"ok", true}}}});
        return;
      }
      if (frameType == "delivery-command") {
        const auto lease = store_.get(session).value("endpointLease", Json());
        if (lease.is_null() || lease.at("owner") != own ||
            args.value("controller", "") != lease.value("controller", "") ||
            lease.at("stream") != external ||
            !can_dispatch(session, lease.at("connectionGeneration")))
          throw Error("STALE_CONTROLLER", "Reliable command requires current controller");
        business_({{"type", identity.at("role") == "cli" ? "rpc" : "web"},
                   {"sessionId", session},
                   {"epoch", lease.at("connectionGeneration")},
                   {"payload", Json::parse(args.at("body").get<std::string>())},
                   {"delivery", args}});
        emit(link, {{"type", "response"}, {"id", id}, {"data", {{"sent", true}}}});
        return;
      }
    }
  } else
    throw Error("UNSUPPORTED_ACTION", "Unknown endpoint request");
  args["owner"] = own;
  if ((action == "answer" || action == "queue") && !args.contains("requestId"))
    args["requestId"] = d.at("requestId");
  Json original;
  if (d.contains("intent")) {
    original = d.at("intent");
    original["requestId"] = d.at("requestId");
  }
  if (operation_write(action, args) && original.is_null())
    throw Error("UPGRADE_REQUIRED", "Mutation requires persisted original request");
  call(link, action, args, original, [this, link, id, action](Json result) {
    if (result.contains("data")) {
      auto &data = result["data"];
      if (action == "projectManage" && data.is_object())
        data["canManage"] = links_.at(link).identity.at("permissions").value("projects", false);
      if ((action == "get" || action == "create" || action == "stop") && data.is_object())
        data.erase("endpointLease");
      if (action == "list") {
        auto &rows = data.is_array() ? data : data["data"];
        for (auto &session : rows)
          session.erase("endpointLease");
      }
      if (action == "snapshot" && data.contains("session"))
        data["session"].erase("endpointLease");
    }
    result["type"] = "response";
    result["id"] = id;
    result.erase("requestId");
    emit(link, result);
  });
}
void EndpointService::stream(const std::string &link, Stream &s, const Json &frame) {
  const auto type = frame.value("type", "");
  const auto send = [this, link, id = s.id](Json result) {
    emit(link, {{"type", "stream"}, {"id", id}, {"frame", result}});
  };
  if (type == "receipt")
    return;
  if (s.kind == "notification")
    throw Error("FORBIDDEN", "Read only notification stream");
  if (s.kind == "history") {
    check_session(link, s.session);
    auto args = frame;
    args.erase("requestId");
    args["sessionId"] = s.session;
    args["owner"] = owner(link);
    args["route"] = link + "-" + s.id;
    const auto request = frame.value("requestId", Json());
    const auto op = args.value("operation", "page");
    call(link, "history", args, nullptr, [send, request, op](Json result) {
      if (result.contains("error")) {
        send({{"type", "error"}, {"requestId", request}, {"error", result.at("error")}});
        return;
      }
      auto out = result.at("data");
      out["type"] =
          (op == "subscribe" || op == "ack" || op == "retire") ? "history-window" : "history";
      out["requestId"] = request;
      send(out);
    });
    return;
  }
  if (s.kind == "terminal") {
    if (type != "terminal-stream")
      throw Error("INVALID_REQUEST", "Terminal envelope required");
    auto payload = frame.at("frame");
    if (payload.value("type", "") == "bind") {
      const auto session = payload.at("sessionId").get<std::string>();
      check_session(link, session);
      const auto lease = store_.get(session).value("endpointLease", Json());
      if (lease.is_null() || lease.at("owner") != owner(link) ||
          payload.at("control") != proof(lease) ||
          !can_dispatch(session, lease.at("connectionGeneration")))
        throw Error("STALE_CONTROLLER", "Terminal requires current controller");
      auto scope = payload;
      scope["owner"] = owner(link);
      scope["operation"] = "stream";
      s.state["scope"] = scope;
      s.session = session;
    }
    if (!s.state.contains("scope"))
      throw Error("FORBIDDEN", "Bind Terminal first");
    const auto lease = store_.get(s.session).value("endpointLease", Json());
    if (!can_dispatch(s.session, lease.at("connectionGeneration")))
      throw Error("STALE_CONTROLLER", "Terminal controller retired");
    business_({{"type", "terminal-stream"},
               {"route", link + "-" + s.id},
               {"scope", s.state.at("scope")},
               {"frame", payload}});
    return;
  }
  check_session(link, s.session);
  if (type == "auth") {
    if (s.state.contains("control"))
      throw Error("STALE_CONTROLLER", "Already attached");
    auto lease = store_.endpoint_attach(s.session, owner(link), frame.at("ticket"));
    fence(s.session, lease);
    const auto control = proof(lease);
    auto resume = lease.value("stream", "");
    if (!resume.empty())
      resume = lane_stream(owner(link), s.session, resume, "normal");
    call(link, "attach",
         {{"sessionId", s.session},
          {"epoch", lease.at("connectionGeneration")},
          {"expires", now() + 15000},
          {"cwAccountId", links_.at(link).identity.at("accountId")},
          {"deliveryResume", resume}},
         nullptr, [this, link, id = s.id, lease, control, send](Json result) {
           if (result.contains("error")) {
             send({{"type", "error"}, {"error", result.at("error")}});
             return;
           }
           auto it = links_.find(link);
           if (it == links_.end() || !it->second.streams.count(id))
             return;
           it->second.streams[id].state["control"] = control;
           it->second.streams[id].state["controller"] = lease.at("controller");
           send({{"type", it->second.identity.at("role") == "cli" ? "delivery-ready" : "attached"},
                 {"epoch", lease.at("connectionGeneration")},
                 {"controller", lease.at("controller")},
                 {"control", control},
                 {"delivery", 2},
                 {"instance", store_.delivery_instance()}});
         });
    return;
  }
  if (!s.state.contains("control") ||
      !can_dispatch(s.session, s.state.at("control").at("connectionGeneration")))
    throw Error("STALE_CONTROLLER", "Controller retired");
  const auto control = s.state.at("control");
  const auto role = links_.at(link).identity.at("role").get<std::string>();
  if (type == "delivery-open") {
    store_.endpoint_stream(s.session, owner(link), frame.at("stream"));
    s.state["stream"] = frame.at("stream");
    for (const auto *lane : {"normal", "priority"}) {
      Json args = {{"sessionId", s.session},
                   {"mode", role},
                   {"lane", lane},
                   {"exchangeId", frame.at("exchangeId")},
                   {"control", control},
                   {"stream", lane_stream(owner(link), s.session, frame.at("stream"), lane)},
                   {"resultReceived", frame.at("received").at(lane)},
                   {"resultBytes", frame.at("receivedBytes").at(lane)}};
      if (frame.contains("instance"))
        args["instance"] = frame.at("instance");
      if (frame.contains("allocations") && frame.at("allocations").contains(lane))
        args.update(frame.at("allocations").at(lane));
      call(link, "delivery", args, nullptr,
           [send, lane, exchange = frame.at("exchangeId")](Json result) {
             if (result.contains("error")) {
               send({{"type", "delivery-reset"},
                     {"lane", lane},
                     {"exchangeId", exchange},
                     {"error", result.at("error")}});
               return;
             }
             auto out = result.at("data");
             out["type"] = "delivery-window";
             out["lane"] = lane;
             send(out);
           });
    }
    return;
  }
  if (type == "delivery-output") {
    if (role != "cli")
      throw Error("FORBIDDEN", "CLI output only");
    auto command = frame;
    command["sessionId"] = s.session;
    command["epoch"] = control.at("connectionGeneration");
    business_(command);
    return;
  }
  if (type.rfind("delivery-", 0) == 0) {
    if (!s.state.contains("stream") || frame.at("stream") != s.state.at("stream"))
      throw Error("STREAM_CLOSED", "Open original stream first");
    auto args = frame;
    const auto lane = frame.at("lane").get<std::string>();
    args["stream"] = lane_stream(owner(link), s.session, frame.at("stream"), lane);
    args["sessionId"] = s.session;
    args["mode"] = role;
    if (type == "delivery-receipt") {
      business_(args);
      return;
    }
    if (type == "delivery-query" || type == "delivery-content") {
      if (type == "delivery-content")
        args["contentSeq"] = args.at("resultSeq");
      call(link, "delivery", args, nullptr, [send, lane, frame](Json result) {
        if (result.contains("error"))
          send({{"type", "error"}, {"error", result.at("error")}});
        else {
          auto out = result.at("data");
          out["type"] = "delivery-window";
          out["lane"] = lane;
          if (frame.contains("seq"))
            out["seq"] = frame.at("seq");
          send(out);
        }
      });
      return;
    }
    if (type != "delivery-command")
      throw Error("INVALID_REQUEST", "Unknown delivery frame");
    const auto payload = Json::parse(frame.at("body").get<std::string>());
    business_({{"type", role == "cli" ? "rpc" : "web"},
               {"sessionId", s.session},
               {"epoch", control.at("connectionGeneration")},
               {"payload", payload},
               {"delivery", args}});
    return;
  }
  business_({{"type", role == "cli" ? "rpc" : "web"},
             {"sessionId", s.session},
             {"epoch", control.at("connectionGeneration")},
             {"payload", frame}});
}
bool EndpointService::outgoing(const Json &d) {
  const auto type = d.value("type", "");
  if (type == "result") {
    const auto id = d.value("requestId", "");
    auto it = pending_.find(id);
    if (it != pending_.end()) {
      auto callback = std::move(it->second.done);
      const auto link = it->second.link;
      pending_.erase(it);
      if (links_.count(link))
        callback(d);
    }
    return true;
  }
  if (type == "management-result" && d.contains("endpointLink")) {
    auto out = d;
    out["type"] = "response";
    out["id"] = d.at("wire");
    if (d.contains("result"))
      out["data"] = d.at("result");
    emit(d.at("endpointLink"), out);
    return true;
  }
  if (type == "projects-changed" || type == "event" || type == "rpc" || type == "notice" ||
      type == "history-notice" || type == "terminal-stream") {
    // Snapshot recipient IDs first; emit can fail and retire a physical link.
    for (auto &[link, peer] : links_) {
      if (peer.identity.value("expires", int64_t(0)) <= now())
        continue;
      for (const auto &[id, s] : peer.streams) {
        Json payload;
        if (s.kind == "notification" &&
            (type == "projects-changed" ||
             (type == "event" &&
              (d.at("payload").at("event").value("type", "") == "sessionClosed" ||
               d.at("payload").at("event").value("type", "") == "externalState" ||
               d.at("payload").at("event").value("type", "") == "turn/started" ||
               d.at("payload").at("event").value("type", "") == "turn/completed"))))
          payload = {{"type", "change"},
                     {"scope", type == "projects-changed" ? "projects" : "sessions"}};
        else if (s.kind == "history" && type == "history-notice" &&
                 d.value("route", "") == link + "-" + id)
          payload = d.at("payload");
        else if (s.kind == "terminal" && type == "terminal-stream" &&
                 d.value("route", "") == link + "-" + id)
          payload = {{"type", "terminal-stream"}, {"frame", d.at("frame")}};
        else if (s.kind == "controller" && d.value("sessionId", "") == s.session &&
                 s.state.contains("control") &&
                 d.value("epoch", int64_t(-1)) ==
                     s.state.at("control").at("connectionGeneration") &&
                 can_dispatch(s.session, s.state.at("control").at("connectionGeneration"))) {
          if (type == "rpc" && peer.identity.at("role") == "cli")
            payload = d.at("payload");
          else if (type != "rpc" && peer.identity.at("role") == "web")
            payload = d.at("payload");
          else if (type == "notice" && d.at("payload").value("type", "").rfind("delivery-", 0) == 0)
            payload = d.at("payload");
        }
        if (!payload.is_null())
          emit(link, {{"type", "stream"}, {"id", id}, {"frame", payload}});
      }
    }
    return true;
  }
  return false;
}
} // namespace coc
