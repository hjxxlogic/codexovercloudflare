// Test endpoint adapter for synthetic HTTP/WebSocket receivers. The production
// client still encrypts every request and stream; this side is the mock Agent.
import WebSocket, { type WebSocketServer } from 'ws';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SecureChannel } from '../../packages/channel/src/secure.ts';
import type { Route } from '@playwright/test';
// Faults are injected at the synthetic Agent's decrypted boundary. Browser HTTP
// interception cannot see requests carried by the encrypted physical socket.
const routes = new Map<string, (route: Route) => unknown>();
export const fixtureRoutes = {
  route(pattern: string, handler: (route: Route) => unknown) {
    routes.set(pattern, handler);
  },
  unroute(pattern: string, _handler?: unknown) {
    routes.delete(pattern);
  },
};
export const fixtureStreams: {
  send?: (path: string, frame: any) => any;
  receive?: (path: string, frame: any) => any;
} = {};
async function intercept(
  url: string,
  init: any,
): Promise<Response | undefined> {
  for (const [pattern, handler] of [...routes].reverse()) {
    const expression = pattern
      .split('*')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    if (!new RegExp('^' + expression + '$').test(url)) continue;
    let response: Response | undefined;
    await handler({
      request: () => ({
        url: () => url,
        method: () => init.method || 'GET',
        postDataJSON: () => JSON.parse(init.body),
      }),
      fulfill: async (options: any) => {
        response = new Response(
          options.json === undefined
            ? options.body
            : JSON.stringify(options.json),
          { status: options.status || 200, headers: options.headers },
        );
      },
      abort: async () => {
        response = Response.json(
          {
            error: {
              code: 'RESULT_UNKNOWN',
              message: 'Synthetic transport loss',
            },
          },
          { status: 503 },
        );
      },
      continue: async () => {},
    } as unknown as Route);
    return response;
  }
}
export function encryptedFixture(ws: WebSocket, req: IncomingMessage) {
  const path = req.url?.replace(/^\/guest(?=\/)/, '');
  if (path?.startsWith('/ws/v1/client-management/')) {
    ws.send(JSON.stringify({ type: 'channel-welcome', version: 1 }));
    ws.on('message', () =>
      ws.send(JSON.stringify({ type: 'channel-registered' })),
    );
    return true;
  }
  if (!path?.startsWith('/ws/v1/channel/')) return false;
  if ((req as any).endpointOffline) {
    ws.send(JSON.stringify({ type: 'channel-welcome', version: 1 }));
    ws.on('message', () => {
      ws.send(
        JSON.stringify({
          type: 'channel-error',
          error: { code: 'HOST_OFFLINE', message: 'Host offline', status: 503 },
        }),
      );
      ws.close(1011);
    });
    return true;
  }
  const origin = `${(req.socket as any).encrypted ? 'https' : 'http'}://127.0.0.1:${(req.socket.address() as any).port}${req.url?.startsWith('/guest/') ? '/guest' : ''}`;
  const localFetch = async (url: string, init: any): Promise<Response> =>
    (await intercept(url, init)) ||
    new Promise((resolve, reject) => {
      const request = (url.startsWith('https:') ? httpsRequest : httpRequest)(
        url,
        { ...init, rejectUnauthorized: false },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (d) => chunks.push(d));
          response.on('end', () =>
            resolve(
              new Response(Buffer.concat(chunks).toString(), {
                status: response.statusCode,
                headers: response.headers as any,
              }),
            ),
          );
        },
      );
      request.on('error', reject);
      request.end(init.body);
    });
  let cipher: SecureChannel | undefined,
    partial = '',
    tail = Promise.resolve();
  const streams = new Map<string, WebSocket>();
  const send = (packet: any) => {
    const chars = [...JSON.stringify(packet)];
    let part = '',
      bytes = 0;
    const flush = (last: boolean) => {
      ws.send(
        JSON.stringify({
          type: 'channel-data',
          data: cipher!.seal((last ? '1' : '0') + part),
        }),
      );
      part = '';
      bytes = 0;
    };
    for (const c of chars) {
      const n = Buffer.byteLength(c);
      if (bytes + n > 65536) flush(false);
      part += c;
      bytes += n;
    }
    flush(true);
  };
  async function packet(p: any) {
    if (p.type === 'request') {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-CoC-Async': '1',
        'X-CoC-Delivery': '2',
        'Idempotency-Key': p.requestId,
      };
      for (const key of [
        'authorization',
        'cookie',
        'origin',
        'cf-access-client-id',
        'cf-access-client-secret',
      ])
        if (typeof req.headers[key] === 'string')
          headers[key] = req.headers[key] as string;
      if (p.intent) {
        headers['X-CoC-Operation-Instance'] = p.intent.instance;
        if (p.intent.ack) headers['X-CoC-Operation-Ack'] = '1';
      }
      Object.assign(headers, p.headers || {});
      const response = await localFetch(
        origin + (p.path.startsWith('/api/v1') ? '' : '/api/v1') + p.path,
        {
          method: p.body === null ? 'GET' : 'POST',
          headers,
          body: p.body === null ? undefined : JSON.stringify(p.body),
        },
      );
      let result: any = await response.json();
      if (response.status === 202) {
        const url =
          origin +
          `/api/v1/${p.path.includes('/admin/') ? 'admin/' : ''}hosts/${result.hostId}/operations/${result.operationId}`;
        const until = Date.now() + 30000;
        while (Date.now() < until && ws.readyState === 1) {
          const r = await localFetch(url, { headers });
          result = await r.json();
          if (!r.ok || result.state === 'completed') break;
          await new Promise((r) => setTimeout(r, 50));
        }
        if (result.state === 'completed')
          result = {
            ...(result.error
              ? { error: result.error }
              : { data: result.result }),
            ...(result.intent ? { intent: result.intent } : {}),
          };
        else {
          ws.close(1012);
          return;
        }
      } else
        result = result.error
          ? { error: { ...result.error, status: response.status } }
          : { data: result };
      if (
        /\/configuration$/.test(p.path) &&
        p.body === null &&
        result.data?.targets
      )
        result.data =
          result.data.targets.find(
            (t: any) =>
              t.id === new URL(req.url!, origin).searchParams.get('target'),
          ) || result.data.targets[0];
      if (ws.readyState === 1) send({ type: 'response', id: p.id, ...result });
    } else if (p.type === 'open') {
      const headers: Record<string, string> = {};
      for (const key of [
        'authorization',
        'cookie',
        'origin',
        'cf-access-client-id',
        'cf-access-client-secret',
      ])
        if (typeof req.headers[key] === 'string')
          headers[key] = req.headers[key] as string;
      const stream = new WebSocket(origin.replace(/^http/, 'ws') + p.path, {
        headers,
        rejectUnauthorized: false,
      });
      streams.set(p.id, stream);
      stream.on('open', () => send({ type: 'opened', id: p.id }));
      stream.on('message', (raw) => {
        const original = JSON.parse(String(raw));
        const frame = fixtureStreams.send
          ? fixtureStreams.send(p.path, original)
          : original;
        if (frame) send({ type: 'stream', id: p.id, frame });
      });
      stream.on('close', (code) => {
        streams.delete(p.id);
        if (ws.readyState === 1) send({ type: 'closed', id: p.id, code });
      });
      stream.on('error', () => {
        if (ws.readyState === 1) send({ type: 'closed', id: p.id, code: 1006 });
      });
    } else if (p.type === 'stream') {
      const stream = streams.get(p.id);
      const frame = fixtureStreams.receive
        ? fixtureStreams.receive(stream?.url || '', p.frame)
        : p.frame;
      if (frame?.fixtureReply)
        send({ type: 'stream', id: p.id, frame: frame.fixtureReply });
      else if (frame) stream?.send(JSON.stringify(frame));
    } else if (p.type === 'close') streams.get(p.id)?.close();
  }
  ws.send(JSON.stringify({ type: 'channel-welcome', version: 1 }));
  ws.on('message', (raw) => {
    tail = tail
      .then(async () => {
        const d = JSON.parse(String(raw));
        if (d.type === 'channel-connect') {
          const binding = 'synthetic:' + randomUUID();
          cipher = await SecureChannel.create(false, binding);
          const header = cipher.exchange(d.key);
          ws.send(
            JSON.stringify({
              type: 'channel-key',
              data: cipher.publicKey,
              binding,
            }),
          );
          ws.send(JSON.stringify({ type: 'channel-header', data: header }));
        } else if (d.type === 'channel-header') cipher!.accept(d.data);
        else if (d.type === 'channel-data') {
          const part = cipher!.open(d.data);
          partial += part.slice(1);
          if (part[0] === '1') {
            const p = JSON.parse(partial);
            partial = '';
            if (process.env.COC_FIXTURE_DEBUG)
              console.log(
                'endpoint',
                p.type,
                p.path || p.frame?.type || p.frame?.action,
              );
            void packet(p).catch((error) => {
              if (process.env.COC_FIXTURE_DEBUG) console.error(error);
              ws.close(1011);
            });
          }
        }
      })
      .catch(() => ws.close(1011));
  });
  ws.on('close', () => {
    cipher?.close();
    for (const stream of streams.values()) stream.terminate();
    streams.clear();
  });
  return true;
}
export function installEncryptedFixture(server: WebSocketServer) {
  server.prependListener('connection', (ws, req) => {
    encryptedFixture(ws, req);
  });
}
