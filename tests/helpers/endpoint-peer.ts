// Wire fixture using the same browser crypto as the product. No business logic
// lives here: requests and logical streams are passed byte for byte to Agent.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { SecureChannel } from '../../packages/channel/src/secure.ts';
export function endpointHost(path: string, body?: any) {
  return (
    path.match(
      /\/(?:admin\/)?hosts\/([\w-]+)\/(?:projects|project-management|probe|threads|files|terminal|configuration|build)(?:[/?]|$)/,
    )?.[1] ||
    path.match(/\/sessions\/([\w-]+)~/)?.[1] ||
    (/\/sessions(?:[/?]|$)/.test(path)
      ? body?.hostId ||
        new URL(path, 'http://test').searchParams.get('hostId') ||
        ''
      : '')
  );
}
export class EndpointPeer extends EventEmitter {
  raw: WebSocket;
  cipher?: SecureChannel;
  readyState = 0;
  readonly OPEN = 1;
  readonly CLOSED = 3;
  private tail = Promise.resolve();
  private parts = '';
  private id = randomUUID();
  private timer: ReturnType<typeof setTimeout>;
  private finished = false;
  readonly visible: string[] = [];
  constructor(
    origin: string,
    host: string,
    headers: Record<string, string>,
    private packet: any,
    target = 'agent',
    admin = false,
  ) {
    super();
    this.on('error', () => {});
    this.raw = new WebSocket(
      origin.replace(/^http/, 'ws') +
        `/ws/v1/channel/${host}?admin=${admin ? '1' : '0'}&target=${target}`,
      { headers },
    );
    this.timer = setTimeout(
      () => this.terminate(),
      packet.type === 'request' ? 30000 : 15000,
    );
    this.raw.on('message', (raw) => {
      this.visible.push(String(raw));
      this.tail = this.tail
        .then(() => this.receive(JSON.parse(String(raw))))
        .catch((error) => {
          this.emit('error', error);
          this.terminate();
        });
    });
    this.raw.on('close', (code) => {
      if (!this.finished) {
        this.finished = true;
        clearTimeout(this.timer);
        this.cipher?.close();
        this.readyState = 3;
        this.emit('close', code);
      }
    });
    this.raw.on('error', (error) => this.emit('error', error));
    this.raw.on('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        this.emit('response', {
          type: 'response',
          error: { ...body.error, status: res.statusCode },
        });
        this.terminate();
      });
    });
  }
  private async receive(d: any) {
    if (this.finished) return;
    if (d.type === 'channel-error') {
      this.emit('response', { type: 'response', error: d.error });
      this.close();
    } else if (d.type === 'channel-welcome') {
      this.cipher = await SecureChannel.create(true, 'pending');
      this.raw.send(
        JSON.stringify({ type: 'channel-connect', key: this.cipher.publicKey }),
      );
    } else if (d.type === 'channel-key') {
      this.cipher!.binding(d.binding);
      this.raw.send(
        JSON.stringify({
          type: 'channel-header',
          data: this.cipher!.exchange(d.data),
        }),
      );
    } else if (d.type === 'channel-header') {
      this.cipher!.accept(d.data);
      this.write({ ...this.packet, id: this.id });
    } else if (d.type === 'channel-data') {
      const part = this.cipher!.open(d.data);
      if (
        !/^[01]/.test(part) ||
        this.parts.length + part.length > 8 * 1024 * 1024
      )
        throw new Error('Invalid fragments');
      this.parts += part.slice(1);
      if (part[0] === '0') return;
      const packet = JSON.parse(this.parts);
      this.parts = '';
      if (packet.type === 'response') {
        clearTimeout(this.timer);
        this.emit('response', packet);
      } else if (packet.type === 'opened') {
        clearTimeout(this.timer);
        this.readyState = 1;
        this.emit('open');
        if (packet.frame)
          this.emit('message', Buffer.from(JSON.stringify(packet.frame)));
      } else if (packet.type === 'stream')
        this.emit('message', Buffer.from(JSON.stringify(packet.frame)));
      else if (packet.type === 'closed') this.close(packet.code || 1000);
    }
  }
  write(packet: any) {
    const text = JSON.stringify(packet),
      chars = [...text];
    let part = '',
      bytes = 0;
    const flush = (last: boolean) => {
      const data = this.cipher!.seal((last ? '1' : '0') + part);
      this.visible.push(JSON.stringify({ type: 'channel-data', data }));
      this.raw.send(JSON.stringify({ type: 'channel-data', data }));
      part = '';
      bytes = 0;
    };
    for (const c of chars) {
      const size = Buffer.byteLength(c);
      if (bytes + size > 64 * 1024) flush(false);
      part += c;
      bytes += size;
    }
    flush(true);
  }
  send(text: string) {
    this.write({ type: 'stream', id: this.id, frame: JSON.parse(text) });
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 2;
    this.raw.close(code);
  }
  terminate() {
    this.raw.terminate();
    clearTimeout(this.timer);
  }
}
export async function endpointFetch(
  origin: string,
  path: string,
  data: any,
  headers: Record<string, string>,
  target = data?.target || 'agent',
  metadataOnly = false,
) {
  const host = endpointHost(path, data);
  if (/\/configuration$/.test(path) && data === undefined && !metadataOnly) {
    const response = await fetch(
      origin + '/api/v1/admin/hosts/' + host + '/connections',
      { headers },
    );
    if (!response.ok) return response;
    const directory: any = await response.json();
    const results = await Promise.allSettled(
      (directory.targets as string[]).map(async (id) => {
        const r = await endpointFetch(
          origin,
          path,
          undefined,
          headers,
          id,
          true,
        );
        const metadata: any = await r.json();
        if (!r.ok) throw new Error(JSON.stringify(metadata));
        return { ...metadata, id };
      }),
    );
    return Response.json({
      targets: results.flatMap((r) =>
        r.status === 'fulfilled' ? [r.value] : [],
      ),
    });
  }
  if (!host)
    return fetch(origin + '/api/v1' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  return new Promise<Response>((resolve, reject) => {
    const peer = new EndpointPeer(
      origin,
      host,
      headers,
      {
        type: 'request',
        path,
        body: data === undefined ? null : data,
        requestId: headers['Idempotency-Key'] || randomUUID(),
        headers,
        ...(headers['X-CoC-Operation-Instance']
          ? {
              intent: {
                instance: headers['X-CoC-Operation-Instance'],
                ack: headers['X-CoC-Operation-Ack'] === '1',
              },
            }
          : {}),
      },
      target,
      path.startsWith('/admin/'),
    );
    let done = false;
    peer.on('error', (error) => {
      if (!done) {
        done = true;
        reject(error);
      }
    });
    peer.on('close', () => {
      if (!done) {
        done = true;
        resolve(
          Response.json(
            {
              error: {
                code: 'RESULT_UNKNOWN',
                message: 'Endpoint closed before response',
              },
            },
            { status: 503 },
          ),
        );
      }
    });
    peer.on('response', (packet) => {
      if (done) return;
      done = true;
      const response = Response.json(
        packet.error ? { error: packet.error } : packet.data,
        {
          status: packet.error
            ? packet.error.status ||
              (
                {
                  UNAUTHORIZED: 401,
                  FORBIDDEN: 403,
                  NOT_FOUND: 404,
                  PROJECT_NOT_FOUND: 404,
                  SESSION_NOT_FOUND: 404,
                  CONTENT_NOT_FOUND: 404,
                  HOST_OFFLINE: 503,
                  INVALID_REQUEST: 400,
                  UPGRADE_REQUIRED: 426,
                } as Record<string, number>
              )[packet.error.code] ||
              409
            : 200,
          headers: {
            'X-CoC-Demand': '1',
            'X-CoC-Delivery': '2',
            'X-CoC-Intent': packet.intent ? JSON.stringify(packet.intent) : '',
          },
        },
      );
      peer.close();
      resolve(response);
    });
  });
}
