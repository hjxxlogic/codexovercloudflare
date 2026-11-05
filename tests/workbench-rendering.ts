import { WebSocketServer } from 'ws';
import { encryptedFixture } from './helpers/encrypted-fixture.ts';
// Isolated built-web rendering checks. No production credentials or model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { chromium, expect, type Locator } from '@playwright/test';
const source = `# 高级 Markdown\n\n[跳转](#高级-markdown)\n\n> [!WARNING]\n> 注意事项\n\n正文脚注[^note]，价格 $100，代码 \`$x$\`。\n\n[^note]: 脚注正文\n\n## 表格\n\n| 左 | 右 |\n| :--- | ---: |\n| A | B |\n\n## 公式\n\n$$\n\\frac{a}{b} + \\sqrt{x}\n$$\n\n行内 $x^2$。\n\n\`\`\`mermaid\nflowchart LR\n  A[开始] --> B[结束]\n\`\`\`\n\n:::details 展开说明\n\n隐藏正文\n\n:::\n\n<script>window.unsafeMarkdown=true</script>\n[bad](javascript:alert(1))\n![remote](https://untrusted.invalid/pixel.png)\n`;
const openAiSource = String.raw`

\[
L(b)=\ln\frac{P(b=0\mid y)}{P(b=1\mid y)}
\] 本次没有覆盖的位置取 \(L_{i,\mathrm{new}}^{(t)}=0\)。

\[
B_{\mathrm{total}}
=
7\times 8
=
56
\] 后续 **正文** 与 \(B_{\mathrm{total}}\)。

\[
\begin{aligned}
x_1&=1\\[4pt]
x_2&=2
\end{aligned}
\]
`;
const oversized =
  '\n\n| ' +
  Array.from({ length: 45 }, (_, i) => 'Column' + i).join(' | ') +
  ' |\n| ' +
  Array(45).fill('---').join(' | ') +
  ' |\n| ' +
  Array(45).fill('Wide cell').join(' | ') +
  ' |\n\n```text\n' +
  Array(60).fill('A long output line').join('\n') +
  '\n```\n\n```mermaid\nflowchart LR\n' +
  Array.from(
    { length: 18 },
    (_, i) => `N${i}[Node ${i}] --> N${i + 1}[Node ${i + 1}]`,
  ).join('\n') +
  '\n```\n\n```mermaid\ninvalid diagram syntax\n```\n\n```math\n' +
  Array.from({ length: 60 }, (_, i) => `x_{${i}}`).join('+') +
  '\n```\n';
