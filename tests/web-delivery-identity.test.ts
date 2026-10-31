import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it('keeps reload identity but separates a duplicated tab that inherited sessionStorage', async () => {
  const values = new Map<string, string>();
  const held = new Set<string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal('navigator', {
    locks: {
      request: async (
        name: string,
        _options: unknown,
        callback: (lock: unknown) => Promise<void>,
      ) => {
        const free = !held.has(name);
        if (free) held.add(name);
        await callback(free ? {} : null);
      },
    },
  });
  const first = await (
    await import('../apps/web/src/delivery-identity.ts')
  ).deliveryIdentity();
  vi.resetModules();
  const copied = await (
    await import('../apps/web/src/delivery-identity.ts')
  ).deliveryIdentity();
  expect(copied).not.toBe(first);
  held.delete('coc-delivery-tab:' + copied);
  vi.resetModules();
  expect(
    await (
      await import('../apps/web/src/delivery-identity.ts')
    ).deliveryIdentity(),
  ).toBe(copied);
});
