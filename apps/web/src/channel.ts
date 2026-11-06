import { SecureChannel } from '../../../packages/channel/src/secure.ts';
import { relayPath } from './routes.ts';

type Packet = Record<string, any>;
export class ChannelError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export function endpointHost(path: string, data?: unknown) {
  return (
    path.match(
      /^\/(?:admin\/)?hosts\/([\w-]+)\/(?:projects|project-management|probe|threads|files|terminal|configuration|build)(?:[/?]|$)/,
    )?.[1] ||
    path.match(/^\/sessions\/([\w-]+)~/)?.[1] ||
    (/^\/sessions(?:[/?]|$)/.test(path)
      ? (data as { hostId?: string } | undefined)?.hostId ||
        new URL(path, location.origin).searchParams.get('hostId') ||
        ''
      : '')
  );
}
class Channel {
  private socket: WebSocket;
  private cipher?: SecureChannel;
  private parts = '';
  private waiting: Packet[] = [];
  private bytes = 0;
  private closed = false;
  private streams = new Map<string, (packet: Packet) => void>();
  private pending = new Map<
    string,
    {
      resolve: (value: Packet) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      abort: () => void;
    }
  >();
  private opening: ReturnType<typeof setTimeout>;
  private tail = Promise.resolve();
  constructor(
    private key: string,
    host: string,
    admin: boolean,
    target: string,
  ) {
    this.socket = new WebSocket(
      location.origin.replace(/^http/, 'ws') +
        relayPath(
          `/ws/v1/channel/${host}?admin=${admin ? '1' : '0'}&target=${encodeURIComponent(target)}`,
        ),
    );
    this.opening = setTimeout(() => this.close(), 15000);
    this.socket.onmessage = (event) => {
      this.tail = this.tail
        .then(() => this.frame(JSON.parse(event.data)))
        .catch(() => this.close());
    };
    this.socket.onclose = (event) => this.close(event.code);
    this.socket.onerror = () => this.close();
  }
  private async frame(d: Packet) {
    if (this.closed) return;
    if (d.type === 'channel-error') {
      this.close(
        1011,
        new ChannelError(d.error.code, d.error.message, d.error.status),
      );
    } else if (d.type === 'channel-welcome') {
      // The connection ID is assigned before key generation and survives the handshake.
      this.cipher = await SecureChannel.create(true, 'pending');
      if (this.closed) {
        this.cipher.close();
        return;
      }
      this.socket.send(
        JSON.stringify({ type: 'channel-connect', key: this.cipher.publicKey }),
      );
    } else if (d.type === 'channel-key') {
      this.cipher!.binding(d.binding);
      const header = this.cipher!.exchange(d.data);
      this.socket.send(
        JSON.stringify({ type: 'channel-header', data: header }),
      );
    } else if (d.type === 'channel-header') {
      this.cipher!.accept(d.data);
      clearTimeout(this.opening);
      const waiting = this.waiting;
      this.waiting = [];
      this.bytes = 0;
      for (const packet of waiting) this.send(packet);
    } else if (d.type === 'channel-data') {
      const part = this.cipher!.open(d.data);
      if (
        !part ||
        !['0', '1'].includes(part[0]) ||
        new TextEncoder().encode(this.parts + part.slice(1)).length >
          8 * 1024 * 1024
      )
        throw new Error('Invalid endpoint fragments');
      this.parts += part.slice(1);
      if (part[0] === '0') return;
      const packet = JSON.parse(this.parts);
      this.parts = '';
      if (packet.type === 'response') {
        const p = this.pending.get(packet.id);
        if (p) {
          this.pending.delete(packet.id);
          clearTimeout(p.timer);
          p.abort();
          p.resolve(packet);
        }
      } else this.streams.get(packet.id)?.(packet);
    }
  }
  send(packet: Packet) {
    if (this.closed)
      throw new ChannelError(
        'RESULT_UNKNOWN',
        '连接已中断，请核对原请求结果',
        503,
      );
    const text = JSON.stringify(packet),
      bytes = new TextEncoder().encode(text).length;
    if (bytes > 8 * 1024 * 1024)
      throw new ChannelError('BACKPRESSURE', '消息超过传输预算', 429);
    if (!this.cipher?.ready) {
      if (this.waiting.length >= 1024 || this.bytes + bytes > 8 * 1024 * 1024) {
        this.close();
        throw new ChannelError('BACKPRESSURE', '连接队列已满', 429);
      }
      this.bytes += bytes;
      this.waiting.push(packet);
      return;
    }
    // Split at Unicode code point boundaries, preserving exact UTF-8 content.
    const encoder = new TextEncoder();
    let part = '',
      partBytes = 0;
    const flush = (last: boolean) => {
      if (this.socket.bufferedAmount > 8 * 1024 * 1024) {
        this.close();
        throw new ChannelError('BACKPRESSURE', '传输队列已满', 429);
      }
      this.socket.send(
        JSON.stringify({
          type: 'channel-data',
          data: this.cipher!.seal((last ? '1' : '0') + part),
        }),
      );
      part = '';
      partBytes = 0;
    };
    for (const char of text) {
      const size = encoder.encode(char).length;
      if (partBytes + size > 64 * 1024) flush(false);
      part += char;
      partBytes += size;
    }
    flush(true);
  }
  request(packet: Packet, signal?: AbortSignal): Promise<Packet> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.pending.size >= 128)
      return Promise.reject(
        new ChannelError('BACKPRESSURE', '请求队列已满', 429),
      );
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        reject(
          signal?.aborted
            ? signal.reason
            : new ChannelError(
                'RESULT_UNKNOWN',
                '未收到端点确认，请恢复原请求',
                504,
              ),
        );
      };
      const timer = setTimeout(cancel, 30000);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        abort: () => signal?.removeEventListener('abort', cancel),
      });
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        this.send({ ...packet, type: 'request', id });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        reject(error);
      }
    });
  }
  open(id: string, path: string, listener: (packet: Packet) => void) {
    this.streams.set(id, listener);
    this.send({ type: 'open', id, path });
  }
  stream(id: string, frame: unknown) {
    this.send({ type: 'stream', id, frame });
  }
  end(id: string) {
    this.streams.delete(id);
    if (!this.closed) this.send({ type: 'close', id });
  }
  close(code = 1006, error?: ChannelError) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.opening);
    this.socket.close();
    this.cipher?.close();
    this.parts = '';
    this.waiting = [];
    this.bytes = 0;
    if (channels.get(this.key) === this) channels.delete(this.key);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.abort();
      p.reject(
        error ||
          new ChannelError('RESULT_UNKNOWN', '连接中断，请恢复原请求', 503),
      );
    }
    this.pending.clear();
    for (const listener of this.streams.values())
      listener({ type: 'closed', code });
    this.streams.clear();
  }
}
const channels = new Map<string, Channel>();
function channel(host: string, admin = false, target = 'agent') {
  const key = relayPath('') + ':' + host + ':' + admin + ':' + target;
  let c = channels.get(key);
  if (!c) {
    c = new Channel(key, host, admin, target);
    channels.set(key, c);
  }
  return c;
}
export async function endpointRequest(
  path: string,
  data: unknown,
  requestId: string,
  signal?: AbortSignal,
  intent?: { instance: string; ack?: boolean },
  headers?: Record<string, string>,
) {
  const host = endpointHost(path, data),
    admin = path.startsWith('/admin/');
  const target = (data as { target?: string } | undefined)?.target || 'agent';
  if (/\/configuration$/.test(path) && data === undefined) {
    const response = await fetch(
      relayPath(`/api/v1/admin/hosts/${host}/connections`),
      { signal },
    );
    const result: any = await response.json();
    if (!response.ok)
      throw new ChannelError(
        result.error?.code || 'HTTP_ERROR',
        result.error?.message || '读取在线目标失败',
        response.status,
      );
    const settled = await Promise.allSettled(
      (result.targets as string[]).map(async (id) => {
        const packet = await channel(host, true, id).request(
          { path, body: null, requestId },
          signal,
        );
        if (packet.error) throw new Error(packet.error.code);
        return { ...packet.data, id };
      }),
    );
    return {
      type: 'response',
      data: {
        targets: settled.flatMap((r) =>
          r.status === 'fulfilled' ? [r.value] : [],
        ),
      },
    };
  }
  return channel(host, admin, target).request(
    {
      path,
      body: data === undefined ? null : data,
      requestId,
      ...(intent ? { intent } : {}),
      ...(headers ? { headers } : {}),
    },
    signal,
  );
}
// A logical stream presents the existing browser WebSocket interface while all
// paths, session IDs and messages stay inside the encrypted endpoint channel.
class EndpointWebSocket extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  bufferedAmount = 0;
  binaryType: BinaryType = 'blob';
  extensions = '';
  protocol = '';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private id = crypto.randomUUID();
  private c: Channel;
  constructor(
    readonly url: string,
    host: string,
    path: string,
  ) {
    super();
    this.c = channel(host);
    queueMicrotask(() => {
      try {
        this.c.open(this.id, path, (p) => this.packet(p));
      } catch {
        this.close(1006);
      }
    });
  }
  private packet(packet: Packet) {
    if (this.readyState === 3) return;
    if (packet.type === 'opened') {
      this.readyState = 1;
      const e = new Event('open');
      this.dispatchEvent(e);
      this.onopen?.(e);
      if (packet.frame) this.packet({ type: 'stream', frame: packet.frame });
    } else if (packet.type === 'stream') {
      const e = new MessageEvent('message', {
        data: JSON.stringify(packet.frame),
      });
      this.dispatchEvent(e);
      this.onmessage?.(e);
    } else if (packet.type === 'closed') this.close(packet.code || 1006);
  }
  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== 1)
      throw new DOMException('Socket not open', 'InvalidStateError');
    if (typeof value !== 'string')
      throw new TypeError('Endpoint stream requires JSON text');
    this.c.stream(this.id, JSON.parse(value));
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try {
      this.c.end(this.id);
    } catch {
      /* physical link already closed */
    }
    const event = new CloseEvent('close', { code, reason });
    this.dispatchEvent(event);
    this.onclose?.(event);
  }
}
export function businessSocket(url: string): WebSocket {
  const path = new URL(url).pathname.replace(/^\/guest/, '');
  const host =
    path.match(/^\/ws\/v1\/(?:web|history|cli)\/([\w-]+)~/)?.[1] ||
    path.match(/^\/ws\/v1\/hosts\/([\w-]+)/)?.[1];
  return host
    ? (new EndpointWebSocket(url, host, path) as unknown as WebSocket)
    : new WebSocket(url);
}
