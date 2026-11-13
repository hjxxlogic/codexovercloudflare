import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const artifacts = process.env.COC_ARTIFACT_DIR || '.local/tool-presentation';
mkdirSync(artifacts, { recursive: true });
const server = await createServer({
  server: { host: '127.0.0.1', port: 0 },
  appType: 'custom',
});
server.middlewares.use((req, res, next) => {
  if (req.url !== '/tool-preview') return next();
  res.setHeader('Content-Type', 'text/html');
  res.end(
    `<html><style>:root{--bg:#f8fafc;--surface:#fff;--border:#dce1e7;--text:#18212f;--muted:#657184;--success:#16834a;--danger:#cb3344;--success-bg:#e9f7ee;--danger-bg:#ffeded;--focus:#467adb;--cw-surface:var(--surface);--cw-border:var(--border);--cw-muted:var(--muted)}</style><div id="root"></div><script type="module" src="/tests/helpers/tool-presentation-fixture.tsx"></script></html>`,
  );
});
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1100 },
  });
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().startsWith('https://')) external.push(request.url());
  });
  await page.goto(
    `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/tool-preview`,
  );
  const fixture = (fn: string) =>
    page.evaluate((name) => (window as any).toolFixture[name](), fn);
  await expect(page.locator('.tool-group')).toHaveCount(1);
  expect(
    await page.evaluate(() => (window as any).toolFixture.requests.length),
  ).toBe(0);
  await page.locator('.tool-group > summary').click();
  const file = page.locator('.tool-output[data-event-seq="1"]');
  const mcp = page.locator('.tool-output[data-event-seq="2"]');
  const command = page.locator('.tool-output[data-event-seq="3"]');
  for (const locator of [file, mcp, command])
    await locator.locator(':scope > summary').click();
  await expect(file.locator('.file-change')).toHaveCount(1);
  await file.locator('.file-change > summary').click();
  await expect(file.locator('.diff-add')).toContainText('+strea');
  await expect(file.locator('.tool-loading')).toBeVisible();
  await expect(mcp).toContainText('Streamed MCP');
  await expect(command).toContainText('building');
  await expect(mcp).not.toContainText('"item"');
  await page.screenshot({ path: `${artifacts}/stream-prefix.png` });
  await page.locator('.tool-group > summary').click();
  await page.waitForTimeout(250);
  const count = await page.evaluate(
    () => (window as any).toolFixture.requests.length,
  );
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(() => (window as any).toolFixture.requests.length),
  ).toBe(count);
  await page.locator('.tool-group > summary').click();
  await fixture('release');
  await expect(file).toContainText('+last line');
  await expect(file.locator('.file-change')).toHaveAttribute('open', '');
  await expect(mcp).toContainText('Complete');
  await expect(command).toContainText('{"success":true}');
  await expect(file.locator('.tool-loading')).toHaveCount(0);
  // Live notifications update an already expanded referenced MCP item and reasoning row.
  await fixture('notify');
  const reasoning = page.locator('.tool-output[data-event-seq="8"]');
  await reasoning.locator(':scope > summary').click();
  await expect(reasoning).toContainText('Live reasoning');
  await expect(mcp).toContainText('Live progress');
  await expect(page.locator('.tool-output')).toHaveCount(8);
  await page.evaluate(() => (window as any).toolFixture.revise(1));
  await expect(file).toContainText('revision TWO');
  await expect(file).not.toContainText('last line');
  await fixture('release');
  await expect(file.locator('.tool-loading')).toHaveCount(0);
  const settled = await page.evaluate(
    () => (window as any).toolFixture.requests.length,
  );
  await page.waitForTimeout(350);
  expect(
    await page.evaluate(() => (window as any).toolFixture.requests.length),
  ).toBe(settled);
  // Open all remaining tool types to verify layout and safe external content handling.
  for (const seq of [4, 5, 6, 7])
    await page
      .locator(`.tool-output[data-event-seq="${seq}"] > summary`)
      .click();
  await page.screenshot({
    path: `${artifacts}/desktop-light.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({
    path: `${artifacts}/mobile-light.png`,
    fullPage: true,
  });
  await page.addStyleTag({
    content:
      ':root{--bg:#11151c;--surface:#1b222d;--border:#354050;--text:#e5eaf0;--muted:#a3afc1;--success:#75d99d;--danger:#ff8b9d;--success-bg:#19382a;--danger-bg:#43232c}',
  });
  await page.screenshot({
    path: `${artifacts}/mobile-dark.png`,
    fullPage: true,
  });
  await file.locator('.file-change > summary').focus();
  await page.keyboard.press('Enter');
  await expect(file.locator('.file-change')).not.toHaveAttribute('open', '');
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  console.log(
    'PASS: partial file/MCP/command pages, pause/resume, live notifications, revision replacement, no idle polling, safe results, desktop/mobile themes, keyboard',
  );
} finally {
  await browser.close();
  await server.close();
}
