import { z } from 'zod';
import { AppError, idSchema } from '../../../packages/protocol/src/index.ts';
import {
  body,
  failure,
  hostStub,
  json,
  registryCall,
  type Auth,
  type Env,
} from './common.ts';
export { RegistryDO } from './registry.ts';
export { HostRelayDO } from './host.ts';

const bearer = (r: Request) =>
  r.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
function cookie(r: Request) {
  return r.headers
    .get('cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('coc_session='))
    ?.slice(12);
}
function originCheck(r: Request) {
  const origin = r.headers.get('origin');
  if (origin && origin !== new URL(r.url).origin)
    throw new AppError('BAD_ORIGIN', 'Cross-origin request rejected', 403);
  if (!bearer(r) && r.method !== 'GET' && !origin)
    throw new AppError(
      'BAD_ORIGIN',
      'Origin required for browser requests',
      403,
    );
}
async function owner(req: Request, env: Env) {
  const value = bearer(req) || cookie(req);
  if (!value) throw new AppError('UNAUTHORIZED', 'Login required', 401);
  const a: Auth = await registryCall(env, 'auth', { token: value });
  if (a.role !== 'owner')
    throw new AppError('FORBIDDEN', 'Owner access required', 403);
  return a;
}
function internal(
  req: Request,
  path: string,
  auth: Auth,
  hostId: string,
  data?: unknown,
  ticket?: string,
) {
  const headers = new Headers({
    'x-auth': JSON.stringify(auth),
    'x-host': hostId,
  });
  if (req.headers.has('upgrade')) headers.set('upgrade', 'websocket');
  if (ticket) headers.set('x-ticket', ticket);
  return new Request('https://internal' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const u = new URL(req.url),
        p = u.pathname;
      if (p === '/api/v1/healthz' && req.method === 'GET')
        return json({ ok: true });
      if (!p.startsWith('/api/') && !p.startsWith('/ws/')) {
        const response = await env.ASSETS.fetch(req);
        const headers = new Headers(response.headers);
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Referrer-Policy', 'no-referrer');
        headers.set(
          'Content-Security-Policy',
          "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        );
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      }
      originCheck(req);
      if (
        p.startsWith('/ws/') &&
        (req.method !== 'GET' ||
          req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      )
        throw new AppError(
          'UPGRADE_REQUIRED',
          'WebSocket upgrade required',
          426,
        );
      if (p === '/api/v1/auth/login' && req.method === 'POST') {
        const d = await body(req);
        const result = await registryCall(env, 'login', {
          secret: d.secret,
          ip: req.headers.get('cf-connecting-ip') || 'local',
        });
        const secure = u.protocol === 'https:' ? '; Secure' : '';
        return json(
          d.kind === 'cli' ? result : { expires: result.expires },
          200,
          {
            'Set-Cookie': `coc_session=${result.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`,
          },
        );
      }
      if (p === '/api/v1/agent/enroll' && req.method === 'POST')
        return json(await registryCall(env, 'redeem', await body(req)));
      if (p === '/ws/v1/agent') {
        const auth: Auth = await registryCall(env, 'auth', {
          token: bearer(req) || '',
        });
        if (auth.role !== 'agent' || !auth.hostId)
          throw new AppError('FORBIDDEN', 'Device credentials required', 403);
        return hostStub(env, auth.hostId).fetch(
          internal(req, '/agent', auth, auth.hostId),
        );
      }
      const cli = p.match(/^\/ws\/v1\/cli\/([\w~-]+)$/);
      if (cli) {
        const hostId = idSchema.parse(cli[1].split('~')[0]);
        await registryCall(env, 'host', { id: hostId });
        return hostStub(env, hostId).fetch(
          internal(
            req,
            '/cli?sessionId=' + cli[1],
            {} as Auth,
            hostId,
            undefined,
            bearer(req),
          ),
        );
      }
      const auth = await owner(req, env);
      if (p === '/api/v1/auth/logout' && req.method === 'POST') {
        await registryCall(env, 'logout', { hash: auth.hash });
        return json({ ok: true }, 200, {
          'Set-Cookie':
            'coc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
        });
      }
      if (p === '/api/v1/hosts/enrollments' && req.method === 'POST')
        return json(await registryCall(env, 'enroll', await body(req)));
      if (p === '/api/v1/hosts' && req.method === 'GET') {
        const hosts: any[] = await registryCall(env, 'hosts');
        return json(
          await Promise.all(
            hosts.map(async (h) => {
              const status: any = await (
                await hostStub(env, h.id).fetch('https://internal/status')
              ).json();
              return { ...h, online: !h.disabled && status.online };
            }),
          ),
        );
      }
      const revoke = p.match(/^\/api\/v1\/hosts\/([\w-]+)\/revoke$/);
      if (revoke && req.method === 'POST') {
        await registryCall(env, 'revoke', { id: revoke[1] });
        return hostStub(env, revoke[1]).fetch('https://internal/revoke');
      }
      const projects = p.match(/^\/api\/v1\/hosts\/([\w-]+)\/projects$/);
      if (projects && req.method === 'GET') {
        await registryCall(env, 'host', { id: projects[1] });
        return hostStub(env, projects[1]).fetch(
          internal(req, '/control', auth, projects[1], {
            action: 'projects',
            data: {},
          }),
        );
      }
      if (p === '/api/v1/sessions') {
        const d =
          req.method === 'POST'
            ? await body(req)
            : { hostId: u.searchParams.get('hostId') };
        const hostId = idSchema.parse(d.hostId);
        await registryCall(env, 'host', { id: hostId });
        if (!['GET', 'POST'].includes(req.method))
          throw new AppError('NOT_FOUND', 'Unknown route', 404);
        if (req.method === 'POST') {
          idSchema.parse(d.projectId);
          z.enum(['web', 'cli']).parse(d.mode);
          d.key = z
            .string()
            .min(1)
            .max(100)
            .parse(req.headers.get('idempotency-key'));
        }
        return hostStub(env, hostId).fetch(
          internal(req, '/control', auth, hostId, {
            action: req.method === 'POST' ? 'create' : 'list',
            data: d,
          }),
        );
      }
      const session = p.match(
        /^\/api\/v1\/sessions\/([\w~-]+)\/(attach|takeover|stop)$/,
      );
      if (session && req.method === 'POST') {
        const hostId = idSchema.parse(session[1].split('~')[0]);
        await registryCall(env, 'host', { id: hostId });
        return hostStub(env, hostId).fetch(
          internal(
            req,
            session[2] === 'stop' ? '/control' : '/ticket',
            auth,
            hostId,
            session[2] === 'stop'
              ? { action: 'stop', data: { sessionId: session[1] } }
              : { sessionId: session[1], takeover: session[2] === 'takeover' },
          ),
        );
      }
      const web = p.match(/^\/ws\/v1\/web\/([\w~-]+)$/);
      if (web && req.method === 'GET') {
        const hostId = idSchema.parse(web[1].split('~')[0]);
        await registryCall(env, 'host', { id: hostId });
        return hostStub(env, hostId).fetch(
          internal(req, '/web?sessionId=' + web[1], auth, hostId),
        );
      }
      throw new AppError('NOT_FOUND', 'Unknown route', 404);
    } catch (e) {
      return failure(e);
    }
  },
};
