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
`;
const bytes = Buffer.from(source + openAiSource);
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
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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
  await expect(page.locator('table')).toHaveCount(1);
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
  const table = page.locator('.table-scroll');
  const tableHandle = await table.locator('table').elementHandle();
  await enterElementFullscreen(table);
  await page.keyboard.press('Escape');
  await expect(table).not.toHaveClass(/element-fullscreen/);
  assert(await tableHandle!.evaluate((node) => node.isConnected));
  await expect(
    table.getByRole('button', { name: '全屏', exact: true }),
  ).toBeFocused();
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
  const math = page.locator('.rich-code').filter({
    has: page.locator('.code-toolbar > span', { hasText: /^math$/ }),
  });
  await math.getByRole('button', { name: '格式化预览' }).click();
  await expect(math.locator('.katex')).toBeVisible();
  await enterElementFullscreen(math);
  await math.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect(math.locator('.katex')).toBeVisible();
  await page.locator('.inline-math button').first().click();
  await expect(page.locator('.inline-math .katex').first()).toBeVisible();
  await page.locator('.display-math > button').click();
  await expect(page.locator('.display-math .katex-display')).toBeVisible();
  await enterElementFullscreen(page.locator('.display-math'));
  await page.keyboard.press('Escape');
  await expect(page.locator('.display-math .katex-display')).toBeVisible();
  const openAiInline = page
    .locator('.inline-math')
    .filter({ hasText: 'L_{i,' });
  await openAiInline.getByRole('button').click();
  await expect(openAiInline.locator('.katex')).toBeVisible();
  await expect(
    page.getByText('本次没有覆盖的位置取', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('.katex-error')).toHaveCount(0);
  const diagram = page.locator('.rich-code').filter({
    has: page.locator('.code-toolbar > span', { hasText: /^mermaid$/ }),
  });
  await diagram.getByRole('button', { name: '格式化预览' }).click();
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
      theme === 'dark' ? 'rgb(25, 31, 42)' : 'rgb(255, 255, 255)',
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
  assert(
    (await diagram.frameLocator('iframe').locator('svg').boundingBox())!.width >
      1000,
    'fullscreen uses available diagram width',
  );
  await page.screenshot({
    path: join(artifacts, 'mermaid-element-fullscreen.png'),
  });
  await diagram.frameLocator('iframe').locator('svg').click();
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
  await page.getByText('展开说明', { exact: true }).click();
  await expect(page.getByText('隐藏正文', { exact: true })).toBeVisible();
  await page.screenshot({
    path: join(artifacts, 'markdown-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
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
  assert.deepEqual(external, [], 'rendering never fetches external content');
  assert.deepEqual(errors, []);
  console.log('Advanced Markdown browser checks passed');
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
