// Isolated built-web rendering checks. No production credentials or model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
const source = `# 高级 Markdown\n\n[跳转](#高级-markdown)\n\n> [!WARNING]\n> 注意事项\n\n正文脚注[^note]，价格 $100，代码 \`$x$\`。\n\n[^note]: 脚注正文\n\n## 表格\n\n| 左 | 右 |\n| :--- | ---: |\n| A | B |\n\n## 公式\n\n$$\n\\frac{a}{b} + \\sqrt{x}\n$$\n\n行内 $x^2$。\n\n\`\`\`mermaid\nflowchart LR\n  A[开始] --> B[结束]\n\`\`\`\n\n:::details 展开说明\n\n隐藏正文\n\n:::\n\n<script>window.unsafeMarkdown=true</script>\n[bad](javascript:alert(1))\n![remote](https://untrusted.invalid/pixel.png)\n`;
const bytes = Buffer.from(source);
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
  if (url.pathname === '/diagram.html')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts",
    );
  else
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  const root = resolve('dist/web');
  const file = resolve(
    root,
    '.' + (url.pathname === '/' ? '/index.html' : url.pathname),
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
  await page.goto(
    `http://127.0.0.1:${port}/#preview=file&host=host&project=project&path=report.md`,
  );
  await expect(
    page.getByRole('heading', { name: '高级 Markdown' }),
  ).toBeVisible();
  await expect(page.locator('.callout-warning')).toContainText('注意事项');
  await expect(page.locator('table')).toHaveCount(1);
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
  await page.locator('.inline-math button').click();
  await expect(page.locator('.inline-math .katex')).toBeVisible();
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
