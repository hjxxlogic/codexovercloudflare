// Real Web Locks, BroadcastChannel and IndexedDB; isolated synthetic receiver.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
const bundle = await build({
  stdin: {
    contents: `import { OperationClient } from './apps/web/src/operations.ts';
import { HistoryCache } from './apps/web/src/history.ts';
Object.assign(globalThis, { OperationClient, HistoryCache });`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
});
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  let effects = 0,
    probes = 0,
    queryLoss = false,
    ackLoss = false;
  const originals = new Map<string, unknown>();
  const wires: { id: string; ack: boolean }[] = [];
  await context.route('https://operations.invalid/**', async (route) => {
    if (new URL(route.request().url()).pathname !== '/wire') {
      await route.fulfill({ contentType: 'text/html', body: '<html></html>' });
      return;
    }
    const { id, ack, probe, body } = route.request().postDataJSON();
    if (probe) {
      probes++;
      await route.fulfill({
        json: {
          deliveryInstance: 'agent-store',
          operationInstance: 'agent-store',
        },
      });
      return;
    }
    wires.push({ id, ack });
    if (!ack && !originals.has(id)) {
      effects++;
      originals.set(id, { id: 'host~' + id, projectId: body.projectId });
    }
    if ((!ack && queryLoss) || (ack && ackLoss)) {
      queryLoss = ackLoss = false;
      await route.fulfill({ status: 503, json: { lost: true } });
      return;
    }
    await route.fulfill({
      json: ack ? { confirmed: true } : originals.get(id),
    });
  });
  async function tab() {
    const page = await context.newPage();
    await page.goto('https://operations.invalid/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      const g = globalThis as any;
      g.__name = (value: unknown) => value;
      g.cache = new g.HistoryCache('same-owner-and-host');
      const owner = 'a'.repeat(64);
      g.client = new g.OperationClient(g.cache, {
        host: 'host',
        owner,
        request: async (
          path: string,
          body: any,
          _signal: AbortSignal,
          id: string,
          _headers: unknown,
          exchange: any,
        ) => {
          if (exchange) {
            const stored = await g.cache.record('delivery-outbox-http:v2');
            const original = stored.records[id];
            if (
              !original ||
              original.instance !== exchange.instance ||
              JSON.stringify(original.body) !== JSON.stringify(body) ||
              (exchange.ack && !original.result)
            )
              throw new Error('Wire preceded durable intent or result');
          }
          const response = await fetch('/wire', {
            method: 'POST',
            body: JSON.stringify({
              probe: path.endsWith('/probe'),
              id,
              ack: !!exchange?.ack,
              body,
            }),
          });
          if (!response.ok) throw new TypeError('Synthetic lost response');
          const data = await response.json();
          if (exchange)
            await exchange.commit(
              { data },
              {
                owner,
                requestId: id,
                instance: 'agent-store',
                ...(exchange.ack ? { ack: true } : {}),
              },
            );
          return data;
        },
      });
    });
    return page;
  }
  const first = await tab(),
    second = await tab();
  const results = await Promise.all(
    [first, second].map((page) =>
      page.evaluate(() =>
        (globalThis as any).client.submit(
          '/sessions',
          { projectId: 'project' },
          'shared-original',
        ),
      ),
    ),
  );
  assert.deepEqual(results, [
    { id: 'host~shared-original', projectId: 'project' },
    { id: 'host~shared-original', projectId: 'project' },
  ]);
  await expect
    .poll(() =>
      second.evaluate(
        async () => (await (globalThis as any).client.records())[0].state,
      ),
    )
    .toBe('confirmed');
  assert.equal(effects, 1);
  assert.deepEqual(wires, [
    { id: 'shared-original', ack: false },
    { id: 'shared-original', ack: true },
  ]);
  assert.equal(probes, 1);

  // A closed page retains the fixed instance, body and original identity.
  queryLoss = true;
  await first.evaluate(() => {
    void (globalThis as any).client
      .submit('/sessions', { projectId: 'project' }, 'closed-page')
      .catch(() => {});
  });
  await expect
    .poll(() => wires.some((wire) => wire.id === 'closed-page'))
    .toBe(true);
  await first.close();
  ackLoss = true;
  const resumed = await second.evaluate(() =>
    (globalThis as any).client.resume('closed-page'),
  );
  assert.equal(resumed.id, 'host~closed-page');
  await expect
    .poll(
      () =>
        second.evaluate(
          async () =>
            (await (globalThis as any).client.records()).find(
              (r: any) => r.requestId === 'closed-page',
            ).state,
        ),
      { timeout: 10000 },
    )
    .toBe('confirmed');
  assert.equal(effects, 2);
  assert.equal(probes, 2);
  assert(
    wires.filter((wire) => wire.id === 'closed-page' && !wire.ack).length <= 2,
  );
  const count = wires.length;
  await second.waitForTimeout(1100);
  assert.equal(wires.length, count, 'No idle recovery polling');
  await second.evaluate(async () => {
    const g = globalThis as any;
    await g.cache.clear();
    const records = await g.client.records();
    if (
      records.length !== 2 ||
      records.some((r: any) => r.state !== 'confirmed')
    )
      throw new Error('Clearing cache erased refusal identities');
    g.client.stop();
    g.cache.close();
  });
  console.log(
    'PASS browser operation locks, durable ordering, page closure, lost ACK, idle stop and cache clearing',
  );
} finally {
  await browser.close();
}
