import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lastHost,
  rememberHost,
  restoreWorkspace,
} from '../apps/web/src/workspace-state.ts';
import type { Session } from '../packages/protocol/src/index.ts';

const projects = [
  { id: 'first', name: 'First', path: '/first' },
  { id: 'second', name: 'Second', path: '/second' },
];
const session: Session = {
  id: 'host~saved',
  projectId: 'second',
  mode: 'web',
  state: 'ready',
  running: false,
  createdAt: 1,
  updatedAt: 1,
};

describe('remembered CW workspace', () => {
  it('restores a non-default project and conversation and prefers fresh session state', () => {
    expect(
      restoreWorkspace({ projectId: 'second', session }, 'host', projects, [
        { ...session, state: 'closed' },
      ]),
    ).toEqual({
      projectId: 'second',
      session: { ...session, state: 'closed' },
    });
  });
  it('restores cached metadata when the conversation is outside the latest directory page', () => {
    expect(
      restoreWorkspace({ projectId: 'second', session }, 'host', projects, []),
    ).toEqual({ projectId: 'second', session });
  });
  it('falls back to available projects and rejects invalid, cross-host, cross-project and CLI metadata', () => {
    for (const saved of [
      undefined,
      null,
      'broken',
      { projectId: 'missing', session },
      { projectId: 'first', session },
      { projectId: 'second', session: { ...session, id: 'other~saved' } },
      { projectId: 'second', session: { ...session, mode: 'cli' } },
      { projectId: 'second', session: { id: 'host~saved' } },
    ]) {
      expect(
        restoreWorkspace(saved, 'host', projects, []).session,
      ).toBeUndefined();
    }
    expect(
      restoreWorkspace({ projectId: 'missing', session }, 'host', projects, [])
        .projectId,
    ).toBe('first');
    expect(
      restoreWorkspace({ projectId: 'second', session }, 'host', [], []),
    ).toEqual({ projectId: '', session: undefined });
  });
  it('preserves a deliberate project selection without an open conversation', () => {
    expect(
      restoreWorkspace({ projectId: 'second' }, 'host', projects, [session]),
    ).toEqual({ projectId: 'second', session: undefined });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('stores only the last host hint and removes it when explicitly deselected', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    rememberHost('host');
    expect(lastHost()).toBe('host');
    expect([...values.values()]).toEqual(['host']);
    rememberHost('');
    expect(lastHost()).toBe('');
  });
  it('continues when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(lastHost()).toBe('');
    expect(() => rememberHost('host')).not.toThrow();
    expect(() => rememberHost('')).not.toThrow();
  });
});
