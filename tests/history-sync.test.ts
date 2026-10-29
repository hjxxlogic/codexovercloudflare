import { describe, expect, it } from 'vitest';
import { HistorySync } from '../apps/web/src/history-sync.ts';
describe('Agent/client revision watermarks', () => {
  it('advances an unbroken live chain without assuming adjacent global sequence numbers', () => {
    const cursor = new HistorySync();
    cursor.restore(8);
    cursor.observe(14, 8);
    cursor.observe(35, 14);
    expect(cursor.received).toBe(35);
    expect(cursor.maximum).toBe(35);
    expect(cursor.missing).toBe(false);
  });
  it('fills a lost tool revision before advancing and ignores old or duplicate deliveries', () => {
    const cursor = new HistorySync();
    cursor.restore(10);
    cursor.observe(40, 30);
    expect(cursor.received).toBe(10);
    expect(cursor.missing).toBe(true);
    cursor.snapshot({
      direction: 'after',
      more: true,
      cursor: 20,
      snapshotSeq: 40,
    });
    expect(cursor.received).toBe(20);
    expect(cursor.missing).toBe(true);
    cursor.snapshot({
      direction: 'after',
      more: false,
      cursor: 40,
      snapshotSeq: 40,
    });
    cursor.observe(30, 20);
    cursor.snapshot({
      direction: 'after',
      more: false,
      cursor: 15,
      snapshotSeq: 15,
    });
    expect(cursor.received).toBe(40);
    expect(cursor.missing).toBe(false);
  });
  it('does not skip an unseen tail arriving while a snapshot was in flight', () => {
    const cursor = new HistorySync();
    cursor.observe(100, 90);
    expect(cursor.received).toBeUndefined();
    cursor.snapshot({
      direction: 'before',
      more: true,
      cursor: -10,
      snapshotSeq: 80,
    });
    expect(cursor.received).toBe(80);
    expect(cursor.missing).toBe(true);
    cursor.snapshot({
      direction: 'after',
      more: false,
      cursor: 100,
      snapshotSeq: 100,
    });
    expect(cursor.missing).toBe(false);
  });
  it('ignores missing legacy watermarks and invalid maximums', () => {
    const cursor = new HistorySync();
    cursor.restore(8);
    for (const maximum of [
      undefined,
      -1,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '9',
    ])
      cursor.observe(maximum, 8);
    expect(cursor.received).toBe(8);
    expect(cursor.missing).toBe(false);
  });
});
