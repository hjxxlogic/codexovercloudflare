import { selectHostId, selectProjectId } from './workspace-ui.ts';
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
      plaintextCommands: number;
      closed?: boolean;
      errors: string[];
    }[] = [];
    let durationMs: number | undefined;
    let passed = false;
    let failure: string | undefined;
    const button = (page: Page, name: string) =>
      page.getByRole('button', { name, exact: true });
    const end = async (entry: (typeof entries)[number]) => {
      if (entry.closed) return;
      await button(entry.page, '信息').click();
      await button(entry.page, '结束会话').click();
      await expect(entry.page.getByLabel('任务内容')).toHaveCount(0);
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
          await selectHostId(page, hostId);
          await selectProjectId(page, projectId);
          await button(page, '＋ 新建对话').click();
          await expect(page.getByRole('dialog')).toHaveCount(0);
          const composer = page.getByRole('textbox', {
            name: '任务内容',
            exact: true,
          });
          await composer.fill('CW_STRESS_BARRIER');
          await expect(button(page, '发送')).toBeEnabled();
        }),
      );
      const rejected = opened.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      const start = Date.now();
      // All sessions must admit a turn before any approval is answered.
      await Promise.all(
        entries.map(async (entry) => {
          await entry.page
            .getByRole('textbox', { name: '任务内容', exact: true })
            .fill(`CW_STRESS_${size}_${entry.index} approval`);
          await button(entry.page, '发送').click();
          await expect(button(entry.page, '拒绝')).toBeVisible();
        }),
      );
      const first = entries[0];
      await button(first.page, '拒绝').click();
      await expect(
        first.page.getByRole('log', { name: '对话消息' }),
      ).toContainText('denied');
      await expect(first.page.locator('.thinking')).toHaveCount(0);
      await end(first);
      await Promise.all(
        entries.slice(1).map(async (entry) => {
          // Closing the first session must leave all other approvals actionable.
          await expect(button(entry.page, '拒绝')).toBeVisible();
          await button(entry.page, '拒绝').click();
          await expect(
            entry.page.getByRole('log', { name: '对话消息' }),
          ).toContainText('denied');
          await expect(entry.page.locator('.thinking')).toHaveCount(0);
          await entry.page
            .getByRole('textbox', { name: '任务内容', exact: true })
            .fill(`CW_STRESS_CONTINUE_${size}_${entry.index}`);
          await button(entry.page, '发送').click();
          await expect(
            entry.page.getByRole('log', { name: '对话消息' }),
          ).toContainText(`echo: CW_STRESS_CONTINUE_${size}_${entry.index}`);
          await expect(entry.page.locator('.thinking')).toHaveCount(0);
          assert.equal(
            entry.plaintextCommands,
            0,
            'business commands stay encrypted',
          );
        }),
      );
      durationMs = Date.now() - start;
      assert.equal(first.plaintextCommands, 0);
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
      if (failure)
        await Promise.all(
          entries.map(async (entry) => {
            writeFileSync(
              join(artifacts, `browser-stress-${size}-${entry.index}.txt`),
              await entry.page.locator('body').innerText().catch(String),
            );
            await entry.page
              .screenshot({
                path: join(
                  artifacts,
                  `browser-stress-${size}-${entry.index}.png`,
                ),
              })
              .catch(() => {});
          }),
        );
      for (const entry of entries) {
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
          ({ index, plaintextCommands, closed, errors }) => ({
            index,
            plaintextCommands,
            closed,
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
      `PASS: ${size} independent browsers: concurrent same-project sessions, independent approvals and final closure`,
    );
  }
}
