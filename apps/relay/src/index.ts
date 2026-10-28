import {
  accessEnabled,
  requireMachineAccess,
  accessUser,
  requireAccessUser,
  verifyAccess,
  bindBrowser,
  adminEmailMatches,
} from './access.ts';
import { z } from 'zod';
import {
  AppError,
  idSchema,
  workspaceFileCommandSchema,
} from '../../../packages/protocol/src/index.ts';
import {
  body,
  failure,
  hostStub,
  json,
  registryCall,
  registry,
  type Auth,
  type Env,
} from './common.ts';
export { RegistryDO } from './registry.ts';
export { HostRelayDO } from './host.ts';

const bearer = (r: Request) =>
  r.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
function cookies(r: Request) {
  return new Map(
    (r.headers.get('cookie') || '').split(';').map((s) => {
      const i = s.indexOf('=');
      return [s.slice(0, i).trim(), s.slice(i + 1)] as [string, string];
    }),
  );
}
function cookieHeader(
  req: Request,
  name: string,
  value: string,
  maxAge: number,
  path = '/',
) {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}`;
}
async function authenticate(
  req: Request,
  env: Env,
  hostId?: string,
  admin = false,
) {
  const value =
    bearer(req) || cookies(req).get(admin ? 'coc_admin' : 'coc_web_' + hostId);
  if (!value) throw new AppError('UNAUTHORIZED', 'Login required', 401);
  const auth: Auth = await registryCall(env, 'auth', { token: value });
  if (
    admin
      ? auth.role !== 'owner'
      : !['cli', 'web'].includes(auth.role) ||
        auth.hostId !== hostId ||
        (!bearer(req) && auth.role !== 'web')
  )
    throw new AppError(
      'FORBIDDEN',
      'Credential role or target host does not match',
      403,
    );
  bindBrowser(req, env, auth);
  return auth;
}
async function authenticateAgent(req: Request, env: Env) {
  const value = bearer(req);
  if (!value) throw new AppError('UNAUTHORIZED', 'Agent login required', 401);
  const auth: Auth = await registryCall(env, 'auth', { token: value });
  if (auth.role !== 'agent')
    throw new AppError('FORBIDDEN', 'Agent credential required', 403);
  return auth;
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
function internal(
  req: Request,
  path: string,
  auth: Auth,
  hostId: string,
  data?: unknown,
  ticket?: string,
) {
  const headers = new Headers({
    'x-auth': encodeURIComponent(JSON.stringify(auth)),
    'x-host': hostId,
  });
  if (req.headers.has('upgrade')) headers.set('upgrade', 'websocket');
  if (req.headers.get('x-coc-async') === '1') headers.set('x-coc-async', '1');
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
      const publicAccessPath =
        (env.ACCESS_PUBLIC_DOWNLOADS === 'true' &&
          (p === '/downloads' || p.startsWith('/downloads/'))) ||
        (env.ACCESS_PUBLIC_HEALTH === 'true' && p === '/api/v1/healthz');
      if (!publicAccessPath) await verifyAccess(req, env);
      if (p === '/api/v1/healthz' && req.method === 'GET')
        return json({ ok: true, version: '0.5.14', demand: 1, protocol: 1 });
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
      if (p === '/api/v1/auth/email' && req.method === 'GET') {
        if (!accessEnabled(env)) return json({ enabled: false });
        const identity = requireAccessUser(req);
        const legacy = [];
        for (const [name, value] of cookies(req)) {
          if (!/^coc_web_[\w-]+$/.test(name)) continue;
          try {
            const auth: Auth = await registryCall(env, 'auth', {
              token: value,
            });
            if (
              auth.role === 'web' &&
              !auth.accountId &&
              name === 'coc_web_' + auth.hostId
            )
              legacy.push({ hostId: auth.hostId, name: auth.name });
          } catch {
            /* Invalid legacy cookies cannot be migrated. */
          }
        }
        return json({
          enabled: true,
          email: identity.email,
          accountId: identity.accountId,
          autoAdmin: adminEmailMatches(env, identity),
          legacy,
        });
      }
      if (p === '/api/v1/auth/email/admin' && req.method === 'POST') {
        const result = await registryCall(env, 'emailAdminLogin', {
          identity: requireAccessUser(req),
          token: cookies(req).get('coc_admin'),
          ip: req.headers.get('cf-connecting-ip') || 'local',
        });
        return json({ expires: result.expires }, 200, {
          'Set-Cookie': cookieHeader(req, 'coc_admin', result.token, 28800),
        });
      }
      if (
        ['/api/v1/auth/email/restore', '/api/v1/auth/email/migrate'].includes(
          p,
        ) &&
        req.method === 'POST'
      ) {
        const hostId = idSchema.parse((await body(req)).hostId);
        const result = await registryCall(
          env,
          p.endsWith('/migrate') ? 'emailMigrate' : 'emailRestore',
          {
            identity: requireAccessUser(req),
            hostId,
            token: cookies(req).get('coc_web_' + hostId),
          },
        );
        return json({ hostId }, 200, {
          'Set-Cookie': cookieHeader(
            req,
            'coc_web_' + hostId,
            result.token,
            2592000,
          ),
        });
      }
      if (p === '/api/v1/auth/login' && req.method === 'POST') {
        const d = await body(req);
        const result = await registryCall(env, 'login', {
          secret: d.secret,
          identity:
            accessEnabled(env) && !bearer(req)
              ? requireAccessUser(req)
              : undefined,
          ip: req.headers.get('cf-connecting-ip') || 'local',
        });
        return json(
          d.kind === 'cli' ? result : { expires: result.expires },
          200,
          { 'Set-Cookie': cookieHeader(req, 'coc_admin', result.token, 28800) },
        );
      }
      if (p === '/api/v1/auth/api-key' && req.method === 'POST') {
        await requireMachineAccess(req, env);
        const d = await body(req);
        return json(
          await registryCall(env, 'apiKeyLogin', {
            ...d,
            ip: req.headers.get('cf-connecting-ip') || 'local',
          }),
        );
      }
      if (p === '/api/v1/auth/device/start' && req.method === 'POST') {
        const d = await body(req);
        if (d.role !== 'web') await requireMachineAccess(req, env);
        const result = await registryCall(env, 'deviceStart', {
          ...d,
          identity:
            d.role === 'web' && accessEnabled(env)
              ? requireAccessUser(req)
              : undefined,
          ip: req.headers.get('cf-connecting-ip') || 'local',
        });
        if (d.role !== 'web') return json(result);
        const { pollSecret, ...visible } = result;
        return json(visible, 200, {
          'Set-Cookie': cookieHeader(
            req,
            'coc_pending_' + result.id,
            pollSecret,
            300,
            '/api/v1/auth/device',
          ),
        });
      }
      if (p === '/api/v1/auth/device/events' && req.method === 'GET') {
        if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
          throw new AppError('UPGRADE_REQUIRED', 'WebSocket required', 426);
        const id = idSchema.parse(u.searchParams.get('id'));
        const secret = cookies(req).get('coc_pending_' + id) || bearer(req);
        return registry(env).fetch(
          new Request('https://internal/subscribe', {
            headers: {
              Upgrade: 'websocket',
              'x-subscription': encodeURIComponent(
                JSON.stringify({
                  id,
                  secret,
                  accountId: accessUser(req)?.accountId,
                }),
              ),
            },
          }),
        );
      }
      if (p === '/ws/v1/admin') {
        const auth = await authenticate(req, env, undefined, true);
        return registry(env).fetch(
          new Request('https://internal/subscribe', {
            headers: {
              Upgrade: 'websocket',
              'x-subscription': encodeURIComponent(
                JSON.stringify({ hash: auth.hash }),
              ),
            },
          }),
        );
      }
      const subscription = p.match(/^\/ws\/v1\/hosts\/([\w-]+)$/);
      if (subscription) {
        const auth = await authenticate(req, env, subscription[1]);
        return hostStub(env, subscription[1]).fetch(
          internal(req, '/subscribe', auth, subscription[1]),
        );
      }
      const receipt = p.match(
        /^\/api\/v1\/hosts\/([\w-]+)\/operations\/([\w-]+)$/,
      );
      if (receipt && ['GET', 'POST'].includes(req.method)) {
        const auth = await authenticate(req, env, receipt[1]);
        return hostStub(env, receipt[1]).fetch(
          internal(
            req,
            '/operation/' + receipt[2],
            auth,
            receipt[1],
            req.method === 'POST' ? {} : undefined,
          ),
        );
      }
      const probe = p.match(/^\/api\/v1\/hosts\/([\w-]+)\/probe$/);
      if (probe && req.method === 'POST') {
        const auth = await authenticate(req, env, probe[1]);
        return hostStub(env, probe[1]).fetch(
          internal(req, '/control', auth, probe[1], {
            action: 'probe',
            data: {},
          }),
        );
      }
      if (p === '/api/v1/auth/device/poll' && req.method === 'POST') {
        const d = await body(req),
          id = idSchema.parse(d.id);
        const pending = cookies(req).get('coc_pending_' + id);
        const result = await registryCall(env, 'devicePoll', {
          id,
          pollSecret: pending || d.pollSecret,
          web: !!pending,
          identity: accessUser(req),
        });
        if (pending && result.state === 'approved') {
          const { token, ...visible } = result;
          return json(visible, 200, {
            'Set-Cookie': cookieHeader(
              req,
              'coc_web_' + result.hostId,
              token,
              34560000,
            ),
          });
        }
        return json(result);
      }
      if (p === '/api/v1/auth/me' && req.method === 'GET') {
        const auth = await authenticate(req, env, undefined, true);
        return json({ role: auth.role, expires: auth.expires });
      }
      if (p === '/api/v1/auth/logout-others' && req.method === 'POST') {
        const auth = await authenticate(req, env, undefined, true);
        await registryCall(env, 'logoutOthers', { hash: auth.hash });
        return json({ ok: true });
      }
      if (p === '/api/v1/auth/logout' && req.method === 'POST') {
        const auth = await authenticate(req, env, undefined, true);
        await registryCall(env, 'logout', { hash: auth.hash });
        return json({ ok: true }, 200, {
          'Set-Cookie': cookieHeader(req, 'coc_admin', '', 0),
        });
      }
      if (p === '/api/v1/auth/forget' && req.method === 'POST') {
        const hostId = idSchema.parse((await body(req)).hostId);
        return json({ ok: true }, 200, {
          'Set-Cookie': cookieHeader(req, 'coc_web_' + hostId, '', 0),
        });
      }
      if (p.startsWith('/api/v1/admin/')) {
        const owner = await authenticate(req, env, undefined, true);
        if (p === '/api/v1/admin/releases' && req.method === 'POST') {
          const d = await body(req);
          const manifestResponse = await env.ASSETS.fetch(
            new Request(new URL('/downloads/index.json', req.url)),
          );
          const manifest: any = await manifestResponse.json();
          if (
            !manifestResponse.ok ||
            manifest.version !== d.version ||
            manifest.commit !== d.commit ||
            manifest.protocol !== 1 ||
            !Array.isArray(manifest.files) ||
            !manifest.files.length
          )
            throw new AppError(
              'RELEASE_NOT_READY',
              'Deploy matching verified release artifacts before notifying',
              409,
            );
          for (const file of manifest.files) {
            if (
              typeof file !== 'string' ||
              !/^[\w.-]+$/.test(file) ||
              !(
                await env.ASSETS.fetch(
                  new Request(new URL('/downloads/' + file, req.url), {
                    method: 'HEAD',
                  }),
                )
              ).ok
            )
              throw new AppError(
                'RELEASE_NOT_READY',
                'Release artifact unavailable',
                409,
              );
          }
          return json(await registryCall(env, 'releasePublish', d));
        }
        if (p === '/api/v1/admin/devices' && req.method === 'GET')
          return json(await registryCall(env, 'devices'));
        if (p === '/api/v1/admin/hosts' && req.method === 'GET')
          return json(await registryCall(env, 'hosts'));
        const wakeConfig = p.match(
          /^\/api\/v1\/admin\/hosts\/([\w-]+)\/wake-url$/,
        );
        if (wakeConfig && req.method === 'POST')
          return json(
            await registryCall(env, 'setWakeUrl', {
              ...(await body(req)),
              id: wakeConfig[1],
            }),
          );
        if (p === '/api/v1/admin/api-keys') {
          if (req.method === 'GET')
            return json(await registryCall(env, 'apiKeys'));
          if (req.method === 'POST')
            return json(
              await registryCall(env, 'apiKeyCreate', await body(req)),
            );
        }
        if (p === '/api/v1/admin/api-keys/revoke' && req.method === 'POST') {
          const revoked: Auth[] = await registryCall(
            env,
            'apiKeyRevoke',
            await body(req),
          );
          for (const auth of revoked)
            await hostStub(env, auth.hostId!).fetch(
              'https://internal/revoke-auth',
              {
                method: 'POST',
                body: JSON.stringify({
                  hash: auth.hash,
                  agent: auth.role === 'agent',
                }),
              },
            );
          return json({ ok: true });
        }
        const action = p.match(/^\/api\/v1\/admin\/(approve|reject|revoke)$/);
        if (action && req.method === 'POST') {
          const d = await body(req);
          if (
            action[1] === 'revoke' &&
            typeof d.id === 'string' &&
            d.id.startsWith('emailGrant:')
          ) {
            const result = await registryCall(env, 'emailGrantRevoke', {
              id: d.id,
            });
            for (const auth of result.revoked as Auth[])
              await hostStub(env, result.hostId).fetch(
                'https://internal/revoke-auth',
                {
                  method: 'POST',
                  body: JSON.stringify({ hash: auth.hash, agent: false }),
                },
              );
          } else if (action[1] === 'revoke') {
            const auth: Auth = await registryCall(env, 'credentialRevoke', d);
            await hostStub(env, auth.hostId!).fetch(
              'https://internal/revoke-auth',
              {
                method: 'POST',
                body: JSON.stringify({
                  hash: auth.hash,
                  agent: auth.role === 'agent',
                }),
              },
            );
          } else
            await registryCall(
              env,
              action[1] === 'approve' ? 'deviceApprove' : 'deviceReject',
              { ...d, approvedBy: owner.hash },
            );
          return json({ ok: true });
        }
        throw new AppError('NOT_FOUND', 'Unknown management route', 404);
      }
      if (p === '/api/v1/hosts' && req.method === 'GET') {
        if (accessEnabled(env) && !bearer(req)) {
          const hosts = await registryCall(env, 'emailHosts', {
            identity: requireAccessUser(req),
          });
          return json(
            await Promise.all(
              hosts.map(async (h: any) => {
                const status = (await (
                  await hostStub(env, h.id).fetch('https://internal/status')
                ).json()) as any;
                const { agentWakeUrl, wakeUrlOverride, ...visible } = h;
                return {
                  ...visible,
                  ...status,
                  wakeConfigured: !!(wakeUrlOverride ?? agentWakeUrl),
                };
              }),
            ),
          );
        }
        const auths: Auth[] = [];
        if (bearer(req)) {
          const a: Auth = await registryCall(env, 'authHost', {
            token: bearer(req),
          });
          if (a.role !== 'cli')
            throw new AppError('FORBIDDEN', 'CLI credential required', 403);
          auths.push(a);
        } else {
          for (const [name, value] of cookies(req)) {
            if (!/^coc_web_[\w-]+$/.test(name)) continue;
            try {
              const a: Auth = await registryCall(env, 'authHost', {
                token: value,
              });
              if (a.role === 'web' && name === 'coc_web_' + a.hostId)
                auths.push(a);
            } catch {
              /* Revoked browser grants do not hide other hosts. */
            }
          }
          if (!auths.length)
            throw new AppError('UNAUTHORIZED', 'Login required', 401);
        }
        const response = json(
          await Promise.all(
            auths.map(async (a) => {
              const h = (a as Auth & { host: any }).host;
              const status: any = await (
                await hostStub(env, h.id).fetch('https://internal/status')
              ).json();
              const { agentWakeUrl, wakeUrlOverride, ...visible } = h;
              return {
                ...visible,
                ...status,
                wakeConfigured: !!(wakeUrlOverride ?? agentWakeUrl),
              };
            }),
          ),
        );
        if (!bearer(req))
          for (const auth of auths) {
            const name = 'coc_web_' + auth.hostId;
            response.headers.append(
              'Set-Cookie',
              cookieHeader(req, name, cookies(req).get(name)!, 34560000),
            );
          }
        return response;
      }
      if (p === '/api/v1/instance/name' && req.method === 'POST') {
        const value = bearer(req);
        if (!value) throw new AppError('UNAUTHORIZED', 'Login required', 401);
        const auth: Auth = await registryCall(env, 'auth', { token: value });
        if (!['agent', 'cli'].includes(auth.role))
          throw new AppError(
            'FORBIDDEN',
            'Native instance credential required',
            403,
          );
        return json(
          await registryCall(env, 'setInstanceName', {
            ...(await body(req)),
            hash: auth.hash,
          }),
        );
      }
      if (p === '/api/v1/agent/status' && req.method === 'GET') {
        const auth = await authenticateAgent(req, env);
        return json(await registryCall(env, 'host', { id: auth.hostId }));
      }
      if (p === '/api/v1/agent/wake-url' && req.method === 'POST') {
        const auth = await authenticateAgent(req, env);
        return json(
          await registryCall(env, 'agentSetWakeUrl', {
            ...(await body(req)),
            agentHash: auth.hash,
          }),
        );
      }
      if (p === '/api/v1/agent/requests' && req.method === 'GET') {
        const auth = await authenticateAgent(req, env);
        return json(
          await registryCall(env, 'agentDevices', { agentHash: auth.hash }),
        );
      }
      const agentDecision = p.match(
        /^\/api\/v1\/agent\/requests\/([^/]+)\/(approve|reject)$/,
      );
      if (agentDecision && req.method === 'POST') {
        const auth = await authenticateAgent(req, env);
        return json(
          await registryCall(
            env,
            agentDecision[2] === 'approve'
              ? 'agentDeviceApprove'
              : 'agentDeviceReject',
            { id: idSchema.parse(agentDecision[1]), agentHash: auth.hash },
          ),
        );
      }
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
      const wake = p.match(/^\/api\/v1\/hosts\/([\w-]+)\/wake$/);
      if (wake && req.method === 'POST') {
        const auth = await authenticate(req, env, wake[1]);
        return hostStub(env, wake[1]).fetch(
          internal(req, '/wake', auth, wake[1], {}),
        );
      }
      const projects = p.match(/^\/api\/v1\/hosts\/([\w-]+)\/projects$/);
      if (projects && req.method === 'GET') {
        const auth = await authenticate(req, env, projects[1]);
        await registryCall(env, 'host', { id: projects[1] });
        return hostStub(env, projects[1]).fetch(
          internal(req, '/control', auth, projects[1], {
            action: 'projects',
            data: {},
          }),
        );
      }
      const files = p.match(/^\/api\/v1\/hosts\/([\w-]+)\/files$/);
      if (files && req.method === 'POST') {
        const auth = await authenticate(req, env, files[1]);
        if (auth.role !== 'web')
          throw new AppError('FORBIDDEN', 'Web credential required', 403);
        const data = await body(req);
        const projectId = idSchema.parse(data.projectId);
        const command = workspaceFileCommandSchema.parse(data);
        await registryCall(env, 'host', { id: files[1] });
        return hostStub(env, files[1]).fetch(
          internal(req, '/control', auth, files[1], {
            action: 'files',
            data: { ...command, projectId, owner: auth.hash },
          }),
        );
      }
      const threads = p.match(/^\/api\/v1\/hosts\/([\w-]+)\/threads$/);
      if (threads && req.method === 'GET') {
        const auth = await authenticate(req, env, threads[1]);
        if (!['web', 'cli'].includes(auth.role))
          throw new AppError('FORBIDDEN', 'Client credential required', 403);
        await registryCall(env, 'host', { id: threads[1] });
        return hostStub(env, threads[1]).fetch(
          internal(req, '/control', auth, threads[1], {
            action: 'threads',
            data: {
              projectId: idSchema.parse(u.searchParams.get('projectId')),
              cursor: z
                .string()
                .max(4000)
                .nullable()
                .parse(u.searchParams.get('cursor')),
            },
          }),
        );
      }
      if (p === '/api/v1/sessions') {
        const d =
          req.method === 'POST'
            ? await body(req)
            : {
                hostId: u.searchParams.get('hostId'),
                paged: u.searchParams.get('paged') === 'true',
                cursor: z
                  .string()
                  .max(200)
                  .parse(u.searchParams.get('cursor') || ''),
                projectId: u.searchParams.get('projectId') || undefined,
                state: u.searchParams.get('state') || undefined,
              };
        const hostId = idSchema.parse(d.hostId);
        const auth = await authenticate(req, env, hostId);
        await registryCall(env, 'host', { id: hostId });
        if (!['GET', 'POST'].includes(req.method))
          throw new AppError('NOT_FOUND', 'Unknown route', 404);
        if (req.method === 'POST') {
          idSchema.parse(d.projectId);
          z.enum(['web', 'cli']).parse(d.mode);
          if (d.external !== undefined) z.boolean().parse(d.external);
          if (d.external === true && d.threadId === undefined)
            throw new AppError(
              'INVALID_REQUEST',
              'External connection requires threadId',
              400,
            );
          if (d.threadId !== undefined) {
            idSchema.parse(d.threadId);
            if (d.mode !== 'web' && d.external !== true)
              throw new AppError(
                'FORBIDDEN',
                'Only web sessions support history resume',
                403,
              );
          }
          if (d.mode !== auth.role)
            throw new AppError(
              'FORBIDDEN',
              'Session mode must match credential role',
              403,
            );
          d.key = z
            .string()
            .min(1)
            .max(100)
            .parse(req.headers.get('idempotency-key'));
          d.key = auth.hash + ':' + d.key;
        }
        if (req.method === 'GET') d.mode = auth.role;
        return hostStub(env, hostId).fetch(
          internal(req, '/control', auth, hostId, {
            action: req.method === 'POST' ? 'create' : 'list',
            data: d,
          }),
        );
      }
      const approvalSession = p.match(
        /^\/api\/v1\/sessions\/([\w~-]+)\/(approvals|approval)$/,
      );
      if (
        approvalSession &&
        ((approvalSession[2] === 'approvals' && req.method === 'GET') ||
          (approvalSession[2] === 'approval' && req.method === 'POST'))
      ) {
        const hostId = idSchema.parse(approvalSession[1].split('~')[0]);
        const auth = await authenticate(req, env, hostId);
        if (!['web', 'cli'].includes(auth.role))
          throw new AppError('FORBIDDEN', 'Client credential required', 403);
        const input = req.method === 'POST' ? await body(req) : {};
        const answer =
          req.method === 'POST'
            ? {
                requestId: idSchema.parse(req.headers.get('idempotency-key')),
                approvalId: z.string().min(1).max(200).parse(input.approvalId),
                allow: z.boolean().parse(input.allow),
              }
            : {};
        return hostStub(env, hostId).fetch(
          internal(req, '/control', auth, hostId, {
            action: req.method === 'POST' ? 'answer' : 'approvals',
            data: { sessionId: approvalSession[1], mode: auth.role, ...answer },
          }),
        );
      }
      const queuedSession = p.match(/^\/api\/v1\/sessions\/([\w~-]+)\/queue$/);
      if (queuedSession && req.method === 'POST') {
        const hostId = idSchema.parse(queuedSession[1].split('~')[0]);
        const auth = await authenticate(req, env, hostId);
        if (!['web', 'cli'].includes(auth.role))
          throw new AppError('FORBIDDEN', 'Client credential required', 403);
        const input = await body(req);
        const text = z.string().trim().min(1).max(64000).parse(input.text);
        const requestId = idSchema.parse(req.headers.get('idempotency-key'));
        return hostStub(env, hostId).fetch(
          internal(req, '/control', auth, hostId, {
            action: 'queue',
            data: {
              sessionId: queuedSession[1],
              mode: auth.role,
              text,
              requestId,
            },
          }),
        );
      }
      const operation = p.match(
        /^\/api\/v1\/hosts\/([\w-]+)\/requests\/([\w-]+)$/,
      );
      if (operation && req.method === 'GET') {
        const auth = await authenticate(req, env, operation[1]);
        const sessionId = u.searchParams.get('sessionId');
        if (sessionId && !sessionId.startsWith(operation[1] + '~'))
          throw new AppError('FORBIDDEN', 'Wrong host', 403);
        return hostStub(env, operation[1]).fetch(
          internal(req, '/control', auth, operation[1], {
            action: 'request',
            data: {
              requestId: sessionId
                ? operation[2]
                : auth.hash + ':' + operation[2],
              mode: auth.role,
              ...(sessionId ? { sessionId } : {}),
            },
          }),
        );
      }
      const session = p.match(
        /^\/api\/v1\/sessions\/([\w~-]+)\/(attach|takeover|stop)$/,
      );
      if (session && req.method === 'POST') {
        const hostId = idSchema.parse(session[1].split('~')[0]);
        const auth = await authenticate(req, env, hostId);
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
      if (p === '/api/v1/client/identity' && req.method === 'GET') {
        const hostId = idSchema.parse(u.searchParams.get('hostId'));
        const auth = await authenticate(req, env, hostId);
        if (!['web', 'cli'].includes(auth.role))
          throw new AppError('FORBIDDEN', 'Client credential required', 403);
        return json({ identity: auth.hash });
      }
      const historySocket = p.match(/^\/ws\/v1\/history\/([\w~-]+)$/);
      if (historySocket && req.method === 'GET') {
        const hostId = idSchema.parse(historySocket[1].split('~')[0]);
        const auth = await authenticate(req, env, hostId);
        if (!['web', 'cli'].includes(auth.role))
          throw new AppError('FORBIDDEN', 'Client credential required', 403);
        await registryCall(env, 'host', { id: hostId });
        return hostStub(env, hostId).fetch(
          internal(req, '/history?sessionId=' + historySocket[1], auth, hostId),
        );
      }
      const web = p.match(/^\/ws\/v1\/web\/([\w~-]+)$/);
      if (web && req.method === 'GET') {
        const hostId = idSchema.parse(web[1].split('~')[0]);
        const auth = await authenticate(req, env, hostId);
        if (auth.role !== 'web')
          throw new AppError('FORBIDDEN', 'Web credential required', 403);
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
