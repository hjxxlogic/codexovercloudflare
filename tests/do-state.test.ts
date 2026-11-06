import { describe, expect, it, vi } from 'vitest';
import { listAll } from '../apps/relay/src/state.ts';
import { expireAt, nextExpiry, dueEntries } from '../apps/relay/src/expiry.ts';
import { MemoryStorage } from './helpers/do-state.ts';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
import { RegistryDO } from '../apps/relay/src/registry.ts';
import { HostRelayDO } from '../apps/relay/src/host.ts';

describe('DO native storage', () => {
  it('reads complete directories across pages while respecting bounds', async () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < 600; i++)
      await storage.put('host:' + String(i).padStart(4, '0'), { id: i });
    await storage.put('other:0000', {});
    expect((await listAll(storage, { prefix: 'host:' })).size).toBe(600);
    const bounded = await listAll(storage, {
      prefix: 'host:',
      startAfter: 'host:0009',
      end: 'host:0590',
    });
    expect(bounded.size).toBe(580);
    expect([...bounded.keys()][0]).toBe('host:0010');
    expect([...bounded.keys()].at(-1)).toBe('host:0589');
  });

  it('restores finite expiry scheduling and drains bounded pages without a periodic alarm', async () => {
    const storage = new MemoryStorage();
    const at = Date.now() - 1000;
    for (let i = 0; i < 130; i++) await expireAt(storage, 'ticket:' + i, at);
    await storage.deleteAlarm();
    await nextExpiry(storage);
    expect(storage.alarm).not.toBeNull();
    for (const count of [64, 64, 2]) {
      const due = await dueEntries(storage);
      expect(due.size).toBe(count);
      await storage.delete([...due.keys()]);
      await nextExpiry(storage);
    }
    expect(storage.alarm).toBeNull();
    await expireAt(storage, 'auth:permanent', Number.MAX_SAFE_INTEGER);
    expect(storage.alarm).toBeNull();
  });

  it('preserves authorization but clears obsolete cloud business state on encrypted migration', async () => {
    const registryStorage = new MemoryStorage();
    const hostStorage = new MemoryStorage();
    const host = { id: 'host', name: 'test', version: 2, disabled: false };
    const auth = {
      hash: 'credential',
      role: 'agent',
      hostId: 'host',
      version: 2,
      expires: Number.MAX_SAFE_INTEGER,
      created: 0,
      lastSeen: Date.now(),
    };
    await registryStorage.put({
      '@doState': { version: 1 },
      'host:host': host,
      'auth:credential': auth,
    });
    const resident = {
      '@doState': { version: 1 },
      agentEpoch: 42,
      'lease:host~session': { epoch: 41, active: false },
      'permission-operation:receipt': {
        state: 'completed',
        result: { epoch: 41 },
      },
    };
    await hostStorage.put(resident);
    const env = { OWNER_SECRET: 'x'.repeat(64) } as never;
    for (let attempt = 0; attempt < 2; attempt++) {
      const registry = new RegistryDO(
        {
          storage: registryStorage,
          getWebSockets: () => [],
        } as unknown as DurableObjectState,
        env,
      );
      const relay = new HostRelayDO(
        {
          storage: hostStorage,
          getWebSockets: () => [],
        } as unknown as DurableObjectState,
        env,
      );
      const response = await registry.fetch(
        new Request('https://internal/authHash', {
          method: 'POST',
          body: JSON.stringify({ hash: auth.hash }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject(auth);
      expect(
        (await relay.fetch(new Request('https://internal/status'))).status,
      ).toBe(200);
      await relay.alarm();
      expect(await hostStorage.get('channelVersion')).toBe(1);
      for (const [key, value] of Object.entries(resident)) {
        expect(await hostStorage.get(key)).toBeUndefined();
        expect(await hostStorage.get('~opaque-v1:backup:' + key)).toEqual(
          value,
        );
      }
      expect(hostStorage.alarm).toBeNull();
    }
  });
});
