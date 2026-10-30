import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { managesProjects } from '../apps/relay/src/project-auth.ts';
import { digest, type Auth, type Env } from '../apps/relay/src/common.ts';
import {
  agentConfigSchema,
  projectManagementSchema,
} from '../packages/protocol/src/index.ts';
let storage: MemoryStorage, registry: RegistryDO, env: Env;
let sent: any[];
async function op(name: string, data: unknown = {}) {
  const r = await registry.fetch(
    new Request('https://internal/' + name, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  );
  return { status: r.status, data: (await r.json()) as any };
}
async function auth(
  token: string,
  role: Auth['role'],
  hostId?: string,
  extra: Partial<Auth> = {},
) {
  const value: Auth = {
    hash: await digest(token),
    role,
    hostId,
    name: token,
    version: 2,
    created: Date.now(),
    expires: Date.now() + 3600000,
    ...extra,
  };
  await storage.put('auth:' + value.hash, value);
  return value;
}
async function request(path: string, token: string, data?: unknown) {
  const r = await worker.fetch(
    new Request('https://relay.test/api/v1' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'X-CoC-Async': '1' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),
    env,
  );
  return { status: r.status, data: (await r.json()) as any };
}
beforeEach(async () => {
  storage = new MemoryStorage();
  sent = [];
  env = {
    OWNER_SECRET: 'x'.repeat(64),
    ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    REGISTRY: {
      idFromName: () => 'registry',
      get: () => ({ fetch: (req: Request) => registry.fetch(req) }),
    },
    HOSTS: {
      idFromName: (id: string) => id,
      get: (id: string) => ({
        fetch: async (req: Request) => {
          sent.push({
            id,
            data: req.method === 'POST' ? await req.json() : null,
            auth: JSON.parse(decodeURIComponent(req.headers.get('x-auth')!)),
          });
          return Response.json(
            { accepted: true, operationId: 'operation', hostId: id },
            { status: 202 },
          );
        },
      }),
    },
  } as unknown as Env;
  registry = new RegistryDO({ storage } as unknown as DurableObjectState, env);
  for (const id of ['alice', 'bob'])
    await storage.put('host:' + id, {
      id,
      version: 2,
      name: id,
      disabled: false,
    });
  await auth('client', 'cli', 'alice');
  await auth('agent', 'agent', 'alice');
  await auth('owner', 'owner', undefined, {
    ownerVersion: await digest(env.OWNER_SECRET),
  });
});
describe('project management identities', () => {
  it('allows ordinary clients to list only their instance, rejects mutations and forged identity', async () => {
    expect(
      (await request('/hosts/alice/project-management', 'client')).status,
    ).toBe(202);
    expect(
      (await request('/hosts/bob/project-management', 'client')).status,
    ).toBe(403);
    expect(
      (
        await request('/hosts/alice/project-management', 'client', {
          operation: 'add',
          path: '/work',
          revision: 0,
          requestId: 'request',
          email: 'admin@example.com',
          role: 'owner',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/hosts/alice/project-management', 'client', {
          operation: 'browse',
          path: '/',
        })
      ).status,
    ).toBe(403);
    expect(sent).toHaveLength(1);
  });
  it('allows platform administrators on either instance and namespaces request IDs by credential', async () => {
    for (const id of ['alice', 'bob'])
      expect(
        (
          await request(`/admin/hosts/${id}/project-management`, 'owner', {
            operation: 'add',
            path: '/work',
            revision: 0,
            requestId: 'request',
          })
        ).status,
      ).toBe(202);
    expect(sent.map((s) => s.id)).toEqual(['alice', 'bob']);
    expect(sent[0].data.data.requestId).toBe(
      await digest((await digest('owner')) + ':request'),
    );
    expect(
      (await request('/admin/hosts/alice/project-management', 'client')).status,
    ).toBe(403);
  });
  it('binds Agent email only to its own instance, with platform override precedence', async () => {
    expect(
      (
        await request('/agent/admin-email', 'agent', {
          email: 'Alice@EXAMPLE.com',
          id: 'bob',
        })
      ).status,
    ).toBe(200);
    expect((await op('host', { id: 'alice' })).data.agentAdminEmail).toBe(
      'Alice@example.com',
    );
    expect(
      (await op('host', { id: 'bob' })).data.agentAdminEmail,
    ).toBeUndefined();
    await request('/admin/hosts/alice/admin-email', 'owner', {
      email: 'other@example.com',
    });
    const host = (await op('host', { id: 'alice' })).data;
    env.ACCESS_ENABLED = 'true';
    const accountId = await digest(
      JSON.stringify([env.ACCESS_TEAM_DOMAIN, 'other@example.com']),
    );
    const administrator = await auth('email', 'web', 'alice', {
      email: 'other@example.com',
      accountId,
    });
    expect(await managesProjects(env, administrator, host)).toBe(true);
    expect(
      await managesProjects(env, { ...administrator, hostId: 'bob' }, host),
    ).toBe(false);
    expect(
      await managesProjects(
        env,
        { ...administrator, accountId: 'forged' },
        host,
      ),
    ).toBe(false);
    await op('setAdminEmail', { id: 'alice', email: null });
    expect(
      await managesProjects(
        env,
        administrator,
        (await op('host', { id: 'alice' })).data,
      ),
    ).toBe(false);
  });
  it('requires verified administrator pairing and revokes CC management after email association changes', async () => {
    env.ACCESS_ENABLED = 'true';
    await op('setAdminEmail', { id: 'alice', email: 'admin@example.com' });
    const email = 'admin@example.com',
      accountId = await digest(JSON.stringify([env.ACCESS_TEAM_DOMAIN, email]));
    const reviewer = await auth('email', 'web', 'alice', { email, accountId });
    const pending = (
      await op('deviceStart', {
        role: 'cli',
        name: 'Manager CC',
        manager: true,
        requestedHostId: 'alice',
        ip: 'test',
      })
    ).data;
    expect(pending.url).toContain('#manager=');
    expect(
      (
        await op('agentDeviceApprove', {
          id: pending.id,
          agentHash: await digest('agent'),
        })
      ).status,
    ).toBe(403);
    expect(
      (await op('deviceApprove', { id: pending.id, hostId: 'alice' })).status,
    ).toBe(403);
    expect(
      (
        await op('managerDevice', {
          id: pending.id,
          reviewerHash: await digest('client'),
          decision: 'approve',
          code: pending.code,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await op('managerDevice', {
          id: pending.id,
          reviewerHash: reviewer.hash,
          decision: 'approve',
          code: 'WRONG',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await op('managerDevice', {
          id: pending.id,
          reviewerHash: reviewer.hash,
          decision: 'approve',
          code: pending.code,
        })
      ).status,
    ).toBe(200);
    const grant = (
      await op('devicePoll', {
        id: pending.id,
        pollSecret: pending.pollSecret,
        web: false,
      })
    ).data;
    const identity = (await op('auth', { token: grant.token })).data;
    expect(identity.manager).toMatchObject({ kind: 'email', email, accountId });
    expect(
      await managesProjects(
        env,
        identity,
        (await op('host', { id: 'alice' })).data,
      ),
    ).toBe(true);
    await op('setAdminEmail', { id: 'alice', email: 'new@example.com' });
    expect((await op('auth', { token: grant.token })).status).toBe(403);
  });
  it('does not upgrade normal paired clients even when a platform administrator approves', async () => {
    const pending = (
      await op('deviceStart', {
        role: 'cli',
        name: 'Ordinary CC',
        requestedHostId: 'alice',
        ip: 'test',
      })
    ).data;
    await op('deviceApprove', {
      id: pending.id,
      approvedBy: await digest('owner'),
    });
    const grant = (
      await op('devicePoll', {
        id: pending.id,
        pollSecret: pending.pollSecret,
        web: false,
      })
    ).data;
    expect(
      (await op('auth', { token: grant.token })).data.manager,
    ).toBeUndefined();
    expect(
      (
        await request('/hosts/alice/project-management', grant.token, {
          operation: 'browse',
          path: '/',
        })
      ).status,
    ).toBe(403);
  });
  it('allows platform identity pairing and invalidates it after platform secret rotation', async () => {
    const pending = (
      await op('deviceStart', {
        role: 'cli',
        name: 'Owner CC',
        manager: true,
        requestedHostId: 'bob',
        ip: 'test',
      })
    ).data;
    await op('managerDevice', {
      id: pending.id,
      reviewerHash: await digest('owner'),
      decision: 'approve',
      code: pending.code,
    });
    const grant = (
      await op('devicePoll', {
        id: pending.id,
        pollSecret: pending.pollSecret,
        web: false,
      })
    ).data;
    expect(
      (
        await request('/hosts/bob/project-management', grant.token, {
          operation: 'browse',
          path: '/',
        })
      ).status,
    ).toBe(202);
    expect(
      (await request('/hosts/alice/project-management', grant.token)).status,
    ).toBe(403);
    env.OWNER_SECRET = 'y'.repeat(64);
    expect((await op('auth', { token: grant.token })).status).toBe(403);
  });
  it('validates revisions, directory strings and optional empty catalogs', () => {
    expect(agentConfigSchema.shape.projects.safeParse([]).success).toBe(true);
    for (const d of [
      { operation: 'add', path: '/work', requestId: 'id' },
      { operation: 'remove', id: 'p', requestId: 'id', revision: -1 },
      { operation: 'browse', path: '/work\0outside' },
    ])
      expect(projectManagementSchema.safeParse(d).success).toBe(false);
  });
});
