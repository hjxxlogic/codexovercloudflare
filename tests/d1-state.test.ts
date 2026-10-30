import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  D1State,
  listAll,
  migrateState,
  type StateStorage,
} from '../apps/relay/src/state.ts';
import { SqliteD1 } from './helpers/d1-state.ts';
import { MemoryStorage } from './helpers/do-state.ts';
import {
  HOST_IDLE_MS,
  HostLifecycle,
} from '../apps/relay/src/host-lifecycle.ts';
import { expireAt } from '../apps/relay/src/expiry.ts';
import { emailOperation, setAccessEmails } from '../apps/relay/src/email.ts';
import { digest } from '../apps/relay/src/common.ts';

const databases: SqliteD1[] = [];
function database() {
  const db = new SqliteD1();
  databases.push(db);
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
  vi.useRealTimers();
});

describe('D1 authoritative state', () => {
  it('scans beyond the default D1 page, including transaction changes', async () => {
    const db = database();
    const state = new D1State(db.binding(), 'registry');
    const insert = db.sqlite.prepare(
      'INSERT INTO relay_state(scope, key, value) VALUES (?, ?, ?)',
    );
    for (let i = 0; i < 1050; i++)
      insert.run(
        'registry',
        `host:${String(i).padStart(4, '0')}`,
        JSON.stringify({ id: i }),
      );
    expect((await state.list({ prefix: 'host:' })).size).toBe(1000);
    expect((await listAll(state, { prefix: 'host:' })).size).toBe(1050);
    await state.transaction(async (tx) => {
      await tx.delete('host:0000');
      await tx.put('host:9999', { id: 9999 });
      const hosts = await listAll(tx, { prefix: 'host:' });
      expect(hosts.size).toBe(1050);
      expect(hosts.has('host:0000')).toBe(false);
      expect(hosts.has('host:1049')).toBe(true);
      expect(hosts.has('host:9999')).toBe(true);
    });
  });
  it('persists email associations and atomically revokes derived credentials across reconstruction', async () => {
    const db = database();
    const state = new D1State(db.binding(), 'registry');
    const issuer = 'https://email-test.cloudflareaccess.com';
    const env = { ACCESS_ENABLED: 'true', ACCESS_TEAM_DOMAIN: issuer } as Env;
    const identity = {
      issuer,
      email: 'user@example.com',
      accountId: await digest(JSON.stringify([issuer, 'user@example.com'])),
    };
    await state.put('host:mail-host', {
      id: 'mail-host',
      name: 'Mail host',
      version: 2,
      disabled: false,
    });
    await state.transaction((tx) =>
      setAccessEmails(tx, env, 'mail-host', ['user@example.com'], true),
    );
    const restored: any = await state.transaction((tx) =>
      emailOperation(tx, env, 'emailRestore', {
        identity,
        hostId: 'mail-host',
      }),
    );
    const authKey = 'auth:' + (await digest(restored.token));
    expect(await state.get(authKey)).toMatchObject({
      role: 'web',
      hostId: 'mail-host',
    });
    db.failBatch = () => true;
    await expect(
      state.transaction((tx) =>
        setAccessEmails(tx, env, 'mail-host', [], false),
      ),
    ).rejects.toThrow('Injected');
    db.failBatch = undefined;
    const rebuilt = new D1State(db.binding(), 'registry');
    expect(await rebuilt.get(authKey)).toBeDefined();
    expect(await rebuilt.get('host:mail-host')).not.toHaveProperty(
      'accessEmailsOverride',
    );
    const result = await rebuilt.transaction((tx) =>
      setAccessEmails(tx, env, 'mail-host', [], false),
    );
    expect(result.revoked.map((auth) => auth.hash)).toEqual([restored.hash]);
    expect(await rebuilt.get(authKey)).toBeUndefined();
    expect(
      await rebuilt.get(`emailGrant:${identity.accountId}:mail-host`),
    ).toMatchObject({ active: false });
    expect(
      await rebuilt.transaction((tx) =>
        emailOperation(tx, env, 'emailHosts', { identity }),
      ),
    ).toEqual([]);
  });
  it('schedules an indexed record without rewriting the D1 expiry index', async () => {
    const db = database();
    const alarms = new MemoryStorage();
    const state = new D1State(db.binding(), 'host:a', alarms);
    const expires = Date.now() + 10000;
    await state.put('operation:one', { expires });
    const batches = vi.spyOn(db, 'batch');
    await expireAt(state, 'operation:one', expires);
    expect(batches).not.toHaveBeenCalled();
    expect(alarms.alarm).toBe(expires);
    expect((await state.list({ prefix: 'due:' })).size).toBe(1);
  });
  it('accepts concurrent transport updates without exhausting scope retries', async () => {
    const db = database();
    const state = new D1State(db.binding(), 'host:busy');
    await state.put('epoch', 0);
    await Promise.all(
      Array.from({ length: 24 }, () =>
        state.transaction(async (tx) => {
          const epoch = (await tx.get<number>('epoch'))!;
          await tx.put('epoch', epoch + 1);
        }),
      ),
    );
    expect(await state.get('epoch')).toBe(24);
  });
  it('commits finite state with its expiry index even before alarm scheduling', async () => {
    const db = database();
    const state = new D1State(db.binding(), 'host:a');
    const expires = Date.now() + 300000;
    await state.put('operation:one', { expires, state: 'pending' });
    const key = `due:${String(expires).padStart(16, '0')}:operation:one`;
    expect(await state.get(key)).toEqual({ key: 'operation:one', at: expires });
    db.failBatch = () => true;
    await expect(state.put('operation:two', { expires })).rejects.toThrow(
      'Injected',
    );
    db.failBatch = undefined;
    expect(await state.get('operation:two')).toBeUndefined();
    expect((await state.list({ prefix: 'due:' })).size).toBe(1);
  });
  it('isolates hosts and orders bounded prefix pages with buffered changes', async () => {
    const db = database();
    const a = new D1State(db.binding(), 'host:a'),
      b = new D1State(db.binding(), 'host:b');
    await a.put({
      'lease:2': { epoch: 2 },
      'lease:1': { epoch: 1 },
      other: true,
    });
    await b.put('lease:1', { epoch: 90 });
    expect(await a.get('lease:1')).toEqual({ epoch: 1 });
    expect(await b.get('lease:1')).toEqual({ epoch: 90 });
    expect([
      ...(await a.list({ prefix: 'lease:', startAfter: 'lease:1', limit: 1 })),
    ]).toEqual([['lease:2', { epoch: 2 }]]);
    await a.transaction(async (tx) => {
      await tx.delete('lease:1');
      await tx.put('lease:0', { epoch: 3 });
      expect([...(await tx.list({ prefix: 'lease:', limit: 1 }))]).toEqual([
        ['lease:0', { epoch: 3 }],
      ]);
    });
    expect(await a.get('lease:1')).toBeUndefined();
    expect(await b.get('lease:1')).toEqual({ epoch: 90 });
  });
  it('retries competing epochs without losing either update or leaking partial writes', async () => {
    const db = database();
    const a = new D1State(db.binding(), 'host:a'),
      b = new D1State(db.binding(), 'host:a');
    await a.put('epoch', 10);
    let arrivals = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const increment = (state: D1State, id: string) =>
      state.transaction(async (tx) => {
        const epoch = (await tx.get<number>('epoch'))!;
        if (++arrivals <= 2) {
          if (arrivals === 2) release();
          await barrier;
        }
        await tx.put('epoch', epoch + 1);
        await tx.put(id, epoch + 1);
        return epoch + 1;
      });
    const epochs = await Promise.all([increment(a, 'a'), increment(b, 'b')]);
    expect(epochs.sort()).toEqual([11, 12]);
    expect(await a.get('epoch')).toBe(12);
    expect(new Set([await a.get('a'), await a.get('b')])).toEqual(
      new Set([11, 12]),
    );
  });
  it('does not commit a rejected callback and fails closed when D1 writes fail', async () => {
    const db = database(),
      state = new D1State(db.binding(), 'registry');
    await state.put('auth:key', { active: true });
    await expect(
      state.transaction(async (tx) => {
        await tx.delete('auth:key');
        throw new Error('rejected');
      }),
    ).rejects.toThrow('rejected');
    db.failBatch = () => true;
    await expect(state.delete('auth:key')).rejects.toThrow('Injected');
    db.failBatch = undefined;
    expect(await state.get('auth:key')).toEqual({ active: true });
    await state.put('after-failure', true);
    expect(await state.get('after-failure')).toBe(true);
  });
  it('resumes failed migration pages without marking incomplete data authoritative', async () => {
    const db = database(),
      state = new D1State(db.binding(), 'host:a');
    const legacy = new MemoryStorage();
    for (let i = 0; i < 130; i++)
      legacy.values.set('lease:' + String(i).padStart(3, '0'), {
        epoch: i + 1,
      });
    let batches = 0;
    db.failBatch = () => ++batches === 2;
    await expect(
      migrateState(legacy as unknown as StateStorage, state),
    ).rejects.toThrow('Injected');
    expect(await state.get('@migrated')).toBeUndefined();
    expect(await state.get('@migrationCursor')).toBe('lease:063');
    expect(legacy.values.size).toBe(130);
    db.failBatch = undefined;
    await migrateState(legacy as unknown as StateStorage, state);
    expect((await state.list({ prefix: 'lease:' })).size).toBe(130);
    expect(await state.get('@migrated')).toMatchObject({ version: 1 });
    expect(await state.get('@migrationCursor')).toBeUndefined();
    await state.put('lease:000', { epoch: 999 });
    await migrateState(legacy as unknown as StateStorage, state);
    expect(await state.get('lease:000')).toEqual({ epoch: 999 });
  });
});

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: any,
      public env: any,
    ) {}
  },
}));
import { HostRelayDO } from '../apps/relay/src/host.ts';
import { RegistryCore, RegistryDO } from '../apps/relay/src/registry.ts';
import { collectIdleState, d1Receipt } from '../apps/relay/src/host-state.ts';
import {
  hostStatus,
  registryCall,
  type Auth,
  type Env,
} from '../apps/relay/src/common.ts';

