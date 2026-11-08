// Real IndexedDB regression checks using only an isolated browser and synthetic data.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import type { HistoryCache } from '../apps/web/src/history.ts';
import { browserCacheRecovery } from './helpers/browser-cache-recovery.ts';
// Bundle the actual module graph so new shared dependencies remain part of the fixture.
const bundle = await build({
  stdin: {
    contents: `import { HistoryCache } from './apps/web/src/history.ts';
import { HistorySubscription } from './apps/web/src/history-subscription.ts';
import { cacheLimits } from './apps/web/src/cache-budget.ts';
Object.assign(globalThis, { HistoryCache, HistorySubscription, cacheLimits });`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
});
const source = bundle.outputFiles[0].text;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route('https://cache.invalid/**', (route) =>
    route.fulfill({ body: '<html></html>', contentType: 'text/html' }),
  );
  await page.goto('https://cache.invalid/');
  await page.addScriptTag({
    content: source + '\nglobalThis.__name = (value) => value;',
  });
  // Another tab holding the previous schema must not strand network startup.
  const blocker = await context.newPage();
  await blocker.goto('https://cache.invalid/');
  await blocker.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('coc-history-v3', 1);
        request.onsuccess = () => {
          (globalThis as any).blockingDatabase = request.result;
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
  );
  const blocked = await page.evaluate(async () => {
    const Cache = (globalThis as any).HistoryCache as typeof HistoryCache;
    const cache = new Cache('blocked');
    const result = await Promise.race([
      cache.record('draft').then(
        () => 'unexpected success',
        () => 'unavailable',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ]);
    cache.close();
    return result;
  });
  assert.equal(
    blocked,
    'unavailable',
    'blocked IndexedDB fails promptly so the network can proceed',
  );
  await blocker.evaluate(() => (globalThis as any).blockingDatabase.close());
  await blocker.close();
  const fullPage = await context.newPage();
  await fullPage.route('https://full-cache.invalid/**', (route) =>
    route.fulfill({ body: '<html></html>', contentType: 'text/html' }),
  );
  await fullPage.goto('https://full-cache.invalid/');
  await fullPage.addScriptTag({ content: source });
  await fullPage.evaluate(async () => {
    const {
      HistoryCache: Cache,
      HistorySubscription: Subscription,
      cacheLimits: limits,
    } = globalThis as any;
    // Real transactions, with scaled quotas to reach both limits cheaply.
    limits.bytes = 32 * 1024;
    limits.scopeBytes = 16 * 1024;
    const caches = [
      new Cache('full:0'),
      new Cache('full:1'),
      new Cache('full:2'),
    ];
    for (const cache of caches) {
      for (let i = 0; i < 20; i++) {
        try {
          await cache.record('filler:' + i, 'x'.repeat(1024));
        } catch (error) {
          if (!String(error).includes('BACKPRESSURE')) throw error;
          break;
        }
      }
    }
    const cache = caches[0];
    await cache.record('draft', 'protected draft'.repeat(300));
    await cache.record('pending', {
      requestId: 'original',
      text: 'p'.repeat(2048),
    });
    await caches[2].record('workspace', {
      session: 'restorable',
      text: 'w'.repeat(2048),
    });
    const sent: any[] = [];
    const subscription = await Subscription.create(
      cache,
      'history-subscription:reader',
      () => {},
      () => {},
      (error: Error) => {
        throw error;
      },
    );
    await subscription.connect((frame: unknown) => sent.push(frame));
    const opening = sent[0];
    await subscription.handle({
      ...opening,
      type: 'history-window',
      agentInstance: 'agent',
      streamSerial: 1,
      creditGeneration: 'credit',
      receivedRevision: 0,
      maxRevision: 0,
    });
    let refused = false;
    try {
      await caches[2].record('more-history', 'x'.repeat(2048));
    } catch (error) {
      refused = String(error).includes('BACKPRESSURE');
    }
    if (!refused) throw new Error('History consumed recovery headroom');
    if (
      (await cache.record('pending')).requestId !== 'original' ||
      !(await cache.record('draft')).startsWith('protected')
    )
      throw new Error('Quota pressure lost drafts or originals');
    subscription.stop();
    for (const item of caches) item.close();
  });
  await fullPage.close();
  const gapPage = await context.newPage();
  await gapPage.route('https://gap-cache.invalid/**', (route) =>
    route.fulfill({ body: '<html></html>', contentType: 'text/html' }),
  );
  await gapPage.goto('https://gap-cache.invalid/');
  await gapPage.addScriptTag({
    content: source + '\nglobalThis.__name = (value) => value;',
  });
  const gapRecovery = await gapPage.evaluate(async () => {
    const Cache = (globalThis as any).HistoryCache;
    let cache = new Cache('gap-recovery');
    const event = (seq: number, text = 'body') => ({
      seq,
      revision: seq,
      type: 'user',
      data: { text },
    });
    const original = {
      ...event(1),
      contentReference: {
        seq: 1,
        revision: 1,
        recovery: { payload: 'saved credential', mac: 'a'.repeat(64) },
      },
    };
    await cache.writeSnapshot([original, event(9)], 9);
    await cache.record('draft', 'keep draft');
    await cache.record('history-subscription', { stream: 'keep identity' });
    await cache.record('delivery-outbox:test', {
      requestId: 'keep original request',
    });
    await cache.content(1, 0, 1, { text: 'expired cached body' });
    const snapshot = {
      events: [event(5)],
      more: false,
      cursor: 5,
      snapshotSeq: 5,
      direction: 'before',
      historyVersion: 2,
      snapshotGeneration: 1,
      retainedAfter: 4,
      gap: true,
    };
    await cache.writeSnapshot(snapshot.events, 5, 0, snapshot);
    cache.close();
    cache = new Cache('gap-recovery');
    const restored = await cache.latest();
    const preserved = [
      await cache.record('draft'),
      await cache.record('history-subscription'),
      await cache.record('delivery-outbox:test'),
    ];
    const expired = await cache.content(1, 0, 1);
    const archived = await cache.page(5);
    const reference = await cache.reference(1, 1);
    let failed = false;
    try {
      const huge = {
        ...snapshot,
        snapshotSeq: 10,
        snapshotGeneration: 2,
        events: [event(10, 'x'.repeat(17 * 1024 * 1024))],
      };
      await cache.writeSnapshot(huge.events, 10, 0, huge);
    } catch {
      failed = true;
    }
    cache.close();
    cache = new Cache('gap-recovery');
    const afterFailure = await cache.latest();
    let staleRejected = false;
    try {
      await cache.writeSnapshot([event(2)], 2, 0, {
        ...snapshot,
        snapshotGeneration: 0,
      });
    } catch {
      staleRejected = true;
    }
    const empty = {
      ...snapshot,
      events: [],
      snapshotSeq: 10,
      snapshotGeneration: 2,
      retainedAfter: 10,
    };
    await cache.writeSnapshot([], 10, 0, empty);
    const afterEmptySnapshot = await cache.recent();
    cache.close();
    return {
      restored,
      preserved,
      expired,
      archived,
      reference,
      failed,
      afterFailure,
      staleRejected,
      afterEmptySnapshot,
    };
  });
  assert.deepEqual(
    gapRecovery.restored.events.map((event: any) => event.seq),
    [5, 9],
  );
  assert.equal(
    gapRecovery.restored.checkpoint,
    9,
    'newer live checkpoint survives a gap snapshot',
  );
  assert.deepEqual(gapRecovery.preserved, [
    'keep draft',
    { stream: 'keep identity' },
    { requestId: 'keep original request' },
  ]);
  assert.deepEqual(gapRecovery.expired, { text: 'expired cached body' });
  assert.deepEqual(
    gapRecovery.archived?.events.map((event: any) => event.seq),
    [1],
  );
  assert.equal(gapRecovery.reference?.recovery.payload, 'saved credential');
  assert.deepEqual(
    gapRecovery.afterEmptySnapshot?.events.map((event: any) => event.seq),
    [1, 5, 9],
  );
  assert.equal(gapRecovery.failed, true);
  assert.deepEqual(
    gapRecovery.afterFailure,
    gapRecovery.restored,
    'failed replacement rolls back view and checkpoint',
  );
  assert.equal(gapRecovery.staleRejected, true);
  await gapPage.close();
  const committedReceipt = await page.evaluate(async () => {
    const cache = new (globalThis as any).HistoryCache('subscription-commit');
    await cache.latest();
    const frames: any[] = [],
      failures: string[] = [];
    const subscriber = await (globalThis as any).HistorySubscription.create(
      cache,
      'history-subscription',
      () => {},
      () => {},
      (error: Error) => failures.push(error.message),
    );
    cache.onCommit = () => subscriber.commit();
    await subscriber.connect((frame: unknown) => frames.push(frame));
    const opening = frames.at(-1);
    const response = {
      type: 'history-window',
      requestId: opening.requestId,
      stream: opening.stream,
      instance: opening.instance,
      exchangeId: opening.exchangeId,
      agentInstance: 'agent',
      streamSerial: 1,
      creditGeneration: 'credit',
      receivedRevision: 0,
      maxRevision: 7,
    };
    await subscriber.handle(response);
    const before = frames.length;
    await cache.writeSnapshot(
      [
        {
          seq: 7,
          revision: 7,
          time: 0,
          type: 'user',
          data: { text: 'committed' },
        },
      ],
      7,
    );
    await subscriber.commit();
    const receipt = frames.at(-1);
    const stored = await cache.latest();
    await subscriber.handle({
      ...response,
      requestId: receipt.requestId,
      receivedRevision: 7,
    });
    const saved = await cache.record('history-subscription');
    subscriber.stop();
    cache.close();
    return { before, receipt, checkpoint: stored.checkpoint, saved, failures };
  });
  assert.equal(
    committedReceipt.before,
    1,
    'Rendering a hint alone sends no history ACK',
  );
  assert.equal(committedReceipt.receipt.operation, 'ack');
  assert.equal(
    committedReceipt.receipt.receivedRevision,
    committedReceipt.checkpoint,
  );
  assert.equal(committedReceipt.saved.acknowledgedRevision, 7);
  assert.deepEqual(committedReceipt.failures, []);
  await page.evaluate(async () => {
    const cache = new (globalThis as any).HistoryCache('subscription-clear');
    await cache.latest();
    const frames: any[] = [],
      failures: string[] = [];
    const subscriber = await (globalThis as any).HistorySubscription.create(
      cache,
      'history-subscription',
      () => {},
      () => {},
      (error: Error) => failures.push(error.message),
    );
    await subscriber.connect((frame: unknown) => frames.push(frame));
    const opening = frames[0];
    const response = {
      ...opening,
      type: 'history-window',
      agentInstance: 'agent',
      streamSerial: 1,
      creditGeneration: 'credit',
      receivedRevision: 0,
      maxRevision: 7,
    };
    await subscriber.handle(response);
    (globalThis as any).clearRace = {
      cache,
      frames,
      failures,
      subscriber,
      response,
    };
  });
  const clearingTab = await context.newPage();
  await clearingTab.goto('https://cache.invalid/');
  await clearingTab.addScriptTag({ content: source });
  await clearingTab.evaluate(async () => {
    const cache = new (globalThis as any).HistoryCache('subscription-clear');
    await cache.clear();
    cache.close();
  });
  await clearingTab.close();
  const clearedReceipt = await page.evaluate(async () => {
    const { cache, frames, failures, subscriber, response } = (
      globalThis as any
    ).clearRace;
    await cache.writeSnapshot([], 7);
    await subscriber.commit();
    await subscriber.handle(response);
    const saved = await cache.record('history-subscription');
    subscriber.stop();
    cache.close();
    return { frames: frames.length, failures, saved };
  });
  assert.equal(
    clearedReceipt.frames,
    1,
    'A cleared reader must not send a stale ACK',
  );
  assert.equal(clearedReceipt.failures.length, 1);
  assert.equal(
    clearedReceipt.saved,
    undefined,
    'A delayed response cannot recreate a cleared reader',
  );
  const result = await page.evaluate(async () => {
    const Cache = (globalThis as any).HistoryCache as typeof HistoryCache;
    const transport = new Cache('transport');
    transport.writeLive(
      {
        seq: 1,
        revision: 10,
        time: 0,
        type: 'user',
        data: { text: 'received' },
      },
      () => {},
      10,
    );
    await transport.writeSnapshot([], 10);
    if (transport.durableRevision !== 10)
      throw new Error('Durable receive cursor was not published after commit');
    transport.close();
    const recovered = new Cache('transport');
    const atomic = await recovered.latest();
    if (atomic.checkpoint !== 10 || atomic.events[0]?.revision !== 10)
      throw new Error('Cursor committed ahead of its events');
    recovered.close();
    const own = new Cache('own'),
      other = new Cache('own:other');
    const event = (seq: number, revision = seq) => ({
      seq,
      revision,
      time: 0,
      type: 'user',
      data: { text: '你好'.repeat(40) },
    });
    const firstPage = {
      events: [event(1)],
      more: false,
      cursor: 1,
      snapshotSeq: 3000,
      direction: 'before' as const,
    };
    await own.write(
      Array.from({ length: 3000 }, (_, i) => event(i + 1)),
      3000,
      2,
      firstPage,
    );
    await other.write(
      Array.from({ length: 3000 }, (_, i) => event(i + 1)),
      3000,
      2,
      firstPage,
    );
    for (let i = 0; i < 520; i++)
      await own.content(1, i * 4096, 1, {
        text: 'cached',
        offset: i * 4096,
        revision: 1,
      });
    const oldest = await own.page(2);
    const body = await own.content(1, 0, 1);
    const draftA = own.saveDraft('older'),
      draftB = own.saveDraft('newer');
    await own.record('draft', 'confirmed');
    await Promise.all([draftA, draftB]);
    await own.record('pending', { requestId: 'keep' });
    const errors: string[] = [];
    let writes = 0;
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: any[]
    ) {
      if (args[1] === 'readwrite') writes++;
      return transaction.apply(this, args as any);
    } as typeof transaction;
    for (let i = 3001; i <= 4000; i++)
      own.writeLive(event(3000, i), (error) => errors.push(String(error)));
    own.writeLive(event(3000, 3500), (error) => errors.push(String(error)));
    const latest = await own.latest();
    const batchWrites = writes;
    IDBDatabase.prototype.transaction = transaction;
    own.close();
    const reopened = new Cache('own');
    const restored = await reopened.page(2);
    let visited = 0;
    const openCursor = IDBObjectStore.prototype.openCursor;
    IDBObjectStore.prototype.openCursor = function (...args) {
      const request = openCursor.apply(this, args);
      request.addEventListener('success', () => {
        if (request.result) visited++;
      });
      return request;
    };
    reopened.writeLive(event(9000), (error) => errors.push(String(error)));
    await reopened.record('delivery-outbox:tab', { pending: 'keep-command' });
    await reopened.clear();
    if (
      (await reopened.record('delivery-outbox:tab'))?.pending !== 'keep-command'
    )
      throw new Error('History clear discarded an unconfirmed command');
    IDBObjectStore.prototype.openCursor = openCursor;
    const afterClear = await reopened.latest();
    const preserved = await other.page(2);
    const draft = await reopened.record('draft');
    const pending = await reopened.record('pending');
    const remaining = await reopened.content(1, 0, 1);
    reopened.close();
    other.close();
    return {
      oldest,
      body,
      restored,
      revision: latest.events.at(-1)?.revision,
      batchWrites,
      visited,
      afterClear,
      preserved,
      draft,
      pending,
      remaining,
      errors,
    };
  });
  assert.equal(
    result.oldest?.events[0].seq,
    1,
    'older than 2000 events remains cached',
  );
  assert.equal(
    result.body.text,
    'cached',
    'older than 512 content chunks remains cached',
  );
  assert.equal(
    result.restored?.events[0].seq,
    1,
    'closed and reopened cache retains history',
  );
  assert.equal(
    result.revision,
    4000,
    'coalescing preserves the newest revision',
  );
  assert.equal(
    result.batchWrites,
    1,
    '1000 live revisions use one transaction',
  );
  assert.equal(result.visited, 3525, 'clear visits only own events and pages');
  assert.equal(
    result.afterClear.events.length,
    0,
    'pending live writes do not resurrect cleared history',
  );
  assert.equal(
    result.preserved?.events[0].seq,
    1,
    'prefix-adjacent scope is isolated',
  );
  assert.equal(
    result.draft,
    'confirmed',
    'explicit draft write supersedes delayed writes',
  );
  assert.equal(result.pending.requestId, 'keep');
  assert.equal(result.remaining, undefined);
  assert.deepEqual(result.errors, []);
  const secondTab = await context.newPage();
  await secondTab.goto('https://cache.invalid/');
  await secondTab.addScriptTag({ content: source });
  const updateShared = (tab: typeof page, start: number) =>
    tab.evaluate(async (start) => {
      const cache = new (globalThis as any).HistoryCache('own');
      await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          cache.updateRecord('delivery-outbox:tab', (previous: any) => ({
            ...previous,
            counter: (previous.counter ?? 0) + 1,
            originals: {
              ...previous.originals,
              [start + index]: 'saved-before-wire',
            },
          })),
        ),
      );
      cache.close();
    }, start);
  await Promise.all([updateShared(page, 0), updateShared(secondTab, 50)]);
  const atomic = await page.evaluate(async () => {
    const cache = new (globalThis as any).HistoryCache('own');
    const before = await cache.record('delivery-outbox:tab');
    let refused = false;
    try {
      await cache.updateRecord('delivery-outbox:tab', (previous: any) => {
        previous.counter = 999;
        throw new Error('Intent commit rejected');
      });
    } catch (error) {
      refused = String(error).includes('Intent commit rejected');
    }
    let oversized = false;
    try {
      await cache.updateRecord('delivery-outbox:tab', (previous: any) => ({
        ...previous,
        counter: 888,
        text: 'x'.repeat(32 * 1024 * 1024),
      }));
    } catch {
      oversized = true;
    }
    const after = await cache.record('delivery-outbox:tab');
    await cache.clear();
    const preserved = await cache.record('delivery-outbox:tab');
    cache.close();
    return { before, after, preserved, refused, oversized };
  });
  assert.equal(
    atomic.before.counter,
    100,
    'Two real tabs atomically update one original-intention journal',
  );
  assert.equal(
    Object.keys(atomic.before.originals).length,
    100,
    'No concurrent original is overwritten',
  );
  assert(atomic.refused && atomic.oversized);
  assert.deepEqual(
    atomic.after,
    atomic.before,
    'Failed intention updates roll back all changes',
  );
  assert.deepEqual(
    atomic.preserved,
    atomic.before,
    'Clearing history retains the original-intention journal',
  );
  const allocate = async (tab: typeof page, offset: number) =>
    tab.evaluate(async (offset) => {
      const Cache = (globalThis as any).HistoryCache as typeof HistoryCache;
      return Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          const cache = new Cache(`quota:${offset + i}`);
          try {
            await cache.record('delivery-outbox-v2:tab', {
              pending: offset + i,
            });
            return true;
          } catch (error) {
            if (!String(error).includes('BACKPRESSURE')) throw error;
            return false;
          } finally {
            cache.close();
          }
        }),
      );
    }, offset);
  const allocations = (
    await Promise.all([allocate(page, 0), allocate(secondTab, 10)])
  ).flat();
  assert.equal(
    allocations.filter(Boolean).length,
    15,
    'Two tabs share 16 total command reservations, including the preserved original outbox',
  );
  const quota = await page.evaluate(async () => {
    const Cache = (globalThis as any).HistoryCache as typeof HistoryCache;
    const cache = new Cache('cache-quota');
    const text = 'x'.repeat(3 * 1024 * 1024);
    for (let i = 0; i < 5; i++) await cache.record(`large:${i}`, text);
    let refused = false;
    try {
      await cache.record('large:5', text);
    } catch (error) {
      refused = String(error).includes('BACKPRESSURE');
    }
    if (!refused || (await cache.record('large:5')) !== undefined)
      throw new Error('A rejected cache write escaped its scope quota');
    let checkpointRefused = false;
    try {
      await cache.writeSnapshot(
        [
          {
            seq: 1,
            revision: 90,
            time: 0,
            type: 'user',
            data: { text: text.slice(0, 2 * 1024 * 1024) },
          },
        ],
        90,
      );
    } catch (error) {
      checkpointRefused = String(error).includes('BACKPRESSURE');
    }
    const missing = await cache.latest();
    if (
      !checkpointRefused ||
      missing.events.length ||
      missing.checkpoint !== undefined
    )
      throw new Error(
        'A failed global cache transaction advanced its cursor or committed a partial event',
      );
    await cache.clear();
    // Reliable reservations survive ordinary history clearing and reconnect.
    const original = new Cache('own');
    if (
      (await original.record('delivery-outbox:tab'))?.pending !== 'keep-command'
    )
      throw new Error('Command exhaustion discarded the old pending request');
    await original.record('draft', 'ordinary cache remains independent');
    const extra = new Cache('quota:extra');
    let commandRefused = false;
    try {
      await extra.record('delivery-outbox-v2:tab', {});
    } catch (error) {
      commandRefused = String(error).includes('BACKPRESSURE');
    }
    let globalRefused = false;
    const created: InstanceType<typeof Cache>[] = [];
    for (let scope = 0; scope < 8 && !globalRefused; scope++) {
      const more = new Cache(`global-cache:${scope}`);
      created.push(more);
      for (let i = 0; i < 5; i++) {
        try {
          await more.record(`large:${i}`, text);
        } catch (error) {
          if (!String(error).includes('BACKPRESSURE')) throw error;
          globalRefused = true;
          break;
        }
      }
    }
    for (const item of [cache, original, extra, ...created]) item.close();
    return { commandRefused, globalRefused };
  });
  assert(
    quota.commandRefused,
    'Closing tabs and clearing history does not revoke an outstanding reservation',
  );
  assert(
    quota.globalRefused,
    'Many cache scopes cannot multiply the global cache quota',
  );
  await secondTab.close();
  await browserCacheRecovery(context, source);
  console.log(
    'PASS: persistent history/content, atomic cursors, independent cache/command quotas across real tabs, preserved reservations, batching and scoped clear',
  );
  await context.close();
} finally {
  await browser.close();
}
