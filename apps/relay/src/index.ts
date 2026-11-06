import {
  accessEnabled,
  accessUser,
  requireAccessUser,
  verifyAccess,
  bindBrowser,
  adminEmailMatches,
} from './access.ts';
import { version } from '../../../package.json';
import {
  AppError,
  idSchema,
} from '../../../packages/protocol/src/admission.ts';
import {
  body,
  authorizationFailed,
  failure,
  hostStub,
  hostStatus,
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
function guestPath(path: string) {
  return path === '/guest' || path.startsWith('/guest/');
}
function cookies(r: Request) {
  const guest = guestPath(new URL(r.url).pathname);
  return new Map(
    (r.headers.get('cookie') || '').split(';').flatMap((s) => {
      const i = s.indexOf('=');
      const name = s.slice(0, i).trim();
      if (guest && !name.startsWith('coc_guest_')) return [];
      return [
        [guest ? name.replace(/^coc_guest_/, 'coc_') : name, s.slice(i + 1)],
      ] as [string, string][];
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
  if (guestPath(new URL(req.url).pathname)) {
    name = name.replace(/^coc_/, 'coc_guest_');
    path = '/guest' + (path === '/' ? '' : path);
  }
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
) {
  const headers = new Headers({
    'x-auth': encodeURIComponent(JSON.stringify(auth)),
    'x-host': hostId,
  });
  if (req.headers.has('upgrade')) headers.set('upgrade', 'websocket');
  return new Request('https://internal' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const u = new URL(req.url);
      const guest = guestPath(u.pathname);
      if (u.pathname === '/guest') {
        u.pathname = '/guest/';
        return Response.redirect(u.toString(), 307);
      }
      if (guest) {
        u.pathname = u.pathname.slice('/guest'.length) || '/';
        env = { ...env, ACCESS_ENABLED: 'false' };
      }
      const p = u.pathname;
      const publicAccessPath =
        guest ||
        p.startsWith('/downloads') ||
        (env.ACCESS_PUBLIC_HEALTH === 'true' && p === '/api/v1/healthz');
      if (!publicAccessPath) await verifyAccess(req, env);
      if (p === '/api/v1/healthz' && req.method === 'GET') {
        return json({ ok: true, version, demand: 1, protocol: 1 });
      }
      if (!p.startsWith('/api/') && !p.startsWith('/ws/')) {
        const assetRequest = guest ? new Request(u, req) : req;
        const response = await env.ASSETS.fetch(assetRequest);
        const headers = new Headers(response.headers);
        const redirect = headers.get('Location');
        if (guest && redirect) {
          const destination = new URL(redirect, u);
          if (destination.origin === u.origin) {
            destination.pathname = '/guest' + destination.pathname;
            headers.set('Location', destination.toString());
          }
        }
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Referrer-Policy', 'no-referrer');
        headers.set(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        );
        // The isolated chart renderer may be framed only by this application.
        // Its script cannot access the parent origin or initiate network requests.
        if (
          u.pathname === '/diagram.html' ||
          u.pathname === '/guest/diagram.html' ||
          u.pathname === '/diagram' ||
          u.pathname === '/guest/diagram'
        ) {
          headers.delete('X-Frame-Options');
          headers.set(
            'Content-Security-Policy',
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts",
          );
        }
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
      const channel = p.match(/^\/ws\/v1\/channel\/([\w-]+)$/);
      if (channel) {
        const hostId = idSchema.parse(channel[1]);
        const admin = u.searchParams.get('admin') === '1';
        const auth = await authenticate(
          req,
          env,
          admin ? undefined : hostId,
          admin,
        );
        await registryCall(env, 'host', { id: hostId });
        const target = u.searchParams.get('target') || 'agent';
        if (!/^(agent|client-[a-f0-9]{64})$/.test(target))
          throw new AppError(
            'INVALID_REQUEST',
            'Invalid connection target',
            400,
          );
        return hostStub(env, hostId).fetch(
          internal(req, '/channel?target=' + target, auth, hostId),
        );
      }
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
      const managerPairing = p.match(
        /^\/api\/v1\/auth\/manager-device\/([\w-]+)$/,
      );
      if (managerPairing && ['GET', 'POST'].includes(req.method)) {
        const target = await registryCall(env, 'managerDeviceHost', {
          id: managerPairing[1],
        });
        const ownerCookie = cookies(req).get('coc_admin');
        let reviewer: Auth;
        let restoredToken: string | undefined;
        if (ownerCookie)
          reviewer = await authenticate(req, env, undefined, true);
        else {
          // Restore the verified browser identity for this Agent before pairing.
          const restored = await registryCall(env, 'emailRestore', {
            identity: requireAccessUser(req),
            hostId: target.hostId,
            token: cookies(req).get('coc_web_' + target.hostId),
          });
          restoredToken = restored.token;
          reviewer = await registryCall(env, 'auth', { token: restored.token });
        }
        const decision = req.method === 'POST' ? await body(req) : {};
        return json(
          await registryCall(env, 'managerDevice', {
            id: managerPairing[1],
            reviewerHash: reviewer.hash,
            decision: decision.decision,
            code: decision.code,
          }),
          200,
          restoredToken
            ? {
                'Set-Cookie': cookieHeader(
                  req,
                  'coc_web_' + target.hostId,
                  restoredToken,
                  2592000,
                ),
              }
            : {},
        );
      }
      const adminIdentity = p.match(
        /^\/api\/v1\/admin\/hosts\/([\w-]+)\/identity$/,
      );
      if (adminIdentity && req.method === 'GET') {
        const auth = await authenticate(req, env, undefined, true);
        await registryCall(env, 'host', { id: adminIdentity[1] });
        return json({ identity: auth.hash });
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
      // Old business transports are authenticated only to return a clear
      // upgrade error. Their bodies never enter the relay or endpoint.
      const legacyHost = p.match(
        /^\/api\/v1\/(admin\/)?hosts\/([\w-]+)\/(?:projects|project-management|probe|files|terminal|threads|configuration|operations)(?:[/?]|$)/,
      );
      const legacySession = p.match(/^\/api\/v1\/sessions\/([\w-]+)~/);
      const legacySocket =
        p.match(/^\/ws\/v1\/(?:web|cli|history)\/([\w-]+)~/) ||
        p.match(/^\/ws\/v1\/hosts\/([\w-]+)/);
      if (
        legacyHost ||
        legacySession ||
        legacySocket ||
        p === '/api/v1/sessions'
      ) {
        const hostId =
          legacyHost?.[2] ||
          legacySession?.[1] ||
          legacySocket?.[1] ||
          u.searchParams.get('hostId') ||
          '';
        await authenticate(
          req,
          env,
          legacyHost?.[1] ? undefined : hostId,
          !!legacyHost?.[1],
        );
        await registryCall(env, 'host', { id: hostId });
        throw new AppError(
          'UPGRADE_REQUIRED',
          'Use the encrypted endpoint channel',
          426,
        );
      }
      if (p.startsWith('/api/v1/admin/')) {
        const owner = await authenticate(req, env, undefined, true);
        if (p === '/api/v1/admin/hosts/restore' && req.method === 'POST')
          return json(await registryCall(env, 'hostRestore', await body(req)));
        const connections = p.match(
          /^\/api\/v1\/admin\/hosts\/([\w-]+)\/connections$/,
        );
        if (connections && req.method === 'GET') {
          await registryCall(env, 'host', { id: connections[1] });
          return hostStub(env, connections[1]).fetch(
            internal(req, '/connections', owner, connections[1]),
          );
        }
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
        if (p === '/api/v1/admin/hosts' && req.method === 'GET') {
          const hosts = await registryCall(env, 'hosts');
          return json(
            await Promise.all(
              hosts.map(async (host: any) => {
                if (host.disabled) return { ...host, online: false };
                try {
                  return { ...host, ...(await hostStatus(env, host.id)) };
                } catch {
                  return { ...host, online: null };
                }
              }),
            ),
          );
        }
        const emailConfig = p.match(
          /^\/api\/v1\/admin\/hosts\/([\w-]+)\/access-emails$/,
        );
        if (emailConfig && req.method === 'POST') {
          const d = await body(req);
          const result = await registryCall(env, 'setAccessEmails', {
            id: emailConfig[1],
            emails: d.emails,
          });
          for (const auth of result.revoked as Auth[])
            await hostStub(env, result.hostId).fetch(
              'https://internal/revoke-auth',
              {
                method: 'POST',
                headers: { 'x-host': result.hostId },
                body: JSON.stringify({ hash: auth.hash, agent: false }),
              },
            );
          return json({ ok: true });
        }
        const adminEmail = p.match(
          /^\/api\/v1\/admin\/hosts\/([\w-]+)\/admin-email$/,
        );
        if (adminEmail && req.method === 'POST')
          return json(
            await registryCall(env, 'setAdminEmail', {
              id: adminEmail[1],
              email: (await body(req)).email,
            }),
          );
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
                headers: { 'x-host': auth.hostId! },
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
                  headers: { 'x-host': result.hostId },
                  body: JSON.stringify({ hash: auth.hash, agent: false }),
                },
              );
          } else if (action[1] === 'revoke') {
            const auth: Auth = await registryCall(env, 'credentialRevoke', d);
            await hostStub(env, auth.hostId!).fetch(
              'https://internal/revoke-auth',
              {
                method: 'POST',
                headers: { 'x-host': auth.hostId! },
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
                const status = await hostStatus(env, h.id);
                const {
                  agentWakeUrl,
                  wakeUrlOverride,
                  agentAccessEmails: _agentAccessEmails,
                  accessEmailsOverride: _accessEmailsOverride,
                  ...visible
                } = h;
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
            } catch (error) {
              // Only a definitive denial removes a grant. A Registry failure
              // must not turn valid cookies into a fabricated login failure.
              if (!authorizationFailed(error)) throw error;
            }
          }
          if (!auths.length)
            throw new AppError('UNAUTHORIZED', 'Login required', 401);
        }
        const response = json(
          await Promise.all(
            auths.map(async (a) => {
              const h = (a as Auth & { host: any }).host;
              const status: any = await hostStatus(env, h.id);
              const {
                agentWakeUrl,
                wakeUrlOverride,
                agentAccessEmails: _agentAccessEmails,
                accessEmailsOverride: _accessEmailsOverride,
                ...visible
              } = h;
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
      if (p === '/api/v1/agent/admin-email' && req.method === 'POST') {
        const auth = await authenticateAgent(req, env);
        return json(
          await registryCall(env, 'agentSetAdminEmail', {
            agentHash: auth.hash,
            email: (await body(req)).email,
          }),
        );
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
      if (p === '/api/v1/agent/access-emails' && req.method === 'POST') {
        const auth = await authenticateAgent(req, env);
        const d = await body(req);
        const result = await registryCall(env, 'agentSetAccessEmails', {
          agentHash: auth.hash,
          emails: d.emails,
        });
        for (const revoked of result.revoked as Auth[])
          await hostStub(env, result.hostId).fetch(
            'https://internal/revoke-auth',
            {
              method: 'POST',
              headers: { 'x-host': result.hostId },
              body: JSON.stringify({ hash: revoked.hash, agent: false }),
            },
          );
        return json({ ok: true });
      }
      if (
        p === '/api/v1/agent/relay-migration' &&
        ['GET', 'POST'].includes(req.method)
      ) {
        const auth = await authenticateAgent(req, env);
        return hostStub(env, auth.hostId!).fetch(
          internal(
            req,
            '/relay-migration',
            auth,
            auth.hostId!,
            req.method === 'POST' ? await body(req) : undefined,
          ),
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
      const managementClient = p.match(
        /^\/ws\/v1\/client-management\/([\w-]+)$/,
      );
      if (managementClient) {
        const auth: Auth = await registryCall(env, 'auth', {
          token: bearer(req) || '',
        });
        const hostId = idSchema.parse(managementClient[1]);
        if (auth.role !== 'cli' || auth.hostId !== hostId)
          throw new AppError(
            'FORBIDDEN',
            'Host-scoped client credential required',
            403,
          );
        await registryCall(env, 'host', { id: hostId });
        return hostStub(env, hostId).fetch(
          internal(req, '/client-management', auth, hostId),
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
      const wake = p.match(/^\/api\/v1\/hosts\/([\w-]+)\/wake$/);
      if (wake && req.method === 'POST') {
        const auth = await authenticate(req, env, wake[1]);
        return hostStub(env, wake[1]).fetch(
          internal(req, '/wake', auth, wake[1], {}),
        );
      }
      if (p === '/api/v1/client/identity' && req.method === 'GET') {
        const hostId = idSchema.parse(u.searchParams.get('hostId'));
        const auth = await authenticate(req, env, hostId);
        if (!['web', 'cli'].includes(auth.role))
          throw new AppError('FORBIDDEN', 'Client credential required', 403);
        return json({ identity: auth.hash });
      }
      throw new AppError('NOT_FOUND', 'Unknown route', 404);
    } catch (e) {
      return failure(e);
    }
  },
};