function runtime() {
  const db = database(),
    legacy = new MemoryStorage();
  const sockets: any[] = [];
  const deleteAll = vi.fn(async () => {
    legacy.values.clear();
    legacy.alarm = null;
  });
  const ctx = {
    storage: Object.assign(legacy, { deleteAll }),
    getWebSockets: (tag?: string) =>
      tag ? sockets.filter((ws) => ws.tags?.includes(tag)) : sockets,
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
    waitUntil: () => {},
  };
  const env = {
    STATE_BACKEND: 'd1',
    STATE_DB: db.binding(),
    OWNER_SECRET: 'x'.repeat(64),
  } as unknown as Env;
  return { db, legacy, sockets, deleteAll, ctx, env };
}

describe('D1 relay lifecycle', () => {
  it('catches archive failure inside the concurrency gate and retains a retry alarm without resetting the object', async () => {
    const h = runtime();
    const reset = vi.fn();
    h.ctx.blockConcurrencyWhile = async (callback) => {
      try {
        return await callback();
      } catch (error) {
        reset();
        throw error;
      }
    };
    const relay = new HostRelayDO(
      h.ctx as unknown as DurableObjectState,
      h.env,
    ) as any;
    await relay.prepare('host-a');
    await relay.cleanup();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + HOST_IDLE_MS + 1);
    await relay.alarm();
    h.db.failBatch = () => true;
    await relay.alarm();
    expect(reset).not.toHaveBeenCalled();
    expect(h.deleteAll).not.toHaveBeenCalled();
    expect(h.legacy.alarm).toBe(Date.now() + 60000);
    expect(await relay.storage.get('presence')).toBeDefined();
  });
  it('runs concurrent online controls and restores hibernated state with zero Host D1 queries', async () => {
    const h = runtime();
    h.legacy.values.set('agentEpoch', 3);
    const auth = {
      hash: 'client',
      role: 'web',
      hostId: 'host-a',
      expires: Number.MAX_SAFE_INTEGER,
    };
    const agent = {
      tags: ['agent'],
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      deserializeAttachment: () => ({
        id: 'agent',
        role: 'agent',
        hostId: 'host-a',
        auth: { ...auth, hash: 'agent', role: 'agent' },
        epoch: 3,
        protocol: 1,
        deadline: Number.MAX_SAFE_INTEGER,
      }),
    };
    h.sockets.push(agent);
    const create = () => {
      const relay = new HostRelayDO(
        h.ctx as unknown as DurableObjectState,
        h.env,
      ) as any;
      relay.authorized = vi.fn().mockResolvedValue(undefined);
      return relay;
    };
    let relay = create();
    await relay.prepare('host-a');
    const queries = vi.spyOn(h.db, 'prepare');
    h.db.failBatch = () => true;
    const operations = await Promise.all(
      Array.from({ length: 20 }, () =>
        relay.start({
          auth,
          hostId: 'host-a',
          kind: 'control',
          stage: 'execute',
          action: 'projects',
          data: {},
        }),
      ),
    );
    relay = create();
    for (const [raw] of agent.send.mock.calls.slice()) {
      const frame = JSON.parse(raw);
      await relay.webSocketMessage(
        agent,
        JSON.stringify({
          v: 1,
          type: 'result',
          requestId: frame.requestId,
          data: [{ id: 'project' }],
        }),
      );
    }
    for (const operation of operations)
      expect(await relay.loadOperation(operation.id)).toMatchObject({
        state: 'completed',
        result: [{ id: 'project' }],
      });
    expect(queries).not.toHaveBeenCalled();
    expect(agent.close).not.toHaveBeenCalled();
  });
  it('commits operation stages and wire replacement together', async () => {
    const h = runtime();
    const relay = new HostRelayDO(
      h.ctx as unknown as DurableObjectState,
      h.env,
    ) as any;
    await relay.prepare('host-a');
    const operation = {
      id: 'one',
      state: 'pending',
      auth: { hash: 'owner' },
      expires: Date.now() + 10000,
      wire: 'old',
    };
    await relay.saveOperation(operation);
    const failedWrite = vi
      .spyOn(h.legacy, 'put')
      .mockRejectedValueOnce(new Error('Injected local write failure'));
    await expect(
      relay.saveOperation({ ...operation, wire: 'new' }),
    ).rejects.toThrow('Injected');
    failedWrite.mockRestore();
    h.db.failBatch = () => true; // Online state does not depend on D1 writes.
    expect(await relay.storage.get('wire:old')).toBe('one');
    expect(await relay.storage.get('wire:new')).toBeUndefined();
    await relay.saveOperation({ ...operation, wire: 'new' });
    expect(await relay.storage.get('wire:old')).toBeUndefined();
    expect(await relay.storage.get('wire:new')).toBe('one');
    await relay.saveOperation({
      ...operation,
      wire: 'new',
      state: 'completed',
    });
    expect(await relay.storage.get('wire:new')).toBeUndefined();
  });
  it('routes live receipt acknowledgements to the Host without writing D1', async () => {
    const h = runtime();
    const state = new D1State(h.db.binding(), 'host:host-a');
    await state.put({ '@migrated': true, presence: { connected: 1 } });
    const batches = vi.spyOn(h.db, 'batch');
    expect(
      await d1Receipt(
        h.env,
        'host-a',
        'receipt',
        { hash: 'owner' } as Auth,
        true,
      ),
    ).toBeUndefined();
    expect(batches).not.toHaveBeenCalled();
  });
  it('keeps notification ordering through hibernation without D1 writes', async () => {
    const h = runtime();
    const makeRelay = () =>
      new HostRelayDO(h.ctx as unknown as DurableObjectState, h.env) as any;
    const relay = makeRelay();
    await relay.prepare('host-a');
    const socket = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      deserializeAttachment: () => ({
        subscription: true,
        auth: { hash: 'owner' },
      }),
    };
    h.sockets.push(socket);
    const batches = vi.spyOn(h.db, 'batch');
    await relay.changed();
    expect(h.legacy.values.get('revision')).toBe(1);
    expect(batches).not.toHaveBeenCalled();
    const restored = makeRelay();
    await restored.prepare('host-a');
    await restored.changed();
    expect(h.legacy.values.get('revision')).toBe(2);
  });
  it('allows legacy notification callbacks to authenticate without waiting on their own publisher', async () => {
    const h = runtime();
    const registry = new RegistryDO(h.ctx as unknown as DurableObjectState, {
      ...h.env,
      STATE_BACKEND: undefined,
    });
    const core = vi
      .spyOn(RegistryCore.prototype, 'fetch')
      .mockImplementation(async (request) => {
        if (new URL(request.url).pathname === '/publish')
          return registry.fetch(new Request('https://internal/authHash'));
        return Response.json({ authorized: true });
      });
    try {
      const response = await registry.fetch(
        new Request('https://internal/publish'),
      );
      expect(await response.json()).toEqual({ authorized: true });
    } finally {
      core.mockRestore();
    }
  });
  it('migrates offline state before deleting local storage and reads later status without a DO', async () => {
    const h = runtime();
    h.legacy.values.set('agentEpoch', 7);
    h.legacy.values.set('lease:session', { epoch: 9, active: false });
    h.legacy.values.set('operation:receipt', {
      state: 'completed',
      result: { id: 'original' },
      expires: Date.now() + 300000,
      auth: { hash: 'owner' },
    });
    const relay = new HostRelayDO(
      h.ctx as unknown as DurableObjectState,
      h.env,
    );
    const response = await relay.fetch(
      new Request('https://internal/status', {
        headers: { 'x-host': 'host-a' },
      }),
    );
    expect(response.status).toBe(200);
    expect(h.deleteAll).not.toHaveBeenCalled();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + HOST_IDLE_MS + 1);
    const lifecycle = new HostLifecycle(
      h.ctx.storage,
      h.db.binding(),
      'host-a',
    );
    for (let i = 0; i < 10; i++) {
      if ((await lifecycle.archivePage()) === 'archived') break;
    }
    expect(h.deleteAll).toHaveBeenCalledOnce();
    expect(h.legacy.values.size).toBe(0);
    const state = new D1State(h.db.binding(), 'host:host-a');
    expect(await state.get('agentEpoch')).toBe(7);
    expect(await state.get('lease:session')).toEqual({
      epoch: 9,
      active: false,
    });
    expect(await state.get('operation:receipt')).toMatchObject({
      result: { id: 'original' },
    });
    h.env.HOSTS = {
      get: () => {
        throw new Error('Offline lookup must not wake a DO');
      },
    } as unknown as DurableObjectNamespace;
    expect(await hostStatus(h.env, 'host-a')).toMatchObject({
      online: false,
      confirmed: false,
    });
  });
  it('retains the legacy copy on migration failure', async () => {
    const h = runtime();
    h.legacy.values.set('agentEpoch', 77);
    h.db.failBatch = () => true;
    const relay = new HostRelayDO(
      h.ctx as unknown as DurableObjectState,
      h.env,
    );
    expect(
      (
        await relay.fetch(
          new Request('https://internal/status', {
            headers: { 'x-host': 'host-a' },
          }),
        )
      ).ok,
    ).toBe(false);
    expect(h.deleteAll).not.toHaveBeenCalled();
    expect(h.legacy.values.get('agentEpoch')).toBe(77);
  });
  it('does not clear a host with a connected subscriber', async () => {
    const h = runtime();
    h.sockets.push({
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      deserializeAttachment: () => ({ subscription: true, hostId: 'host-a' }),
    });
    const relay = new HostRelayDO(
      h.ctx as unknown as DurableObjectState,
      h.env,
    );
    await relay.fetch(
      new Request('https://internal/notify', {
        method: 'POST',
        headers: { 'x-host': 'host-a' },
        body: JSON.stringify({ scope: 'registry' }),
      }),
    );
    expect(h.deleteAll).not.toHaveBeenCalled();
  });
  it('migrates registry authorization and bypasses RegistryDO for later reads', async () => {
    const h = runtime();
    h.legacy.values.set('host:host-a', {
      id: 'host-a',
      name: 'retained',
      version: 2,
      disabled: false,
    });
    const registry = new RegistryDO(
      h.ctx as unknown as DurableObjectState,
      h.env,
    );
    expect(
      (
        await registry.fetch(
          new Request('https://internal/hosts', { method: 'POST', body: '{}' }),
        )
      ).status,
    ).toBe(200);
    expect([...h.legacy.values.keys()]).toEqual(['@d1Migrated']);
    h.env.REGISTRY = {
      get: () => {
        throw new Error('Read must not wake RegistryDO');
      },
    } as unknown as DurableObjectNamespace;
    expect(await registryCall(h.env, 'hosts')).toMatchObject([
      { id: 'host-a', name: 'retained' },
    ]);
    const rollback = new RegistryDO(h.ctx as unknown as DurableObjectState, {
      ...h.env,
      STATE_BACKEND: 'legacy',
    });
    expect(
      (
        await rollback.fetch(
          new Request('https://internal/hosts', { method: 'POST', body: '{}' }),
        )
      ).status,
    ).toBe(503);
    const wrongDatabase = database();
    const switched = new RegistryDO(h.ctx as unknown as DurableObjectState, {
      ...h.env,
      STATE_DB: wrongDatabase.binding(),
    });
    expect(
      (
        await switched.fetch(
          new Request('https://internal/hosts', { method: 'POST', body: '{}' }),
        )
      ).status,
    ).toBe(503);
    expect(
      await new D1State(wrongDatabase.binding(), 'registry').get('host:host-a'),
    ).toBeUndefined();
  });
  it('keeps the rollback guard through an interrupted legacy registry cleanup', async () => {
    const h = runtime();
    h.legacy.values.set('host:host-a', {
      id: 'host-a',
      version: 2,
      disabled: false,
    });
    const remove = vi
      .spyOn(h.legacy, 'delete')
      .mockRejectedValueOnce(new Error('Interrupted cleanup'));
    const first = new RegistryDO(h.ctx as unknown as DurableObjectState, h.env);
    const request = () =>
      new Request('https://internal/hosts', { method: 'POST', body: '{}' });
    expect((await first.fetch(request())).ok).toBe(false);
    expect(h.legacy.values.get('@d1Migrated')).toBe(true);
    expect(h.legacy.values.has('host:host-a')).toBe(true);
    expect(
      await new D1State(h.db.binding(), 'registry').get('@migrated'),
    ).toBeDefined();
    const rollback = new RegistryDO(h.ctx as unknown as DurableObjectState, {
      ...h.env,
      STATE_BACKEND: undefined,
    });
    expect((await rollback.fetch(request())).status).toBe(503);
    remove.mockRestore();
    const retry = new RegistryDO(h.ctx as unknown as DurableObjectState, h.env);
    expect((await retry.fetch(request())).status).toBe(200);
    expect([...h.legacy.values.keys()]).toEqual(['@d1Migrated']);
  });
  it('keeps active fencing reads and updates in native DO storage', async () => {
    const h = runtime();
    h.legacy.values.set('agentEpoch', 5);
    const relay = new HostRelayDO(
      h.ctx as unknown as DurableObjectState,
      h.env,
    ) as any;
    await relay.prepare('host-a');
    const prepare = vi.spyOn(h.db, 'prepare');
    for (let i = 0; i < 20; i++)
      expect(await relay.fence('agentEpoch')).toBe(5);
    expect(prepare).not.toHaveBeenCalled();
    await relay.storage.put('agentEpoch', 6);
    expect(await relay.fence('agentEpoch')).toBe(6);
  });
  it('retrieves split receipts offline, rejects other credentials and acknowledges only completed results', async () => {
    const h = runtime();
    const state = new D1State(h.db.binding(), 'host:host-a');
    const auth = { hash: 'original' } as Auth;
    const result = { state: 'completed', result: { value: 'retained' } };
    await state.put({
      '@migrated': true,
      'operation:receipt': {
        ...result,
        auth,
        expires: Date.now() + 10000,
        parts: 1,
        wire: 'request',
      },
      'part:receipt:0': JSON.stringify(result),
      'wire:request': 'receipt',
    });
    expect(
      await (await d1Receipt(h.env, 'host-a', 'receipt', auth, false))!.json(),
    ).toEqual(result);
    await expect(
      d1Receipt(h.env, 'host-a', 'receipt', { hash: 'other' } as Auth, true),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await state.get('operation:receipt')).toBeDefined();
    await d1Receipt(h.env, 'host-a', 'receipt', auth, true);
    expect(await state.get('operation:receipt')).toBeUndefined();
    expect(await state.get('part:receipt:0')).toBeUndefined();
    expect(await state.get('wire:request')).toBeUndefined();
  });
  it('polls a receipt while unrelated transport writes keep changing the scope', async () => {
    const h = runtime();
    const state = new D1State(h.db.binding(), 'host:busy');
    const auth = { hash: 'original' } as Auth;
    const result = { state: 'completed', result: { accepted: true } };
    await state.put({
      '@migrated': true,
      'operation:receipt': { ...result, auth, expires: Date.now() + 10000 },
    });
    const prepare = h.db.prepare.bind(h.db);
    vi.spyOn(h.db, 'prepare').mockImplementation((sql) => {
      h.db.sqlite.exec(
        "UPDATE relay_scopes SET revision = revision + 1 WHERE scope = 'host:busy'",
      );
      return prepare(sql);
    });
    expect(
      await (await d1Receipt(h.env, 'busy', 'receipt', auth, false))!.json(),
    ).toEqual(result);
    await expect(
      d1Receipt(h.env, 'busy', 'receipt', { hash: 'other' } as Auth, false),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('expires offline D1 receipts and tickets without touching DOs or resetting fencing', async () => {
    const h = runtime();
    const idle = new D1State(h.db.binding(), 'host:idle');
    const live = new D1State(h.db.binding(), 'host:live');
    const at = Date.now() - 1000;
    for (const [state, connected] of [
      [idle, 0],
      [live, 1],
    ] as const) {
      await state.put({
        presence: { connected },
        agentEpoch: 9,
        'operation:expired': { expires: at, parts: 1, wire: 'wire' },
        'part:expired:0': 'expired',
        'wire:wire': 'expired',
        [`due:${String(at).padStart(16, '0')}:operation:expired`]: {
          key: 'operation:expired',
          at,
        },
        'ticket:expired': { expires: at, epoch: 7, sessionId: 'session' },
        'lease:session': { epoch: 7, active: true },
        [`due:${String(at).padStart(16, '0')}:ticket:expired`]: {
          key: 'ticket:expired',
          at,
        },
      });
    }
    await collectIdleState(h.env);
    expect(await idle.get('operation:expired')).toBeUndefined();
    expect(await idle.get('part:expired:0')).toBeUndefined();
    expect(await idle.get('wire:wire')).toBeUndefined();
    expect(await idle.get('ticket:expired')).toBeUndefined();
    expect(await idle.get('lease:session')).toEqual({
      epoch: 7,
      active: false,
    });
    expect(await idle.get('agentEpoch')).toBe(9);
    expect(await live.get('operation:expired')).toBeDefined();
  });
});
