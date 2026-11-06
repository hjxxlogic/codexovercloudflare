import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: any,
      public env: any,
    ) {}
  },
}));
vi.mock('../apps/relay/src/common.ts', async (original) => ({
  ...(await original<typeof import('../apps/relay/src/common.ts')>()),
  registryCall: vi.fn(),
}));
import { registryCall, type Auth, type Env } from '../apps/relay/src/common.ts';
import worker from '../apps/relay/src/index.ts';
import { managementRequestSchema } from '../packages/protocol/src/management.ts';
const owner = {
  role: 'owner',
  hash: 'owner',
  expires: Number.MAX_SAFE_INTEGER,
} as Auth;
beforeEach(() => {
  vi.mocked(registryCall)
    .mockReset()
    .mockImplementation(async (_env, op, data: any) =>
      op === 'auth'
        ? {
            ...owner,
            role: data.token === 'owner' ? 'owner' : 'cli',
            hostId: data.token === 'owner' ? undefined : 'host',
          }
        : { id: 'host' },
    );
});
describe('encrypted configuration admission', () => {
  it('authorizes owner connections and online target discovery without exposing configuration', async () => {
    const forwarded: Request[] = [];
    const env = {
      HOSTS: {
        idFromName: (id: string) => id,
        get: () => ({
          fetch: async (req: Request) => {
            forwarded.push(req);
            return Response.json({ targets: ['agent'] });
          },
        }),
      },
    } as unknown as Env;
    const get = (path: string, token?: string) =>
      worker.fetch(
        new Request('https://relay.test' + path, {
          headers: {
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
            ...(path.startsWith('/ws/') ? { Upgrade: 'websocket' } : {}),
          },
        }),
        env,
      );
    expect((await get('/api/v1/admin/hosts/host/connections')).status).toBe(
      401,
    );
    expect(
      (await get('/api/v1/admin/hosts/host/connections', 'client')).status,
    ).toBe(403);
    expect(
      (await get('/api/v1/admin/hosts/host/connections', 'owner')).status,
    ).toBe(200);
    expect(new URL(forwarded[0].url).pathname).toBe('/connections');
    expect((await get('/ws/v1/channel/host?admin=1', 'client')).status).toBe(
      403,
    );
    expect((await get('/ws/v1/channel/host?admin=1', 'owner')).status).toBe(
      200,
    );
    expect(new URL(forwarded[1].url).pathname).toBe('/channel');
    expect((await get('/ws/v1/client-management/other', 'client')).status).toBe(
      403,
    );
    expect((await get('/ws/v1/client-management/host', 'owner')).status).toBe(
      403,
    );
    expect(
      (await get('/api/v1/admin/hosts/host/configuration', 'owner')).status,
    ).toBe(426);
    expect(forwarded).toHaveLength(2);
  });
  it('keeps bounded configuration validation at endpoints and rejects forged targets and missing originals', () => {
    expect(
      managementRequestSchema.safeParse({
        target: 'agent',
        command: { action: 'read' },
      }).success,
    ).toBe(true);
    for (const command of [
      { action: 'replace', text: '{}' },
      { action: 'restart' },
      {
        action: 'replace',
        text: '中'.repeat(262144),
        requestId: 'id',
        revision: 'a'.repeat(64),
      },
    ])
      expect(
        managementRequestSchema.safeParse({ target: 'agent', command }).success,
      ).toBe(false);
  });
});
