import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  spawn.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

it.each([0, 1])(
  'waits for every scenario and propagates exit %i',
  async (code) => {
    const children: EventEmitter[] = [];
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      children.push(child);
      return child;
    });
    let finished = false;
    const run = import('../scripts/test-billing.ts').then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(children).toHaveLength(3));
    // All three start before any one of them can finish.
    children[0].emit('close', code, null);
    children[1].emit('close', 0, null);
    await Promise.resolve();
    expect(finished).toBe(false);
    children[2].emit('close', 0, null);
    await run;
    expect(process.exitCode ?? 0).toBe(code);
  },
);
