import { describe, expect, it } from 'vitest';
import type { Event } from '../packages/protocol/src/index.ts';
import { visibleEvents } from '../apps/web/src/events.ts';

const delta = (seq: number, text: string, itemId = 'reply'): Event => ({
  seq,
  time: seq,
  type: 'item/agentMessage/delta',
  data: { itemId, delta: text },
});

describe('web reply assembly', () => {
  it('restores a scrambled stream by sequence without mutating stored events', () => {
    const fragments = [
      'Hi',
      '!',
      ' What',
      ' would',
      ' you',
      ' like',
      ' to',
      ' work',
      ' on',
      '?',
    ];
    const events = fragments.map((text, i) => delta(i + 1, text));
    const scrambled = [1, 3, 4, 0, 5, 7, 2, 6, 9, 8].map((i) => events[i]);
    const original = structuredClone(scrambled);
    const result = visibleEvents(scrambled);
    expect(result).toHaveLength(1);
    expect(result[0].data).toMatchObject({
      delta: 'Hi! What would you like to work on?',
    });
    expect(scrambled).toEqual(original);
  });

  it('merges overlapping history and live events once, preserving turn boundaries', () => {
    const first = delta(2, 'Hello');
    const boundary: Event = {
      seq: 4,
      time: 4,
      type: 'turn/completed',
      data: {},
    };
    const result = visibleEvents([
      delta(5, 'Next turn'),
      delta(3, ' world'),
      boundary,
      first,
      first,
    ]);
    expect(result.map((e) => e.data)).toEqual([
      { itemId: 'reply', delta: 'Hello world' },
      {},
      { itemId: 'reply', delta: 'Next turn' },
    ]);
  });

  it('keeps distinct response items separate', () => {
    const result = visibleEvents([
      delta(2, 'Second', 'b'),
      delta(1, 'First', 'a'),
    ]);
    expect(result.map((e) => e.data)).toEqual([
      { itemId: 'a', delta: 'First' },
      { itemId: 'b', delta: 'Second' },
    ]);
  });
});
