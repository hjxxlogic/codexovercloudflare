import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecureChannel } from '../packages/channel/src/secure.ts';
class RawSocket {
  static instances: RawSocket[] = [];
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1;
  onmessage?: (event: any) => void;
  onclose?: (event: any) => void;
  onerror?: (event: any) => void;
  visible: any[] = [];
  packets: any[] = [];
  cipher?: SecureChannel;
  tail = Promise.resolve();
  parts = '';
  handler: (packet: any) => void = (p) =>
    this.reply({ type: 'response', id: p.id, data: { ok: true } });
  constructor(readonly url: string) {
    RawSocket.instances.push(this);
    queueMicrotask(() => this.incoming({ type: 'channel-welcome' }));
  }
  incoming(packet: any) {
    this.onmessage?.({ data: JSON.stringify(packet) });
  }
  send(text: string) {
    const d = JSON.parse(text);
    this.visible.push(d);
    this.tail = this.tail
      .then(async () => {
        if (d.type === 'channel-connect') {
          this.cipher = await SecureChannel.create(
            false,
            'authenticated-binding',
          );
          const header = this.cipher.exchange(d.key);
          this.incoming({
            type: 'channel-key',
            data: this.cipher.publicKey,
            binding: 'authenticated-binding',
          });
          this.incoming({ type: 'channel-header', data: header });
        } else if (d.type === 'channel-header') this.cipher!.accept(d.data);
        else if (d.type === 'channel-data') {
          const part = this.cipher!.open(d.data);
          this.parts += part.slice(1);
          if (part[0] === '1') {
            const p = JSON.parse(this.parts);
            this.parts = '';
            this.packets.push(p);
            this.handler(p);
          }
        }
      })
      .catch((error) => {
        throw error;
      });
  }
  reply(packet: any) {
    const text = JSON.stringify(packet);
    let part = '',
      bytes = 0;
    const flush = (last: boolean) => {
      this.incoming({
        type: 'channel-data',
        data: this.cipher!.seal((last ? '1' : '0') + part),
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
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
    this.cipher?.close();
  }
}
let channel: typeof import('../apps/web/src/channel.ts');
beforeEach(async () => {
  vi.resetModules();
  RawSocket.instances = [];
  vi.stubGlobal('location', new URL('https://relay.test/'));
  vi.stubGlobal('WebSocket', RawSocket);
  vi.stubGlobal(
    'CloseEvent',
    class extends Event {
      code: number;
      reason: string;
      constructor(type: string, init: any) {
        super(type);
        this.code = init.code;
        this.reason = init.reason;
      }
    },
  );
  channel = await import('../apps/web/src/channel.ts');
});
afterEach(() => {
  RawSocket.instances.forEach((s) => s.close());
  vi.unstubAllGlobals();
});
describe('browser encrypted channel recovery', () => {
  it('keeps paths and Unicode bodies encrypted across chunks and returns the exact response', async () => {
    const text = '私有内容 🔐'.repeat(25000);
    const pending = channel.endpointRequest(
      '/hosts/host/files',
      { path: '/private/file', text },
      'original',
    );
    const raw = RawSocket.instances[0];
    raw.handler = (p) =>
      raw.reply({ type: 'response', id: p.id, data: p.body });
    await expect(pending).resolves.toEqual({
      type: 'response',
      id: expect.any(String),
      data: { path: '/private/file', text },
    });
    expect(raw.packets[0]).toMatchObject({
      type: 'request',
      path: '/hosts/host/files',
      requestId: 'original',
    });
    expect(raw.url).toContain('/ws/v1/channel/host?');
    expect(raw.url).not.toContain('files');
    expect(JSON.stringify(raw.visible)).not.toMatch(
      /private\/file|私有内容|original/,
    );
  });
  it('rejects unknown outcomes on disconnection and starts fresh encryption for an explicit recovery', async () => {
    const first = channel.endpointRequest(
      '/hosts/host/projects',
      undefined,
      'original',
    );
    const raw = RawSocket.instances[0];
    raw.handler = () => raw.close(1012);
    await expect(first).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    const second = channel.endpointRequest(
      '/hosts/host/projects',
      undefined,
      'original',
    );
    await expect(second).resolves.toMatchObject({ data: { ok: true } });
    expect(RawSocket.instances).toHaveLength(2);
    expect(raw.visible.find((d) => d.key)?.key).not.toBe(
      RawSocket.instances[1].visible.find((d) => d.key)?.key,
    );
  });
  it('authenticates every fragment and closes instead of returning a tampered result', async () => {
    const pending = channel.endpointRequest(
        '/hosts/host/projects',
        undefined,
        'original',
      ),
      raw = RawSocket.instances[0];
    raw.handler = () =>
      raw.incoming({ type: 'channel-data', data: 'A'.repeat(64) });
    await expect(pending).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    expect(raw.readyState).toBe(3);
  });
  it('cancels an outstanding request without manufacturing a receipt', async () => {
    const controller = new AbortController();
    const pending = channel.endpointRequest(
        '/hosts/host/projects',
        undefined,
        'original',
        controller.signal,
      ),
      raw = RawSocket.instances[0];
    raw.handler = () => {};
    await vi.waitFor(() => expect(raw.packets).toHaveLength(1));
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    await rejected;
  });
  it('multiplexes logical streams over one encrypted route and propagates revoked connection closure', async () => {
    const a = channel.businessSocket(
      'wss://relay.test/ws/v1/web/host~private-session',
    );
    const raw = RawSocket.instances[0];
    raw.handler = (p) => {
      if (p.type === 'open') raw.reply({ type: 'opened', id: p.id });
      else if (p.type === 'stream')
        raw.reply({ type: 'stream', id: p.id, frame: p.frame });
    };
    await new Promise<void>((r) => {
      a.onopen = () => r();
    });
    const b = channel.businessSocket('wss://relay.test/ws/v1/hosts/host');
    await new Promise<void>((r) => {
      b.onopen = () => r();
    });
    expect(RawSocket.instances).toHaveLength(1);
    const received = new Promise<any>((r) => {
      a.onmessage = (e) => r(JSON.parse(e.data));
    });
    a.send(JSON.stringify({ action: 'secret-method', text: 'secret-input' }));
    await expect(received).resolves.toEqual({
      action: 'secret-method',
      text: 'secret-input',
    });
    expect(JSON.stringify(raw.visible)).not.toMatch(
      /private-session|secret-method|secret-input/,
    );
    const closed = new Promise<number>((r) => {
      a.onclose = (e) => r(e.code);
    });
    raw.close(4001);
    await expect(closed).resolves.toBe(4001);
    expect(a.readyState).toBe(3);
    expect(b.readyState).toBe(3);
  });
});
