import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { MemoryStorage } from './helpers/do-state.ts';
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: any,
      public env: any,
    ) {
      ctx.getWebSockets ??= () => [];
    }
  },
}));
import { RegistryDO } from '../apps/relay/src/registry.ts';
import worker from '../apps/relay/src/index.ts';
import { verifyAccess, accessUser } from '../apps/relay/src/access.ts';
import type { Env } from '../apps/relay/src/common.ts';

const issuer = 'https://coc-access-tests.cloudflareaccess.com';
let signing: CryptoKeyPair, jwk: JsonWebKey;
let env: Env, registry: RegistryDO, storage: MemoryStorage;
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
async function jwt(
  email: string | null,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const body = encode({
    iss: issuer,
    aud: ['coc-tests'],
    type: 'app',
    sub: email ? 'user-sub' : '',
    ...(email ? { email } : { common_name: 'service-test' }),
    iat: now,
    exp: now + 3600,
    ...claims,
  });
  const prefix =
    encode({ alg: 'RS256', kid: 'test-key', ...header }) + '.' + body;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signing.privateKey,
    new TextEncoder().encode(prefix),
  );
  return prefix + '.' + Buffer.from(signature).toString('base64url');
}
async function op(name: string, data: unknown = {}) {
  const response = await registry.fetch(
    new Request('https://internal/' + name, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  );
  return { status: response.status, data: (await response.json()) as any };
}
async function request(
  path: string,
  email: string | null,
  data?: unknown,
  cookie = '',
  extra: Record<string, string> = {},
) {
  const response = await worker.fetch(
    new Request('https://relay.test' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        Origin: 'https://relay.test',
        'Cf-Access-Jwt-Assertion': await jwt(email),
        Cookie: cookie,
        ...extra,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),
    env,
  );
  return {
    status: response.status,
    data: (await response.json()) as any,
    cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
  };
}
async function host() {
  const key = (await op('apiKeyCreate', { name: 'A', role: 'agent' })).data;
  const result = (
    await op('apiKeyLogin', {
      role: 'agent',
      name: 'A',
      apiKey: key.apiKey,
      ip: crypto.randomUUID(),
    })
  ).data;
  return { ...result, token: key.apiKey };
}
async function guestRequest(
  path: string,
  data?: unknown,
  cookie = '',
  extra: Record<string, string> = {},
) {
  return worker.fetch(
    new Request('https://relay.test/guest' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: 'https://relay.test', Cookie: cookie, ...extra },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),
    env,
  );
}
async function pair(email: string, hostId: string) {
  const start = await request('/api/v1/auth/device/start', email, {
    role: 'web',
    name: 'Browser',
    requestedHostId: hostId,
    identity: { email: 'attacker@test.com' },
  });
  expect(start.status).toBe(200);
  expect((await op('deviceApprove', { id: start.data.id })).status).toBe(200);
  return request(
    '/api/v1/auth/device/poll',
    email,
    { id: start.data.id },
    start.cookie,
  );
}
beforeAll(async () => {
  signing = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  jwk = await crypto.subtle.exportKey('jwk', signing.publicKey);
});
beforeEach(() => {
  storage = new MemoryStorage();
  env = {
    OWNER_SECRET: 'owner-secret-'.repeat(4),
    ACCESS_ENABLED: 'true',
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUD: 'coc-tests',
    ADMIN_EMAIL: 'admin@test.com',
    REGISTRY: {
      idFromName: () => 'registry',
      get: () => ({
        fetch: (input: Request | string, init?: RequestInit) =>
          registry.fetch(
            input instanceof Request ? input : new Request(input, init),
          ),
      }),
    },
    HOSTS: {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: vi.fn(async (input: Request | string) =>
          String(input).endsWith('/status')
            ? Response.json({ online: false })
            : Response.json({ ok: true }),
        ),
      }),
    },
    ASSETS: { fetch: async () => new Response('static') },
  } as unknown as Env;
  registry = new RegistryDO(
    { storage, getWebSockets: () => [] } as unknown as DurableObjectState,
    env,
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      expect(url).toBe(issuer + '/cdn-cgi/access/certs');
      expect(options?.redirect).toBe('manual');
      return Response.json({
        keys: [{ ...jwk, kid: 'test-key', alg: 'RS256' }],
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('Cloudflare Access signature and email identity', () => {
  it.each(['/downloads', '/downloads/', '/downloads/index.json'])(
    'serves public download path %s without Access authentication',
    async (path) => {
      const assets = vi.spyOn(env.ASSETS, 'fetch');
      const response = await worker.fetch(
        new Request(`https://relay.test${path}`),
        env,
      );
      expect(response.status).toBe(200);
      expect(assets).toHaveBeenCalledTimes(1);
      expect((assets.mock.calls[0][0] as Request).url).toBe(
        `https://relay.test${path}`,
      );
      const denied = await worker.fetch(
        new Request('https://relay.test/api/v1/hosts'),
        env,
      );
      expect(denied.status).toBe(401);
    },
  );
  it('redirects the guest entry to its directory so relative assets stay public', async () => {
    const response = await worker.fetch(
      new Request('https://relay.test/guest?mode=cw'),
      env,
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toBe(
      'https://relay.test/guest/?mode=cw',
    );
  });
  it.each([
    ['/guest/', '/'],
    ['/guest/assets/app.js', '/assets/app.js'],
  ])('serves public guest resource %s as %s', async (path, assetPath) => {
    const assets = vi
      .spyOn(env.ASSETS, 'fetch')
      .mockResolvedValue(new Response('asset'));
    const response = await worker.fetch(
      new Request(`https://relay.test${path}?mode=cw`),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('asset');
    expect((assets.mock.calls[0][0] as Request).url).toBe(
      `https://relay.test${assetPath}?mode=cw`,
    );
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "frame-ancestors 'none'",
    );
  });
  it.each([
    [
      'keys_network',
      () => Promise.reject(new TypeError('private network detail')),
    ],
    [
      'keys_timeout',
      () => Promise.reject(new DOMException('private detail', 'TimeoutError')),
    ],
    [
      'keys_http_403',
      async () => new Response('private response', { status: 403 }),
    ],
    [
      'keys_http_302',
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://evil.test/certs' },
        }),
    ],
    ['keys_format', async () => new Response('<html>private response</html>')],
    ['key_id', async () => Response.json({ keys: [] })],
  ])(
    'reports only the safe %s public-key failure stage',
    async (stage, fetchKeys) => {
      env.ACCESS_TEAM_DOMAIN = `https://keys-${crypto.randomUUID()}.cloudflareaccess.com`;
      vi.stubGlobal('fetch', vi.fn(fetchKeys));
      const value = await jwt('admin@test.com', {
        iss: env.ACCESS_TEAM_DOMAIN,
      });
      const response = await worker.fetch(
        new Request('https://relay.test/api/v1/auth/email', {
          headers: { 'Cf-Access-Jwt-Assertion': value },
        }),
        env,
      );
      expect(response.status).toBe(401);
      const data = JSON.stringify(await response.json());
      expect(data).toContain(`(${stage})`);
      expect(data).not.toContain('private');
      expect(data).not.toContain(value);
      expect(data).not.toContain('admin@test.com');
    },
  );
  it('verifies an application cookie when the assertion header is absent', async () => {
    const value = await jwt('admin@test.com');
    const response = await worker.fetch(
      new Request('https://relay.test/api/v1/auth/email', {
        headers: {
          Cookie: `other=value; CF_Authorization=${value}; last=value`,
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: true,
      email: 'admin@test.com',
      autoAdmin: true,
    });
    const login = await worker.fetch(
      new Request('https://relay.test/api/v1/auth/email/admin', {
        method: 'POST',
        headers: {
          Origin: 'https://relay.test',
          Cookie: `CF_Authorization=${value}`,
        },
        body: '{}',
      }),
      env,
    );
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toContain('coc_admin=');
  });
  it('rejects invalid or ambiguous cookies and never falls back from an invalid assertion', async () => {
    const good = await jwt('user@test.com');
    const expired = await jwt('user@test.com', { exp: 1 });
    const wrongAudience = await jwt('user@test.com', { aud: ['other'] });
    const wrongIssuer = await jwt('user@test.com', {
      iss: 'https://evil.test',
    });
    const parts = good.split('.');
    parts[1] = encode({ email: 'admin@test.com' });
    const invalidHeaders: Record<string, string>[] = [
      { Cookie: `CF_Authorization=${expired}` },
      { Cookie: `CF_Authorization=${wrongAudience}` },
      { Cookie: `CF_Authorization=${wrongIssuer}` },
      { Cookie: `CF_Authorization=${parts.join('.')}` },
      { Cookie: `CF_Authorization=${good}; CF_Authorization=${good}` },
      { Cookie: `CF_Authorization=${'a'.repeat(16385)}` },
      {
        Cookie: `CF_Authorization=${good}`,
        'Cf-Access-Jwt-Assertion': 'invalid',
      },
      { Cookie: `CF_Authorization=${good}`, 'Cf-Access-Jwt-Assertion': '' },
    ];
    for (const headers of invalidHeaders) {
      await expect(
        verifyAccess(new Request('https://relay.test', { headers }), env),
      ).rejects.toMatchObject({ code: 'ACCESS_REQUIRED' });
    }
    const preferred = new Request('https://relay.test', {
      headers: {
        Cookie: `CF_Authorization=${await jwt('admin@test.com')}`,
        'Cf-Access-Jwt-Assertion': good,
      },
    });
    await verifyAccess(preferred, env);
    expect(accessUser(preferred)?.email).toBe('user@test.com');
  });
  it('accepts a signed identity without email and grants no email permissions', async () => {
    const value = await jwt(null);
    const req = new Request('https://relay.test', {
      headers: { Cookie: `CF_Authorization=${value}` },
    });
    await verifyAccess(req, env);
    expect(accessUser(req)).toBeUndefined();
    expect((await request('/api/v1/healthz', null)).status).toBe(200);
    expect((await request('/api/v1/hosts', null)).status).toBe(403);
    const admin = await request('/api/v1/auth/email/admin', null, {}, '', {
      'Cf-Access-Authenticated-User-Email': 'admin@test.com',
    });
    expect(admin.status).toBe(403);
    expect(admin.data.error.code).toBe('ACCESS_USER_REQUIRED');
  });
  it('uses the verified email claim without requiring a particular subject or common name', async () => {
    const req = new Request('https://relay.test', {
      headers: {
        'Cf-Access-Jwt-Assertion': await jwt(null, { email: 'user@test.com' }),
      },
    });
    await verifyAccess(req, env);
    expect(accessUser(req)?.email).toBe('user@test.com');
  });
  it('rejects missing JWT, wrong signatures, algorithms, audience, issuer and expired claims', async () => {
    const good = await jwt('user@test.com');
    const parts = good.split('.');
    parts[1] = encode({ email: 'admin@test.com' });
    const invalid = [
      '',
      parts.join('.'),
      await jwt('user@test.com', { aud: ['other'] }),
      await jwt('user@test.com', { iss: 'https://evil.test' }),
      await jwt('user@test.com', { exp: 1 }),
      await jwt('user@test.com', {}, { alg: 'none' }),
    ];
    for (const value of invalid)
      await expect(
        verifyAccess(
          new Request('https://relay.test/api/v1/healthz', {
            headers: { 'Cf-Access-Jwt-Assertion': value },
          }),
          env,
        ),
      ).rejects.toMatchObject({ code: 'ACCESS_REQUIRED' });
    const request = new Request('https://relay.test', {
      headers: { 'Cf-Access-Jwt-Assertion': good },
    });
    await verifyAccess(request, env);
    expect(accessUser(request)?.email).toBe('user@test.com');
  });
  it('authenticates machines using CoC API keys without original Access credentials', async () => {
    const key = (await op('apiKeyCreate', { name: 'machine', role: 'agent' }))
      .data;
    const login = await request('/api/v1/auth/api-key', null, {
      role: 'agent',
      name: 'machine',
      apiKey: key.apiKey,
    });
    expect(login.status).toBe(200);
    expect(login.data.hostId).toBeTruthy();
  });
  it('does not interpret Client headers or a bearer as a second Access authentication scheme', async () => {
    const response = await request(
      '/api/v1/auth/email',
      'user@test.com',
      undefined,
      '',
      {
        'CF-Access-Client-Id': 'not-a-worker-setting',
        Authorization: 'Bearer invalid-coc-key',
      },
    );
    expect(response.status).toBe(200);
    expect(response.data.email).toBe('user@test.com');
  });
  it('fails closed for incomplete configuration and preserves opt-out development', async () => {
    env.ACCESS_AUD = '';
    await expect(
      verifyAccess(new Request('https://relay.test'), env),
    ).rejects.toMatchObject({ code: 'ACCESS_CONFIG' });
    env.ACCESS_ENABLED = 'false';
    await expect(
      verifyAccess(new Request('https://relay.test'), env),
    ).resolves.toBeUndefined();
  });
});

describe('guest CoC authorization', () => {
  it('pairs a guest without email and uses a separate scoped CoC cookie', async () => {
    const target = await host();
    const identity = await guestRequest('/api/v1/auth/email');
    expect(await identity.json()).toEqual({ enabled: false });
    const start = await guestRequest('/api/v1/auth/device/start', {
      role: 'web',
      name: 'Guest',
      requestedHostId: target.hostId,
      identity: { email: 'admin@test.com' },
    });
    expect(start.status).toBe(200);
    const pending = (await start.json()) as any;
    const pendingCookie = start.headers.get('Set-Cookie')!;
    expect(pendingCookie).toContain('coc_guest_pending_');
    expect(pendingCookie).toContain('Path=/guest/api/v1/auth/device;');
    const waiting = await guestRequest(
      '/api/v1/auth/device/poll',
      { id: pending.id },
      pendingCookie.split(';')[0],
    );
    expect(((await waiting.json()) as any).state).toBe('pending');
    expect((await op('deviceApprove', { id: pending.id })).status).toBe(200);
    const poll = await guestRequest(
      '/api/v1/auth/device/poll',
      { id: pending.id },
      pendingCookie.split(';')[0],
    );
    expect(poll.status).toBe(200);
    expect(((await poll.json()) as any).state).toBe('approved');
    const cookie = poll.headers.get('Set-Cookie')!;
    expect(cookie).toContain('coc_guest_web_' + target.hostId);
    expect(cookie).toContain('Path=/guest;');
    const authorized = await guestRequest(
      '/api/v1/client/identity?hostId=' + target.hostId,
      undefined,
      cookie.split(';')[0],
    );
    expect(authorized.status).toBe(200);
    const guestIdentity = ((await authorized.json()) as any).identity;
    const socketFetch = vi.fn(async () => Response.json({ ok: true }));
    vi.spyOn(env.HOSTS, 'get').mockReturnValue({
      fetch: socketFetch,
    } as unknown as DurableObjectStub);
    const socket = await guestRequest(
      '/ws/v1/hosts/' + target.hostId,
      undefined,
      cookie.split(';')[0],
      { Upgrade: 'websocket' },
    );
    expect(socket.status).toBe(200);
    expect((socketFetch.mock.calls as unknown as [Request][])[0][0].url).toBe(
      'https://internal/subscribe',
    );
    const missing = await guestRequest(
      '/api/v1/client/identity?hostId=' + target.hostId,
    );
    expect(missing.status).toBe(401);
    const other = await host();
    expect(
      (
        await guestRequest(
          '/api/v1/client/identity?hostId=' + other.hostId,
          undefined,
          cookie.split(';')[0],
        )
      ).status,
    ).toBe(401);
    expect(
      (await guestRequest('/api/v1/auth/email/admin', {}, cookie.split(';')[0]))
        .status,
    ).toBe(403);
    const regular = await request(
      '/api/v1/client/identity?hostId=' + target.hostId,
      'user@test.com',
      undefined,
      cookie.split(';')[0],
    );
    expect(regular.status).toBe(401);
    const list = await request('/api/v1/hosts', 'user@test.com');
    expect(list.data).toEqual([]);
    expect((await op('credentialRevoke', { id: guestIdentity })).status).toBe(
      200,
    );
    const revoked = await guestRequest(
      '/api/v1/client/identity?hostId=' + target.hostId,
      undefined,
      cookie.split(';')[0],
    );
    expect(revoked.status).toBe(401);
  });
  it('keeps CoC authentication and origin checks on guest API and WebSocket routes', async () => {
    const target = await host();
    const socket = await guestRequest(
      '/ws/v1/hosts/' + target.hostId,
      undefined,
      '',
      { Upgrade: 'websocket' },
    );
    expect(socket.status).toBe(401);
    const foreign = await guestRequest(
      '/api/v1/auth/device/start',
      { role: 'web', name: 'Guest' },
      '',
      { Origin: 'https://evil.test' },
    );
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as any).error.code).toBe('BAD_ORIGIN');
    const admin = await guestRequest('/api/v1/admin/keys');
    expect(admin.status).toBe(401);
    const spoofed = await request(
      '/api/v1/auth/device/start',
      null,
      { role: 'web', name: 'Guest' },
      '',
      { 'x-coc-email-auth': 'optional' },
    );
    expect(spoofed.status).toBe(403);
  });
});

describe('email grants and administrator identity', () => {
  it('grants associated emails access on every browser and hides the configured list', async () => {
    const a = await host();
    const admin = await request(
      '/api/v1/auth/email/admin',
      'admin@test.com',
      {},
    );
    const path = `/api/v1/admin/hosts/${a.hostId}/access-emails`;
    expect(
      (await request(path, 'user@test.com', { emails: ['user@test.com'] }))
        .status,
    ).toBe(401);
    expect(
      (
        await request(
          path,
          'admin@test.com',
          { emails: ['user@TEST.com', 'other@test.com', 'user@test.com'] },
          admin.cookie,
        )
      ).status,
    ).toBe(200);
    const hostList = await request('/api/v1/hosts', 'user@test.com');
    expect(hostList.data).toHaveLength(1);
    expect(hostList.data[0].id).toBe(a.hostId);
    expect(hostList.data[0]).not.toHaveProperty('accessEmailsOverride');
    expect(hostList.data[0]).not.toHaveProperty('agentAccessEmails');
    expect((await request('/api/v1/hosts', 'stranger@test.com')).data).toEqual(
      [],
    );
    const restore = '/api/v1/auth/email/restore';
    const first = await request(restore, 'user@test.com', { hostId: a.hostId });
    const second = await request(restore, 'user@test.com', {
      hostId: a.hostId,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.cookie).not.toBe(second.cookie);
    const identity = `/api/v1/client/identity?hostId=${a.hostId}`;
    expect(
      (await request(identity, 'user@test.com', undefined, second.cookie))
        .status,
    ).toBe(200);
    expect(
      (await request(identity, 'stranger@test.com', undefined, second.cookie))
        .status,
    ).toBe(403);
    expect(
      (
        await request(
          '/api/v1/admin/devices',
          'user@test.com',
          undefined,
          second.cookie,
        )
      ).status,
    ).toBe(401);
    expect(
      (await guestRequest(restore, { hostId: a.hostId }, first.cookie)).status,
    ).toBe(403);
    expect(
      (await request(path, 'admin@test.com', { emails: [] }, admin.cookie))
        .status,
    ).toBe(200);
    expect(
      (await request(identity, 'user@test.com', undefined, first.cookie))
        .status,
    ).toBe(401);
    expect(
      (await request(identity, 'user@test.com', undefined, second.cookie))
        .status,
    ).toBe(401);
    expect(
      (await request(restore, 'user@test.com', { hostId: a.hostId })).status,
    ).toBe(403);
  });
  it('scopes Agent defaults to its own host and preserves administrator overrides and paired grants', async () => {
    const a = await host(),
      b = await host();
    const agentConfig = (emails: string[]) =>
      request(
        '/api/v1/agent/access-emails',
        null,
        { emails, id: b.hostId },
        '',
        { Authorization: 'Bearer ' + a.token },
      );
    expect((await agentConfig(['user@test.com'])).status).toBe(200);
    expect(
      (await request('/api/v1/hosts', 'user@test.com')).data.map(
        (h: any) => h.id,
      ),
    ).toEqual([a.hostId]);
    const restored = await request(
      '/api/v1/auth/email/restore',
      'user@test.com',
      { hostId: a.hostId },
    );
    expect(restored.status).toBe(200);
    const admin = await request(
      '/api/v1/auth/email/admin',
      'admin@test.com',
      {},
    );
    const config = (emails: string[] | null) =>
      request(
        `/api/v1/admin/hosts/${a.hostId}/access-emails`,
        'admin@test.com',
        { emails },
        admin.cookie,
      );
    expect((await config([])).status).toBe(200);
    expect(
      (await agentConfig(['user@test.com', 'second@test.com'])).status,
    ).toBe(200);
    expect((await request('/api/v1/hosts', 'user@test.com')).data).toEqual([]);
    expect((await config(null)).status).toBe(200);
    expect(
      (await request('/api/v1/hosts', 'second@test.com')).data.map(
        (h: any) => h.id,
      ),
    ).toEqual([a.hostId]);
    expect((await pair('user@test.com', a.hostId)).status).toBe(200);
    expect((await agentConfig([])).status).toBe(200);
    expect(
      (await request('/api/v1/hosts', 'user@test.com')).data.map(
        (h: any) => h.id,
      ),
    ).toEqual([a.hostId]);
    expect((await request('/api/v1/hosts', 'second@test.com')).data).toEqual(
      [],
    );
    expect(
      (
        await request(
          `/api/v1/admin/hosts/${b.hostId}/access-emails`,
          'admin@test.com',
          { emails: ['bad-email'] },
          admin.cookie,
        )
      ).status,
    ).toBe(400);
  });
  it('keeps an explicitly revoked association removed across Agent configuration syncs', async () => {
    const a = await host();
    const agentConfig = () =>
      request(
        '/api/v1/agent/access-emails',
        null,
        { emails: ['user@test.com'] },
        '',
        { Authorization: 'Bearer ' + a.token },
      );
    expect((await agentConfig()).status).toBe(200);
    const restored = await request(
      '/api/v1/auth/email/restore',
      'user@test.com',
      { hostId: a.hostId },
    );
    const admin = await request(
      '/api/v1/auth/email/admin',
      'admin@test.com',
      {},
    );
    const devices = await request(
      '/api/v1/admin/devices',
      'admin@test.com',
      undefined,
      admin.cookie,
    );
    const grant = devices.data.credentials.find(
      (d: any) => d.email === 'user@test.com',
    );
    expect(
      (
        await request(
          '/api/v1/admin/revoke',
          'admin@test.com',
          { id: grant.id },
          admin.cookie,
        )
      ).status,
    ).toBe(200);
    expect((await agentConfig()).status).toBe(200);
    expect((await request('/api/v1/hosts', 'user@test.com')).data).toEqual([]);
    expect(
      (
        await request(
          `/api/v1/client/identity?hostId=${a.hostId}`,
          'user@test.com',
          undefined,
          restored.cookie,
        )
      ).status,
    ).toBe(401);
  });
  it('restores all authorized offline hosts on a new browser without pairing and isolates emails', async () => {
    const a = await host(),
      b = await host();
    expect((await pair('user@test.com', a.hostId)).status).toBe(200);
    expect((await pair('user@test.com', b.hostId)).status).toBe(200);
    const hosts = await request('/api/v1/hosts', 'user@test.com');
    expect(hosts.status).toBe(200);
    expect(hosts.data.map((h: any) => h.id).sort()).toEqual(
      [a.hostId, b.hostId].sort(),
    );
    expect((await request('/api/v1/hosts', 'other@test.com')).data).toEqual([]);
    const restored = await request(
      '/api/v1/auth/email/restore',
      'user@test.com',
      { hostId: a.hostId },
    );
    expect(restored.status).toBe(200);
    expect(restored.cookie).toContain('coc_web_');
    expect(
      (
        await request(
          `/api/v1/client/identity?hostId=${a.hostId}`,
          'user@test.com',
          undefined,
          restored.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/api/v1/client/identity?hostId=${a.hostId}`,
          'other@test.com',
          undefined,
          restored.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/api/v1/auth/email/restore', 'other@test.com', {
          hostId: a.hostId,
        })
      ).status,
    ).toBe(403);
    const saved = JSON.stringify([...storage.values.values()]);
    expect(saved).not.toContain(a.token);
    expect(saved).not.toContain(restored.cookie.split('=')[1]);
  });
  it('binds pairing to the verified email and creates no grant until valid delivery', async () => {
    const a = await host();
    const start = await request('/api/v1/auth/device/start', 'user@test.com', {
      role: 'web',
      name: 'CW',
      requestedHostId: a.hostId,
      email: 'admin@test.com',
      identity: { email: 'admin@test.com' },
    });
    expect((await op('devices')).data.pending[0].email).toBe('user@test.com');
    await op('deviceApprove', { id: start.data.id });
    expect((await request('/api/v1/hosts', 'user@test.com')).data).toEqual([]);
    expect(
      (
        await request(
          '/api/v1/auth/device/poll',
          'other@test.com',
          { id: start.data.id },
          start.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/api/v1/auth/device/poll',
          'user@test.com',
          { id: start.data.id },
          start.cookie,
        )
      ).status,
    ).toBe(200);
  });
  it('automatically grants admin only to the configured email; others can use the owner secret', async () => {
    const admin = await request(
      '/api/v1/auth/email/admin',
      'admin@test.com',
      {},
    );
    expect(admin.status).toBe(200);
    expect(
      (
        await request(
          '/api/v1/auth/me',
          'admin@test.com',
          undefined,
          admin.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          '/api/v1/auth/me',
          'other@test.com',
          undefined,
          admin.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (await request('/api/v1/auth/email/admin', 'other@test.com', {})).status,
    ).toBe(403);
    expect(
      (
        await request('/api/v1/auth/login', 'other@test.com', {
          secret: 'wrong',
        })
      ).status,
    ).toBe(401);
    const other = await request('/api/v1/auth/login', 'other@test.com', {
      secret: env.OWNER_SECRET,
    });
    expect(other.status).toBe(200);
    expect(
      (
        await request(
          '/api/v1/auth/me',
          'other@test.com',
          undefined,
          other.cookie,
        )
      ).status,
    ).toBe(200);
    env.ADMIN_EMAIL = 'new-admin@test.com';
    expect(
      (
        await request(
          '/api/v1/auth/me',
          'admin@test.com',
          undefined,
          admin.cookie,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          '/api/v1/auth/me',
          'other@test.com',
          undefined,
          other.cookie,
        )
      ).status,
    ).toBe(200);
    env.OWNER_SECRET = 'rotated-secret-'.repeat(4);
    expect(
      (
        await request(
          '/api/v1/auth/me',
          'other@test.com',
          undefined,
          other.cookie,
        )
      ).status,
    ).toBe(401);
  });
  it('revokes every browser derived from a grant, preserving other email/host grants', async () => {
    const a = await host(),
      b = await host();
    const first = await pair('user@test.com', a.hostId);
    const second = await request(
      '/api/v1/auth/email/restore',
      'user@test.com',
      { hostId: a.hostId },
    );
    await pair('user@test.com', b.hostId);
    await pair('other@test.com', a.hostId);
    expect(
      (
        await request(
          `/api/v1/client/identity?hostId=${a.hostId}`,
          'user@test.com',
          undefined,
          first.cookie,
        )
      ).status,
    ).toBe(200);
    const admin = await request(
      '/api/v1/auth/email/admin',
      'admin@test.com',
      {},
    );
    const devices = await request(
      '/api/v1/admin/devices',
      'admin@test.com',
      undefined,
      admin.cookie,
    );
    const grant = devices.data.credentials.find(
      (a_: any) => a_.hostId === a.hostId && a_.name === 'user@test.com',
    );
    expect(grant.email).toBe('user@test.com');
    expect(grant.lastSeen).toEqual(expect.any(Number));
    expect(
      (
        await request(
          '/api/v1/admin/revoke',
          'admin@test.com',
          { id: grant.id },
          admin.cookie,
        )
      ).status,
    ).toBe(200);
    for (const cookie of [first.cookie, second.cookie])
      expect(
        (
          await request(
            `/api/v1/client/identity?hostId=${a.hostId}`,
            'user@test.com',
            undefined,
            cookie,
          )
        ).status,
      ).toBe(401);
    expect(
      (
        await request('/api/v1/auth/email/restore', 'user@test.com', {
          hostId: a.hostId,
        })
      ).status,
    ).toBe(403);
    expect(
      (await request('/api/v1/hosts', 'user@test.com')).data.map(
        (h: any) => h.id,
      ),
    ).toEqual([b.hostId]);
    expect(
      (await request('/api/v1/hosts', 'other@test.com')).data.map(
        (h: any) => h.id,
      ),
    ).toEqual([a.hostId]);
  });
  it('requires explicit legacy migration and prevents a second email from claiming the same key', async () => {
    const a = await host();
    env.ACCESS_ENABLED = 'false';
    const pending = (
      await op('deviceStart', {
        role: 'web',
        name: 'legacy',
        requestedHostId: a.hostId,
      })
    ).data;
    await op('deviceApprove', { id: pending.id });
    const old = (
      await op('devicePoll', {
        id: pending.id,
        pollSecret: pending.pollSecret,
        web: true,
      })
    ).data;
    const cookie = `coc_web_${a.hostId}=${old.token}`;
    env.ACCESS_ENABLED = 'true';
    expect(
      (await request('/api/v1/hosts', 'user@test.com', undefined, cookie)).data,
    ).toEqual([]);
    expect(
      (await request('/api/v1/auth/email', 'user@test.com', undefined, cookie))
        .data.legacy,
    ).toHaveLength(1);
    expect(
      (
        await request(
          '/api/v1/auth/email/migrate',
          'user@test.com',
          { hostId: a.hostId },
          cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          '/api/v1/auth/email/migrate',
          'other@test.com',
          { hostId: a.hostId },
          cookie,
        )
      ).status,
    ).toBe(403);
  });
});
