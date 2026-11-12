import { describe, expect, it } from 'vitest';
import { sessionTabLabels } from '../apps/web/src/session-tab-labels.ts';

describe('session tab labels', () => {
  it('keeps distinct titles short', () => {
    expect(
      sessionTabLabels([
        { title: 'Alpha', directory: '/a', project: 'Project A' },
        { title: 'Beta', directory: '/b' },
      ]).map((tab) => tab.label),
    ).toEqual(['Alpha', 'Beta']);
  });
  it('compares titles without case and shows different working directories', () => {
    expect(
      sessionTabLabels([
        { title: 'Shared', directory: '/a', project: 'A' },
        { title: 'sHARED', directory: '/b', project: 'B' },
      ]).map((tab) => tab.label),
    ).toEqual(['Shared · /a', 'sHARED · /b']);
  });
  it('adds the project only for collisions within the same directory', () => {
    expect(
      sessionTabLabels([
        { title: 'Shared', directory: '/a', project: 'A' },
        { title: 'SHARED', directory: '/a', project: 'B' },
        { title: 'shared', directory: '/b', project: 'C' },
      ]).map((tab) => tab.label),
    ).toEqual(['Shared · /a · A', 'SHARED · /a · B', 'shared · /b']);
  });
  it('falls back to projects while directory metadata is unavailable', () => {
    expect(
      sessionTabLabels([
        { title: 'Shared', project: 'A' },
        { title: 'SHARED', project: 'B' },
      ]).map((tab) => tab.label),
    ).toEqual(['Shared · A', 'SHARED · B']);
  });
  it('removes context when closing a tab resolves the title collision', () => {
    expect(
      sessionTabLabels([{ title: 'Shared', directory: '/a', project: 'A' }]),
    ).toEqual([{ title: 'Shared', context: '', label: 'Shared' }]);
  });
  it('keeps case sensitive paths distinct', () => {
    expect(
      sessionTabLabels([
        { title: 'Shared', directory: '/A', project: 'A' },
        { title: 'shared', directory: '/a', project: 'B' },
      ]).map((tab) => tab.context),
    ).toEqual(['/A', '/a']);
  });
});
