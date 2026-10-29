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
  return (
    await op('apiKeyLogin', {
      role: 'agent',
      name: 'A',
      apiKey: key.apiKey,
      ip: crypto.randomUUID(),
    })
  ).data;
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

describe('email grants and administrator identity', () => {
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
