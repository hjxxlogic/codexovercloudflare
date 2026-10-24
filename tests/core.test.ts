import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../apps/agent/src/store.ts';
import { CodexProcess, guardCli, redact } from '../apps/agent/src/codex.ts';
import {
  MAX_FRAME,
  parseFrame,
  relayUrl,
  webCommandSchema,
} from '../packages/protocol/src/index.ts';
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'coc-unit-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe('protocol boundaries', () => {
  it('allows TLS and loopback only', () => {
    expect(relayUrl('https://r.xlogic.cc')).toBe('https://r.xlogic.cc');
    expect(relayUrl('http://127.0.0.1:8787')).toContain('8787');
    for (const u of [
      'http://example.com',
      'https://u:p@example.com',
      'https://example.com/path',
    ])
      expect(() => relayUrl(u)).toThrow();
  });
  it('rejects oversized frames and unknown web commands', () => {
    expect(() => parseFrame(' '.repeat(MAX_FRAME + 1))).toThrow();
    expect(() =>
      webCommandSchema.parse({ action: 'exec', command: 'pwd' }),
    ).toThrow();
  });
  it('blocks remote policy overrides and foreign threads', () => {
    expect(() =>
      guardCli({ method: 'account/login/start' }, '/p', 'workspace-write'),
    ).toThrow();
    expect(() =>
      guardCli(
        { method: 'turn/start', params: { cwd: '/etc' } },
        '/p',
        'workspace-write',
      ),
    ).toThrow();
    expect(() =>
      guardCli(
        { method: 'turn/start', params: { threadId: 'foreign' } },
        '/p',
        'workspace-write',
        'mine',
      ),
    ).toThrow();
    expect(() =>
      guardCli(
        {
          method: 'turn/start',
          params: { sandboxPolicy: { type: 'danger-full-access' } },
        },
        '/p',
        'workspace-write',
      ),
    ).toThrow();
    expect(
      guardCli({ id: 1, method: 'thread/start' }, '/p', 'workspace-write')
        .params,
    ).toMatchObject({
      cwd: '/p',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    });
  });
  it('redacts nested credentials', () =>
    expect(
      redact({
        config: { api_key: 'secret', env: { TOKEN: 's' }, model: 'x' },
      }),
    ).toEqual({ config: { api_key: '[redacted]', env: {}, model: 'x' } }));
});
describe('persistent session journal', () => {
  it('rejects duplicates in flight, caches completed requests, and detects conflicting retries', () => {
    const s = new Store(temp());
    expect(s.begin('r', 'a').cached).toBe(false);
    expect(() => s.begin('r', 'a')).toThrow(/may have executed/);
    expect(() => s.begin('r', 'b')).toThrow(/different content/);
    s.finish('r', { ok: true });
    expect(s.begin('r', 'a')).toEqual({ cached: true, value: { ok: true } });
    s.close();
  });
  it('replays only the requested session and marks live sessions failed after restart', () => {
    const dir = temp();
    let s = new Store(dir);
    s.save({
      id: 'a',
      projectId: 'p',
      mode: 'web',
      state: 'ready',
      running: true,
      createdAt: Date.now(),
    });
    const one = s.event('a', 'text', 'first');
    s.event('b', 'text', 'private');
    s.event('a', 'text', 'last');
    expect(s.replay('a', one.seq).events.map((e) => e.data)).toEqual(['last']);
    s.close();
    s = new Store(dir);
    expect(s.get('a')).toMatchObject({ state: 'failed', running: false });
    s.close();
  });
});
it('runs a bidirectional app-server protocol peer including server approval', async () => {
  const cwd = temp();
  let approval: any;
  const p = new CodexProcess(
    process.execPath,
    [resolve('tests/fixtures/fake-codex.mjs')],
    cwd,
    'workspace-write',
    (m) => {
      if (m.method === 'item/commandExecution/requestApproval') approval = m;
    },
    () => {},
  );
  try {
    await p.initialize();
    const t = await p.request('thread/start', {});
    expect(t.thread.id).toContain('thread-');
    await p.request('turn/start', {
      threadId: t.thread.id,
      input: [{ type: 'text', text: 'approval' }],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(approval.method).toContain('requestApproval');
    p.send({ id: approval.id, result: { decision: 'decline' } });
  } finally {
    p.close();
    await new Promise((r) => setTimeout(r, 100));
  }
});
