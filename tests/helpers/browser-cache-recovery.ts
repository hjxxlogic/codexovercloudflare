import assert from 'node:assert/strict';
import type { BrowserContext } from '@playwright/test';

export async function browserCacheRecovery(
  context: BrowserContext,
  source: string,
) {
  const origin = 'https://cache-recovery.invalid/';
  await context.route(origin + '**', (route) =>
    route.fulfill({ body: '<html></html>', contentType: 'text/html' }),
  );
  const pages = await Promise.all([context.newPage(), context.newPage()]);
  for (const page of pages) {
    await page.goto(origin);
    await page.addScriptTag({
      content: source + '\nglobalThis.__name = (value) => value;',
    });
  }
  const legacy = await pages[0].evaluate(async () => {
    const Cache = (globalThis as any).HistoryCache;
    const idle = () => ({
      version: 2,
      stream: 'saved-stream',
      control: { controlId: 'saved-control' },
      normal: { entries: [], results: { buffer: {}, cache: [] } },
      priority: { entries: [], results: { buffer: {}, cache: [] } },
    });
    for (let i = 0; i < 16; i++) {
      const cache = new Cache('old:' + i);
      const value: any = idle();
      if (i === 0)
        value.normal.entries.push({
          seq: 1,
          body: 'original-must-survive',
          end: 26,
        });
      if (i === 1)
        await cache.record('delivery-outbox-http:v2', {
          version: 2,
          order: ['done'],
          records: {
            done: { state: 'confirmed', requestId: 'keep-http-identity' },
          },
        });
      else if (i === 2)
        await cache.record('delivery-outbox-upload:v2', {
          version: 2,
          records: [{ phase: 'completed', id: 'keep-upload-identity' }],
        });
      else await cache.record('delivery-outbox-v2:tab', value);
      cache.close();
    }
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('coc-history-v3');
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pages', 'readwrite');
      const key = ['$coc-transport2-budget', 'ledger'];
      const request = tx.objectStore('pages').get(key);
      request.onsuccess = () => {
        const ledger = request.result;
        for (const key of Object.keys(ledger.commands))
          ledger.commands[key] = 32 * 1024 * 1024;
        delete ledger.commandAccounting;
        tx.objectStore('pages').put(ledger, key);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return 16;
  });
  assert.equal(legacy, 16);
  await Promise.all(
    pages.map((page, tab) =>
      page.evaluate(async (tab) => {
        const Cache = (globalThis as any).HistoryCache;
        for (let i = 0; i < 25; i++) {
          const cache = new Cache(`idle:${tab}:${i}`);
          await cache.record('delivery-outbox-v2:tab', {
            version: 2,
            stream: `stream:${tab}:${i}`,
            control: { controlId: 'retained' },
            normal: {
              entries: [],
              results: { buffer: {}, cache: [{ body: 'completed reply' }] },
            },
            priority: { entries: [], results: { buffer: {}, cache: [] } },
          });
          cache.close();
        }
      }, tab),
    ),
  );
  const recovered = await pages[0].evaluate(async () => {
    const Cache = (globalThis as any).HistoryCache;
    const cache = new Cache('old:0');
    const before = await cache.record('delivery-outbox-v2:tab');
    await cache.clear();
    const afterClear = await cache.record('delivery-outbox-v2:tab');
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('coc-history-v3');
      request.onsuccess = () => resolve(request.result);
    });
    const ledger: any = await new Promise((resolve) => {
      const request = db
        .transaction('pages')
        .objectStore('pages')
        .get(['$coc-transport2-budget', 'ledger']);
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    const complete = structuredClone(before);
    complete.normal.entries = [];
    complete.normal.results.cache.push({ body: 'verified completed response' });
    await cache.record('delivery-outbox-v2:tab', complete);
    cache.close();
    for (const [scope, key, id] of [
      ['old:1', 'delivery-outbox-http:v2', 'keep-http-identity'],
      ['old:2', 'delivery-outbox-upload:v2', 'keep-upload-identity'],
    ]) {
      const preserved = new Cache(scope);
      if (!JSON.stringify(await preserved.record(key)).includes(id))
        throw new Error('Terminal original identity lost during migration');
      preserved.close();
    }
    return {
      before,
      afterClear,
      count: Object.keys(ledger.commands).length,
      reserved: Object.values(ledger.commands).reduce(
        (a: number, b: any) => a + b,
        0,
      ),
    };
  });
  assert.equal(recovered.count, 66);
  assert(recovered.reserved < 34 * 1024 * 1024);
  assert.deepEqual(recovered.before, recovered.afterClear);
  assert.equal(
    recovered.before.normal.entries[0].body,
    'original-must-survive',
  );
  const allocated = (
    await Promise.all(
      pages.map((page, tab) =>
        page.evaluate(async (tab) => {
          const Cache = (globalThis as any).HistoryCache;
          return Promise.all(
            Array.from({ length: 10 }, async (_, i) => {
              const scope = `pending:${tab}:${i}`;
              const cache = new Cache(scope);
              try {
                await cache.record('delivery-outbox-v2:tab', {
                  version: 2,
                  stream: scope,
                  normal: {
                    entries: [{ seq: 1, end: 10, body: 'fixed-original' }],
                    results: { buffer: {}, cache: [] },
                  },
                  priority: { entries: [], results: { buffer: {}, cache: [] } },
                });
                return { scope, accepted: true };
              } catch (error) {
                if (!String(error).includes('BACKPRESSURE')) throw error;
                return { scope, accepted: false };
              } finally {
                cache.close();
              }
            }),
          );
        }, tab),
      ),
    )
  ).flat();
  assert.equal(allocated.filter((row) => row.accepted).length, 15);
  await pages[1].evaluate(
    async (scope) => {
      const Cache = (globalThis as any).HistoryCache;
      const cache = new Cache(scope);
      const state = await cache.record('delivery-outbox-v2:tab');
      if (state.normal.entries[0].body !== 'fixed-original')
        throw new Error('Original changed');
      state.normal.entries = [];
      await cache.record('delivery-outbox-v2:tab', state);
      cache.close();
      const next = new Cache('pending:after-completion');
      state.normal.entries = [{ seq: 1, end: 10, body: 'next-original' }];
      await next.record('delivery-outbox-v2:tab', state);
      next.close();
    },
    allocated.find((row) => row.accepted)!.scope,
  );
  const evicted = await pages[0].evaluate(async () => {
    const Cache = (globalThis as any).HistoryCache;
    const cache = new Cache('eviction');
    const body = { text: 'x'.repeat(3 * 1024 * 1024) };
    await cache.record('draft', 'keep-draft');
    await cache.record('pending', { requestId: 'keep-pending' });
    await cache.record('history-subscription', { stream: 'keep-proof' });
    const events = [
      {
        seq: 1,
        revision: 1,
        type: 'user',
        time: 0,
        data: { text: 'keep-event' },
      },
    ];
    await cache.writeSnapshot(events, 1, 0, {
      events,
      snapshotSeq: 1,
      more: false,
      cursor: 1,
      direction: 'before',
    });
    for (let i = 0; i < 6; i++) await cache.content(1, i, 1, body);
    const firstMissing = (await cache.content(1, 0, 1)) === undefined;
    const latestPresent = !!(await cache.content(1, 5, 1));
    const pageMissing = (await cache.page(0)) === undefined;
    for (let scope = 0; scope < 4; scope++) {
      const more = new Cache('global-eviction:' + scope);
      for (let i = 0; i < 5; i++) await more.content(1, i, 1, body);
      more.close();
    }
    const locked = new Cache('protected-capacity');
    for (let i = 0; i < 5; i++) await locked.record(`protected:${i}`, body);
    const witness = new Cache('global-eviction:3');
    const beforeFailure = (await witness.content(1, 4, 1))?.text.length;
    let refused = false;
    try {
      await locked.record('protected:overflow', {
        text: 'y'.repeat(2 * 1024 * 1024),
      });
    } catch (error) {
      refused = String(error).includes('BACKPRESSURE');
    }
    const afterFailure = (await witness.content(1, 4, 1))?.text.length;
    if (!refused || !beforeFailure || beforeFailure !== afterFailure)
      throw new Error(
        'A failed admission did not roll back disposable cache reclamation',
      );
    locked.close();
    witness.close();
    const protectedValues = [
      await cache.record('draft'),
      await cache.record('pending'),
      await cache.record('history-subscription'),
      await cache.latest(),
    ];
    cache.close();
    return { firstMissing, latestPresent, pageMissing, protectedValues };
  });
  assert(evicted.firstMissing && evicted.latestPresent && evicted.pageMissing);
  assert.deepEqual(evicted.protectedValues.slice(0, 3), [
    'keep-draft',
    { requestId: 'keep-pending' },
    { stream: 'keep-proof' },
  ]);
  assert.equal(evicted.protectedValues[3].checkpoint, 1);
  assert.equal(evicted.protectedValues[3].events[0].data.text, 'keep-event');
  await Promise.all(pages.map((page) => page.close()));
  console.log(
    'PASS: old fixed reservations migrate across two tabs; 66 idle journals, pending admission/release and scoped/global disposable cache reclamation preserve originals and checkpoints',
  );
}