const bytes = Buffer.from(source + openAiSource + oversized);
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  if (url.pathname.startsWith('/api/v1/')) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-CoC-Demand', '1');
    res.setHeader('X-CoC-Delivery', '2');
    if (url.pathname.endsWith('/auth/email')) {
      res.end(JSON.stringify({ enabled: false }));
      return;
    }
    let raw = '';
    for await (const part of req) raw += part;
    const data = JSON.parse(raw || '{}');
    const chunk = bytes.subarray(data.offset || 0, (data.offset || 0) + 65536);
    res.end(
      JSON.stringify({
        data: chunk.toString('base64'),
        size: bytes.length,
        offset: (data.offset || 0) + chunk.length,
        version: 'v1',
      }),
    );
    return;
  }
  if (url.pathname === '/diagram.html' || url.pathname === '/diagram')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts",
    );
  else
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  const root = resolve('dist/web');
  const file = resolve(
    root,
    '.' +
      (url.pathname === '/'
        ? '/index.html'
        : url.pathname === '/diagram'
          ? '/diagram.html'
          : url.pathname),
  );
  if (!file.startsWith(root + '/')) {
    res.writeHead(403).end();
    return;
  }
  try {
    res.setHeader(
      'Content-Type',
      (
        {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.woff2': 'font/woff2',
          '.woff': 'font/woff',
        } as Record<string, string>
      )[extname(file)] || 'application/octet-stream',
    );
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
const endpoints = new WebSocketServer({ server });
endpoints.on('connection', (ws, req) => encryptedFixture(ws, req));
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ headless: true });
const artifacts = '.local/workbench-evidence';
mkdirSync(artifacts, { recursive: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const external: string[] = [];
  page.on('request', (req) => {
    if (
      !req.url().startsWith(`http://127.0.0.1:${port}`) &&
      !req.url().startsWith('data:')
    )
      external.push(req.url());
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(
    `http://127.0.0.1:${port}/#preview=file&host=host&project=project&path=report.md`,
  );
  await expect(
    page.getByRole('heading', { name: '高级 Markdown' }),
  ).toBeVisible();
  await expect(page.locator('.callout-warning')).toContainText('注意事项');
  await expect(page.locator('table')).toHaveCount(2);
  async function enterElementFullscreen(element: Locator) {
    await element.getByRole('button', { name: '全屏', exact: true }).click();
    await expect(element).toHaveClass(/element-fullscreen/);
    const bounds = (await element.boundingBox())!;
    const viewport = page.viewportSize()!;
    assert.equal(bounds.x, 0);
    assert.equal(bounds.y, 0);
    assert.equal(bounds.width, viewport.width);
    assert.equal(bounds.height, viewport.height);
    await expect(
      element.getByRole('button', { name: '退出全屏', exact: true }),
    ).toBeFocused();
  }
  const smallTable = page.locator('.table-scroll').first();
  await expect(
    smallTable.getByRole('button', { name: '全屏', exact: true }),
  ).toHaveCount(0);
  const table = page.locator('.table-scroll').nth(1);
  await table.scrollIntoViewIfNeeded();
  const tableHandle = await table.locator('table').elementHandle();
  await expect(
    table.getByRole('button', { name: '全屏', exact: true }),
  ).toBeVisible({ timeout: 3000 });
  await enterElementFullscreen(table);
  await page.keyboard.press('Escape');
  await expect(table).not.toHaveClass(/element-fullscreen/);
  assert(await tableHandle!.evaluate((node) => node.isConnected));
  await expect(
    table.getByRole('button', { name: '全屏', exact: true }),
  ).toBeFocused();
  // Reflow removes the expansion control once all table content fits.
  await table.evaluate((node) => {
    node.style.width = '10000px';
    node.style.maxWidth = 'none';
  });
  await expect(
    table.getByRole('button', { name: '全屏', exact: true }),
  ).toHaveCount(0);
  await table.evaluate((node) => {
    node.style.width = '';
    node.style.maxWidth = '';
  });
  await expect(
    table.getByRole('button', { name: '全屏', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '目录', exact: true }).click();
  await expect(page.locator('.document-toc button')).toHaveCount(3);
  const hash = new URL(page.url()).hash;
  await page.getByRole('link', { name: '跳转', exact: true }).click();
  assert.equal(
    new URL(page.url()).hash,
    hash,
    'internal links preserve CW routing',
  );
  await page.locator('a[data-footnote-ref]').click();
  await expect(page.locator('li[id*="fn-note"]')).toContainText('脚注正文');
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.locator('img')).toHaveCount(0);
  assert.equal(
    await page.evaluate(() => (window as any).unsafeMarkdown),
    undefined,
  );
  const math = page.locator('.rich-code[data-language="math"]').first();
  await math.scrollIntoViewIfNeeded();
  await expect(math.locator('.katex')).toBeVisible();
  await expect(math.getByRole('button')).toHaveCount(0);
  const inline = page.locator('.inline-math').first();
  await inline.scrollIntoViewIfNeeded();
  await expect(inline.locator('.katex')).toBeVisible();
  await expect(inline.getByRole('button')).toHaveCount(0);
  async function expectOpenAiMath() {
    await expect(page.locator('.display-math')).toHaveCount(3);
    await expect(page.locator('.inline-math')).toHaveCount(3);
    for (const formula of await page
      .locator('.display-math, .inline-math')
      .all()) {
      await formula.scrollIntoViewIfNeeded();
      await expect(formula.locator('.katex')).toBeVisible();
      await expect(formula.locator('.rich-fallback')).toHaveCount(0);
      await expect(formula.getByRole('button')).toHaveCount(0);
    }
    await expect(
      page.locator(
        '.markdown h1[id*="-heading-"], .markdown h2[id*="-heading-"]',
      ),
    ).toHaveCount(3);
  }
  await expectOpenAiMath();
  const openAiInline = page.locator('.inline-math').nth(1);
  await expect(openAiInline.locator('.katex')).toBeVisible();
  await expect(page.locator('.katex-error')).toHaveCount(0);
  const code = page.locator('.rich-code[data-language="text"]');
  await code.scrollIntoViewIfNeeded();
  await enterElementFullscreen(code);
  await page.keyboard.press('Escape');
  const smallDiagram = page
    .locator('.rich-code[data-language="mermaid"]')
    .first();
  await smallDiagram.scrollIntoViewIfNeeded();
  await expect(smallDiagram.frameLocator('iframe').locator('svg')).toBeVisible({
    timeout: 30000,
  });
  await expect(smallDiagram.getByRole('button')).toHaveCount(0);
  assert(
    (await smallDiagram.locator('iframe').boundingBox())!.height < 200,
    'small diagram has compact automatic height',
  );
  const diagram = page.locator('.rich-code[data-language="mermaid"]').nth(1);
  await diagram.scrollIntoViewIfNeeded();
  await expect(diagram.frameLocator('iframe').locator('svg')).toBeVisible({
    timeout: 30000,
  });
  await expect(diagram.locator('iframe')).toHaveAttribute(
    'sandbox',
    'allow-scripts',
  );
  async function expectDiagramTheme(theme: 'dark' | 'light') {
    const frame = diagram.frameLocator('iframe');
    await expect(frame.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(frame.locator('svg')).toBeVisible();
    assert.equal(
      await frame
        .locator('body')
        .evaluate((node) => getComputedStyle(node).backgroundColor),
      theme === 'dark' ? 'rgb(25, 23, 23)' : 'rgb(255, 255, 255)',
    );
    return frame.locator('svg .node rect').first().getAttribute('style');
  }
  await expectDiagramTheme('light');
  const lightFill = await diagram
    .frameLocator('iframe')
    .locator('svg .node rect')
    .first()
    .evaluate((node) => getComputedStyle(node).fill);
  async function preference(theme: string) {
    await page.evaluate((theme) => {
      localStorage.setItem('coc-workbench-v1', JSON.stringify({ theme }));
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'coc-workbench-v1' }),
      );
    }, theme);
  }
  await preference('dark');
  await expectDiagramTheme('dark');
  assert.notEqual(
    await diagram
      .frameLocator('iframe')
      .locator('svg .node rect')
      .first()
      .evaluate((node) => getComputedStyle(node).fill),
    lightFill,
  );
  const diagramFrame = await diagram.locator('iframe').elementHandle();
  await enterElementFullscreen(diagram);
  await expect(diagram.frameLocator('iframe').locator('html')).toHaveAttribute(
    'data-expanded',
    'true',
  );
  const graph = diagram.frameLocator('iframe');
  const viewport = graph.locator('#diagram-viewport');
  const initialScale = Number(await viewport.getAttribute('data-scale'));
  await graph.getByRole('button', { name: '放大', exact: true }).click();
  await expect
    .poll(async () => Number(await viewport.getAttribute('data-scale')))
    .toBeGreaterThan(initialScale);
  await graph.getByRole('button', { name: '缩小', exact: true }).click();
  await expect
    .poll(async () => Number(await viewport.getAttribute('data-scale')))
    .toBeCloseTo(initialScale);
  await graph.getByRole('button', { name: '100%', exact: true }).click();
  await expect(viewport).toHaveAttribute('data-scale', '1');
  const beforePan = Number(await viewport.getAttribute('data-pan-x'));
  const bounds = (await viewport.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width / 2 + 80,
    bounds.y + bounds.height / 2 + 40,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Number(await viewport.getAttribute('data-pan-x')))
    .toBeGreaterThan(beforePan + 60);
  await page.mouse.wheel(0, -100);
  await expect
    .poll(async () => Number(await viewport.getAttribute('data-scale')))
    .toBeGreaterThan(1);
  await viewport.focus();
  await page.keyboard.press('0');
  await expect(viewport).toHaveAttribute('data-scale', '1');
  await page.keyboard.press('+');
  await expect(viewport).toHaveAttribute('data-scale', '1.25');
  await graph.getByRole('button', { name: '适应窗口', exact: true }).click();
  await expect
    .poll(async () => Number(await viewport.getAttribute('data-scale')))
    .toBeCloseTo(initialScale);
  await page.screenshot({
    path: join(artifacts, 'mermaid-element-fullscreen.png'),
  });
  await graph.locator('#diagram-viewport').focus();
  await page.keyboard.press('Escape');
  await expect(diagram).not.toHaveClass(/element-fullscreen/);
  assert(
    await diagramFrame!.evaluate((node) => node.isConnected),
    'fullscreen does not reload the iframe',
  );
  await preference('system');
  await expectDiagramTheme('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectDiagramTheme('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expectDiagramTheme('light');
  const invalid = page.locator('.rich-code[data-language="mermaid"]').nth(2);
  await invalid.scrollIntoViewIfNeeded();
  await expect(invalid.locator('.rich-fallback')).toContainText(
    'invalid diagram syntax',
    { timeout: 30000 },
  );
  const longMath = page.locator('.rich-code[data-language="math"]').nth(1);
  await longMath.scrollIntoViewIfNeeded();
  await expect(longMath.locator('.katex')).toBeVisible();
  await enterElementFullscreen(longMath);
  await page.keyboard.press('Escape');
  await expect(longMath).not.toHaveClass(/element-fullscreen/);
  await page.getByText('展开说明', { exact: true }).click();
  await expect(page.getByText('隐藏正文', { exact: true })).toBeVisible();
  await page.screenshot({
    path: join(artifacts, 'markdown-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectOpenAiMath();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    'mobile has no horizontal overflow',
  );
  await page.screenshot({
    path: join(artifacts, 'markdown-mobile.png'),
    fullPage: true,
  });
  await diagram.scrollIntoViewIfNeeded();
  await enterElementFullscreen(diagram);
  await expect(
    graph.getByRole('button', { name: '放大', exact: true }),
  ).toBeVisible();
  assert(
    await graph
      .locator('html')
      .evaluate((node) => node.scrollWidth <= innerWidth),
    'mobile diagram controls fit the viewport',
  );
  await page.screenshot({
    path: join(artifacts, 'mermaid-fullscreen-mobile.png'),
  });
  await page.keyboard.press('Escape');
  await expect(diagram).not.toHaveClass(/element-fullscreen/);
  assert.deepEqual(external, [], 'rendering never fetches external content');
  assert.deepEqual(errors, []);
  console.log('Advanced Markdown browser checks passed');
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
