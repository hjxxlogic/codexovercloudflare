// Test-only client for a real native Agent socket. Older business fixtures keep
// their assertions while all traffic to the process uses its public encrypted
// request/stream interface. This fixture never executes or authorizes business.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { SecureChannel } from '../../packages/channel/src/secure.ts';
type Binding = {
  link: string;
  role: string;
  owner: string;
  cipher: SecureChannel;
  ready: Promise<void>;
  resolve: () => void;
  partial: string;
};
export class AgentEndpoint extends EventEmitter {
  private peers = new Map<string, Binding>();
  private byLink = new Map<string, Binding>();
  private pending = new Map<string, (packet: any) => void>();
  private streams = new Map<string, (packet: any) => void>();
  private controllers = new Map<
    string,
    { id: string; peer: Binding; control: any; controller: string }
  >();
  private routes = new Map<string, { socket: WebSocket; binding: string }>();
  private modes = new Map<string, string>();
  private tails = Promise.resolve();
  private ready: Promise<void>;
  private registered!: () => void;
  constructor(
    readonly raw: WebSocket,
    readonly host: string,
    private subscribe = true,
  ) {
    super();
    this.on('error', (error) => console.error('Endpoint fixture:', error));
    this.ready = new Promise((r) => {
      this.registered = r;
    });
    raw.on('message', (data) => {
      this.tails = this.tails
        .then(() => this.frame(JSON.parse(String(data))))
        .catch((e) => {
          this.emit('error', e);
        });
    });
    raw.on('close', (code) => {
      for (const p of this.peers.values()) p.cipher.close();
      this.emit('close', code);
    });
    raw.on('error', (e) => this.emit('error', e));
    raw.send(JSON.stringify({ type: 'channel-welcome', version: 1 }));
  }
  route(socket: WebSocket, role = 'cli', owner = 'a'.repeat(64)) {
    let link = '';
    socket.send(JSON.stringify({ type: 'channel-welcome', version: 1 }));
    socket.on('message', (raw) => {
      const d = JSON.parse(String(raw));
      if (d.type === 'channel-connect') {
        link = randomUUID();
        const binding =
          'fixture:' + this.host + ':' + link + ':' + owner + ':' + role;
        this.routes.set(link, { socket, binding });
        this.wire({
          type: 'channel-open',
          link,
          binding,
          key: d.key,
          identity: {
            owner,
            role,
            hostId: this.host,
            expires: Number.MAX_SAFE_INTEGER,
            accountId: '',
            permissions: { access: true, projects: true, configuration: false },
          },
        });
      } else if (link && ['channel-header', 'channel-data'].includes(d.type))
        this.wire({ type: d.type, link, data: d.data });
    });
    socket.on('close', () => {
      this.routes.delete(link);
      if (this.raw.readyState === 1) this.wire({ type: 'channel-close', link });
    });
  }
  private async notifications() {
    const p = await this.peer();
    await this.open(p, `/ws/v1/hosts/${this.host}`, (packet) => {
      if (packet.frame?.type === 'change')
        this.emitMessage({
          type:
            packet.frame.scope === 'projects'
              ? 'projects-changed'
              : 'sessions-changed',
        });
    });
  }
  get readyState() {
    return this.raw.readyState;
  }
  close(code = 1000, reason = '') {
    this.raw.close(code, reason);
  }
  terminate() {
    this.raw.terminate();
  }
  private wire(d: any) {
    this.raw.send(JSON.stringify(d));
  }
  private emitMessage(d: any) {
    this.emit('message', Buffer.from(JSON.stringify(d)));
  }
  private async frame(d: any) {
    if (d.type === 'channel-register') {
      this.wire({ type: 'channel-registered' });
      this.registered();
      this.emitMessage({ ...d, type: 'capabilities', delivery: 2, demand: 1 });
      if (this.subscribe)
        void this.notifications().catch((e) => this.emit('error', e));
      return;
    }
    const route = this.routes.get(d.link);
    if (route) {
      if (d.type === 'channel-close') route.socket.close(1012);
      else
        route.socket.send(
          JSON.stringify({
            type: d.type,
            data: d.data,
            ...(d.type === 'channel-key' ? { binding: route.binding } : {}),
          }),
        );
      return;
    }
    const p = this.byLink.get(d.link);
    if (!p) return;
    if (d.type === 'channel-key') {
      const header = p.cipher.exchange(d.data);
      this.wire({ type: 'channel-header', link: p.link, data: header });
    } else if (d.type === 'channel-header') {
      p.cipher.accept(d.data);
      p.resolve();
    } else if (d.type === 'channel-data') {
      const part = p.cipher.open(d.data);
      p.partial += part.slice(1);
      if (part[0] === '1') {
        const packet = JSON.parse(p.partial);
        p.partial = '';
        if (packet.type === 'response') {
          this.pending.get(packet.id)?.(packet);
          this.pending.delete(packet.id);
        } else this.streams.get(packet.id)?.(packet);
      }
    }
  }
  private async peer(role = 'web', owner = 'a'.repeat(64)) {
    await this.ready;
    const key = role + ':' + owner;
    let p = this.peers.get(key);
    if (p) {
      await p.ready;
      return p;
    }
    const link = randomUUID(),
      binding = 'fixture:' + this.host + ':' + link + ':' + owner + ':' + role,
      cipher = await SecureChannel.create(true, binding);
    let resolve!: () => void;
    const ready = new Promise<void>((r) => {
      resolve = r;
    });
    p = { link, role, owner, cipher, ready, resolve, partial: '' };
    this.peers.set(key, p);
    this.byLink.set(link, p);
    this.wire({
      type: 'channel-open',
      version: 1,
      link,
      binding,
      key: cipher.publicKey,
      identity: {
        owner,
        hostId: this.host,
        role,
        accountId: '',
        expires: Number.MAX_SAFE_INTEGER,
        permissions: { access: true, projects: true, configuration: true },
      },
    });
    await ready;
    return p;
  }
  private write(p: Binding, d: any) {
    const text = JSON.stringify(d);
    let part = '',
      bytes = 0;
    const flush = (last: boolean) => {
      this.wire({
        type: 'channel-data',
        link: p.link,
        data: p.cipher.seal((last ? '1' : '0') + part),
      });
      part = '';
      bytes = 0;
    };
    for (const c of text) {
      const size = Buffer.byteLength(c);
      if (bytes + size > 64 * 1024) flush(false);
      part += c;
      bytes += size;
    }
    flush(true);
  }
  private request(
    p: Binding,
    path: string,
    body: any = null,
    intent?: any,
    requestId = randomUUID(),
  ): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write(p, {
        type: 'request',
        id,
        path,
        body,
        requestId,
        ...(intent ? { intent } : {}),
      });
    });
  }
  async call(path: string, body: any = null, role = 'web', intent?: any) {
    return this.request(
      await this.peer(role, intent?.owner),
      path,
      body,
      intent,
      intent?.requestId,
    );
  }
  private async open(p: Binding, path: string, handler: (packet: any) => void) {
    const id = randomUUID();
    await new Promise<void>((resolve) => {
      this.streams.set(id, (packet) => {
        if (packet.type === 'opened') resolve();
        else handler(packet);
      });
      this.write(p, { type: 'open', id, path });
    });
    return id;
  }
  control(session: string) {
    return this.controllers.get(session)?.control;
  }
  send(text: string) {
    void this.dispatch(JSON.parse(text)).catch((e) => {
      this.emit('error', e);
    });
  }
  private async dispatch(d: any) {
    if (d.type === 'control') {
      const data = { ...d.data },
        role = data.mode || this.modes.get(data.sessionId) || 'web',
        p = await this.peer(role, d.intent?.owner || data.owner);
      let path: string,
        body: any = data;
      if (d.action === 'attach') {
        const claimed = await this.request(
          p,
          `/sessions/${data.sessionId}/attach`,
          { claimId: randomUUID(), delivery: 2 },
        );
        if (claimed.error) {
          this.emitMessage({
            type: 'result',
            requestId: d.requestId,
            error: claimed.error,
          });
          return;
        }
        const id = await this.open(
          p,
          `/ws/v1/${role}/${data.sessionId}`,
          (packet) => {
            const frame = packet.frame;
            if (
              frame?.type === 'attached' ||
              frame?.type === 'delivery-ready'
            ) {
              this.controllers.set(data.sessionId, {
                id: packet.id,
                peer: p,
                control: frame.control,
                controller: frame.controller,
              });
              this.emitMessage({
                type: 'result',
                requestId: d.requestId,
                data: { ok: true, control: frame.control },
              });
            } else if (packet.type === 'stream')
              this.emitMessage({
                type: role === 'cli' ? 'rpc' : 'notice',
                sessionId: data.sessionId,
                epoch: data.epoch,
                payload: frame,
              });
          },
        );
        this.write(p, {
          type: 'stream',
          id,
          frame: { type: 'auth', ticket: claimed.data.ticket },
        });
        return;
      }
      if (['create', 'list'].includes(d.action)) {
        path = '/sessions';
        data.hostId = this.host;
        if (d.action === 'list') {
          body = null;
          path +=
            `?hostId=${this.host}&mode=${role}` +
            (data.paged ? '&paged=true' : '');
        }
      } else if (
        [
          'get',
          'stop',
          'history',
          'snapshot',
          'queue',
          'answer',
          'approvals',
          'delivery',
        ].includes(d.action)
      ) {
        path =
          '/sessions/' +
          data.sessionId +
          (d.action === 'get'
            ? ''
            : '/' + (d.action === 'answer' ? 'approval' : d.action));
        if (d.action === 'delivery' && data.exchangeId) {
          const c = this.controllers.get(data.sessionId);
          if (c) data.controller = c.controller;
        }
      } else
        path = `/hosts/${this.host}/${d.action === 'projectManage' ? 'project-management' : d.action}`;
      const response = await this.request(
        p,
        path,
        body,
        d.intent,
        d.intent?.requestId || d.requestId,
      );
      if (d.action === 'create' && response.data?.id)
        this.modes.set(response.data.id, role);
      this.emitMessage({
        type: 'result',
        requestId: d.requestId,
        ...(response.error
          ? { error: response.error }
          : { data: response.data }),
        ...(response.intent ? { intent: response.intent } : {}),
      });
      return;
    }
    if (
      d.type === 'rpc' ||
      d.type === 'web' ||
      d.type === 'delivery-receipt' ||
      d.type === 'delivery-output'
    ) {
      const c = this.controllers.get(d.sessionId);
      if (!c) throw new Error('Attach fixture controller first');
      const frame = d.delivery
        ? { type: 'delivery-command', ...d.delivery }
        : d.type.startsWith('delivery-')
          ? d
          : d.payload;
      this.write(c.peer, { type: 'stream', id: c.id, frame });
      return;
    }
    if (d.type === 'detach') {
      const c = this.controllers.get(d.sessionId);
      if (c) this.write(c.peer, { type: 'close', id: c.id });
      this.controllers.delete(d.sessionId);
      return;
    }
    // Operational change notifications remain Worker control messages.
    if (d.type === 'change') {
      this.wire(d);
      return;
    }
    throw new Error('Unsupported fixture envelope: ' + d.type);
  }
}
