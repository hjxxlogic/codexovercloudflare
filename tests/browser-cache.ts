// Real IndexedDB regression checks using only an isolated browser and synthetic data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import ts from 'typescript';
import type { HistoryCache } from '../apps/web/src/history.ts';
const source =
  ['events.ts', 'history.ts']
    .map((file) =>
      ts
        .transpileModule(readFileSync(`apps/web/src/${file}`, 'utf8'), {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ES2022,
          },
        })
        .outputText.replace(/^import .* from ['"]\.\/events\.ts['"];?$/m, '')
        .replaceAll('export ', ''),
    )
    .join('\n') + '\nglobalThis.HistoryCache = HistoryCache;';
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('http://cache.invalid/**', (route) =>
    route.fulfill({ body: '<html></html>', contentType: 'text/html' }),
  );
  await page.goto('http://cache.invalid/');
  await page.addScriptTag({
    content: source + '\nglobalThis.__name = (value) => value;',
  });
  const result = await page.evaluate(async () => {
    const Cache = (globalThis as any).HistoryCache as typeof HistoryCache;
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
    await reopened.clear();
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
  assert.equal(result.visited, 3524, 'clear visits only own events and pages');
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
  console.log(
    'PASS: persistent full history, local content, scope isolation, batched revision writes, draft flush and clear',
  );
  await context.close();
} finally {
  await browser.close();
}
