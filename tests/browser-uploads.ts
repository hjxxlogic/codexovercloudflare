// Real IndexedDB capacity and page restart; no business request is sent.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
const bundle = await build({
  stdin: {
    contents: `import { HistoryCache } from './apps/web/src/history.ts';
import { OperationClient } from './apps/web/src/operations.ts';
import { prepareUpload, uploadRecords } from './apps/web/src/uploads.ts';
Object.assign(globalThis, { HistoryCache, OperationClient, prepareUpload, uploadRecords });`,
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
  const page = await context.newPage();
  await context.route('https://uploads.invalid/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html></html>',
    }),
  );
  async function open() {
    await page.goto('https://uploads.invalid/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      const g = globalThis as any;
      g.__name = (value: unknown) => value;
      g.cache = new g.HistoryCache('upload-owner-and-host');
      g.client = new g.OperationClient(g.cache, {
        owner: 'a'.repeat(64),
        host: 'host',
        request: () => {
          throw new Error('Admission sent a business request');
        },
      });
    });
  }
  await open();
  const original = await page.evaluate(async () => {
    const g = globalThis as any;
    const bytes = new Uint8Array(20 * 1024 * 1024).fill(197);
    const id = await g.prepareUpload(
      g.cache,
      g.client,
      new Blob([bytes]),
      {
        host: 'host',
        project: 'project',
        path: 'capacity.bin',
        overwrite: false,
      },
      new AbortController().signal,
    );
    const record = (await g.uploadRecords(g.cache))[0];
    return {
      id,
      sha256: record.sha256,
      size: record.size,
      chunks: record.chunks.length,
    };
  });
  assert.equal(original.size, 20 * 1024 * 1024);
  assert.equal(original.chunks, 320);
  // A page restart must retain the full original, independently of ordinary cache clear.
  await open();
  const recovered = await page.evaluate(async () => {
    const g = globalThis as any;
    await g.cache.clear();
    const record = (await g.uploadRecords(g.cache))[0];
    const bytes = new Uint8Array(record.size);
    record.chunks.forEach((chunk: string, index: number) => {
      const binary = atob(chunk);
      for (let i = 0; i < binary.length; i++)
        bytes[index * 65536 + i] = binary.charCodeAt(i);
    });
    const sha256 = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    ]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    let refused = false;
    try {
      await g.prepareUpload(
        g.cache,
        g.client,
        new Blob(['second']),
        {
          host: 'host',
          project: 'project',
          path: 'second.bin',
          overwrite: false,
        },
        new AbortController().signal,
      );
    } catch (error) {
      refused = (error as any).code === 'BACKPRESSURE';
    }
    g.client.stop();
    g.cache.close();
    return {
      id: record.id,
      size: bytes.length,
      sha256,
      refused,
      phase: record.phase,
    };
  });
  assert.equal(recovered.id, original.id);
  assert.equal(recovered.sha256, original.sha256);
  assert.equal(recovered.size, original.size);
  assert.equal(recovered.phase, 'queued');
  assert(
    recovered.refused,
    'A second file must not consume the original body reservation',
  );
  await context.close();
  console.log(
    'PASS: full 20 MiB upload admission, real IndexedDB restart, checksum, clear isolation and pending-file backpressure',
  );
} finally {
  await browser.close();
}
