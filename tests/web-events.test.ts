import { describe, expect, it } from 'vitest';
import type { Event } from '../packages/protocol/src/index.ts';
import { visibleEvents, eventWindow } from '../apps/web/src/events.ts';

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

  it('assembles interleaved response fragments and groups a tool lifecycle without mutating history', () => {
    const events: Event[] = [
      delta(1, 'Hello'),
      {
        seq: 2,
        time: 2,
        type: 'item/started',
        data: {
          item: { id: 'cmd', type: 'commandExecution', command: 'echo ok' },
        },
      },
      delta(3, ' world'),
      {
        seq: 4,
        time: 4,
        type: 'item/commandExecution/outputDelta',
        data: { itemId: 'cmd', delta: 'ok' },
      },
      {
        seq: 5,
        time: 5,
        type: 'item/completed',
        data: {
          item: {
            id: 'cmd',
            type: 'commandExecution',
            command: 'echo ok',
            aggregatedOutput: 'ok',
            exitCode: 0,
          },
        },
      },
    ];
    const original = structuredClone(events);
    const result = visibleEvents(events);
    expect(result).toHaveLength(2);
    expect(result[0].data).toMatchObject({ delta: 'Hello world' });
    expect(result[1].data).toMatchObject({
      item: { aggregatedOutput: 'ok', exitCode: 0 },
    });
    expect(events).toEqual(original);
  });

  it('keeps the latest message revision when cache and live snapshots overlap', () => {
    const events = [
      { ...delta(1, 'hello'), revision: 8 },
      { ...delta(1, 'hel'), revision: 6 },
    ];
    expect(visibleEvents(events)).toEqual([events[0]]);
    expect(eventWindow(events)).toEqual([events[0]]);
  });

  it('bounds the display window by actual UTF-8 bytes', () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      delta(i + 1, '你好'.repeat(300)),
    );
    const window = eventWindow(events, 400, 16 * 1024);
    expect(window.length).toBeLessThan(10);
    expect(window.at(-1)?.seq).toBe(100);
    expect(
      window.reduce(
        (n, e) => n + new TextEncoder().encode(JSON.stringify(e)).length,
        0,
      ),
    ).toBeLessThanOrEqual(16 * 1024);
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
