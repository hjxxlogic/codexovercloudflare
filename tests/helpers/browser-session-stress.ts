import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

// Isolated Worker/native-Agent fixture only. Never uses production cookies or a model.
export async function browserSessionStress(options: {
  browser: Browser;
  origin: string;
  hostId: string;
  projectId: string;
  cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
  artifacts: string;
}) {
  const { browser, origin, hostId, projectId, cookies, artifacts } = options;
  mkdirSync(artifacts, { recursive: true });
  const phases: unknown[] = [];
  for (const size of [3, 5]) {
    const entries: {
      context: BrowserContext;
      page: Page;
      index: number;
      reader?: boolean;
      plaintextCommands: number;
      refreshMs?: number;
      closed?: boolean;
      acquired?: boolean;
      errors: string[];
    }[] = [];
    let durationMs: number | undefined;
    let passed = false;
    let failure: string | undefined;
    const button = (page: Page, name: string) =>
      page.getByRole('button', { name, exact: true });
    const end = async (entry: (typeof entries)[number]) => {
      if (entry.closed) return;
      await entry.page.locator('.workspace-context').click();
      await button(entry.page, '结束会话').click();
      await expect(entry.page.locator('.workspace-context')).toContainText(
        '会话已结束',
        { timeout: 20000 },
      );
      await expect(entry.page.locator('body')).not.toContainText(
        'signal is aborted without reason',
      );
      entry.closed = true;
    };
    try {
      // Independent IndexedDB, storage, controller identity and sockets; one barrier
      // waits for all actual handshakes before assessing roles or sending a task.
      const opened = await Promise.allSettled(
        Array.from({ length: size }, async (_, index) => {
          const context = await browser.newContext({
            storageState: { cookies, origins: [] },
          });
          const page = await context.newPage();
          page.setDefaultTimeout(30000);
          page.on('dialog', (dialog) => void dialog.accept());
          const entry: (typeof entries)[number] = {
            context,
            page,
            index,
            plaintextCommands: 0,
            errors: [],
          };
          entries.push(entry);
          page.on('pageerror', (error) => entry.errors.push(error.message));
          page.on('request', (request) => {
            if (
              request.method() !== 'POST' ||
              !new URL(request.url()).pathname.endsWith('/delivery')
            )
              return;
            const frame = request.postDataJSON();
            if (
              frame?.type === 'delivery-command' &&
              JSON.parse(frame.body).action === 'prompt'
            )
              entry.plaintextCommands++;
          });
          await page.goto(origin);
          await button(page, '功能菜单').click();
          await page
            .getByRole('navigation', { name: '功能菜单', exact: true })
            .getByRole('button', { name: /^会话记录/ })
            .click();
          await page
            .getByRole('combobox', { name: '主机', exact: true })
            .selectOption(hostId);
          await expect(
            page.getByRole('combobox', { name: '项目', exact: true }),
          ).toHaveValue(projectId);
          await button(page, '创建网页会话').click();
          await expect(page.getByRole('dialog')).toHaveCount(0);
          await expect
            .poll(
              async () => {
                const text = await page
                  .locator('.workspace-context')
                  .innerText();
                return (
                  text.includes('已连接') ||
                  text.includes('只读会话 · 同项目已有写会话')
                );
              },
              { timeout: 30000 },
            )
            .toBe(true);
          entry.reader = (
            await page.locator('.workspace-context').innerText()
          ).includes('只读会话');
        }),
      );
      const rejected = opened.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      const writers = entries.filter((entry) => !entry.reader);
      const readers = entries.filter((entry) => entry.reader);
      assert.equal(
        writers.length,
        1,
        `${size} simultaneous browsers must have one writer`,
      );
      assert.equal(readers.length, size - 1);
      const writer = writers[0];
      assert.equal(writer.plaintextCommands, 0);

      await writer.page
        .getByRole('textbox', { name: '任务内容', exact: true })
        .fill(`CW_STRESS_${size} approval`);
      const start = Date.now();
      await button(writer.page, '发送').click();
      await button(writer.page, '拒绝').click();
      await Promise.all(
        readers.map(async (reader) => {
          await expect(
            reader.page.getByRole('textbox', { name: '任务内容', exact: true }),
          ).toHaveCount(0);
          const refreshStart = Date.now();
          await button(reader.page, '刷新状态').click();
          await expect(button(reader.page, '刷新状态')).toBeEnabled({
            timeout: 20000,
          });
          await expect(reader.page.locator('body')).not.toContainText(
            '刷新超时',
          );
          reader.refreshMs = Date.now() - refreshStart;
          assert.equal(
            reader.plaintextCommands,
            0,
            'business commands must stay inside encrypted records',
          );
        }),
      );
      await expect(
        writer.page.getByRole('log', { name: '对话消息' }),
      ).toContainText('denied');
      await expect(writer.page.locator('.thinking')).toHaveCount(0);
      durationMs = Date.now() - start;
      await end(writer);
      const successor = readers[0];
      await button(successor.page, '获取写权限').click();
      await expect(successor.page.locator('.workspace-context')).toContainText(
        '已连接',
      );
      await successor.page
        .getByRole('textbox', { name: '任务内容', exact: true })
        .fill(`CW_STRESS_HANDOFF_${size}`);
      await button(successor.page, '发送').click();
      await expect(
        successor.page.getByRole('log', { name: '对话消息' }),
      ).toContainText(`echo: CW_STRESS_HANDOFF_${size}`);
      await expect(successor.page.locator('.thinking')).toHaveCount(0);
      successor.acquired = true;
      assert.equal(successor.plaintextCommands, 0);

      for (const reader of readers.slice(1)) {
        await expect(
          reader.page.getByRole('textbox', { name: '任务内容', exact: true }),
        ).toHaveCount(0);
        assert.equal(reader.plaintextCommands, 0);
      }
      assert(
        entries.every((entry) => !entry.errors.length),
        'browser stress has no page errors',
      );
      passed = true;
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      const cleanupErrors: string[] = [];
      for (const entry of entries) {
        if (failure)
          await entry.page
            .screenshot({
              path: join(
                artifacts,
                `browser-stress-${size}-${entry.index}.png`,
              ),
            })
            .catch(() => {});
        try {
          await end(entry);
        } catch (error) {
          cleanupErrors.push(String(error));
        }
        await entry.context.close();
      }
      phases.push({
        size,
        durationMs,
        passed,
        failure,
        cleanupErrors,
        browsers: entries.map(
          ({
            index,
            reader,
            plaintextCommands,
            refreshMs,
            closed,
            acquired,
            errors,
          }) => ({
            index,
            reader,
            plaintextCommands,
            refreshMs,
            closed,
            acquired,
            errors,
          }),
        ),
      });
      writeFileSync(
        join(artifacts, 'browser-session-stress.json'),
        JSON.stringify(phases, null, 2) + '\n',
      );
      if (!failure)
        assert.deepEqual(
          cleanupErrors,
          [],
          'all stress sessions confirm final closure',
        );
    }
    console.log(
      `PASS: ${size} independent browsers: one writer, read-only refresh, command approval, write handoff and final closure`,
    );
  }
}
