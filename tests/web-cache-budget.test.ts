import { expect, it } from 'vitest';
import {
  cacheLimits,
  commandReservation,
  historyCacheErrorMessage,
} from '../apps/web/src/cache-budget.ts';
const lane = () => ({ entries: [], results: { buffer: {}, cache: [] } });
const idle = () => ({
  version: 2,
  normal: lane(),
  priority: lane(),
  control: { controlId: 'retained' },
});
it('charges completed and read-only journals by their actual bytes, retaining identity', () => {
  expect(commandReservation(idle(), 1800)).toBe(1800);
  expect(commandReservation({ ...idle(), retired: [idle()] }, 2400)).toBe(2400);
});
it('keeps a result reservation for pending originals, buffered results and retired flows', () => {
  const pending = { ...lane(), entries: [{ seq: 1, body: 'original' }] };
  for (const state of [
    { ...idle(), normal: pending },
    { ...idle(), priority: pending },
    { ...idle(), normal: { ...lane(), results: { buffer: { 2: 'gap' } } } },
    { ...idle(), retired: [{ normal: pending, priority: lane() }] },
    { pending: 'legacy original' },
  ])
    expect(commandReservation(state, 1800)).toBe(
      cacheLimits.commandReservation,
    );
});
it('releases only confirmed HTTP operations and uploads without retained file chunks', () => {
  const http = ['scope', 'delivery-outbox-http:v2'];
  const upload = ['scope', 'delivery-outbox-upload:v2'];
  expect(
    commandReservation(
      { version: 2, order: ['id'], records: { id: { state: 'confirmed' } } },
      2000,
      http,
    ),
  ).toBe(2000);
  for (const state of ['pending', 'completed'])
    expect(
      commandReservation(
        { version: 2, order: ['id'], records: { id: { state } } },
        2000,
        http,
      ),
    ).toBe(cacheLimits.commandReservation);
  expect(
    commandReservation(
      { version: 2, records: [{ phase: 'completed' }] },
      2000,
      upload,
    ),
  ).toBe(2000);
  for (const record of [
    { phase: 'unknown' },
    { phase: 'finishing' },
    { phase: 'failed', chunks: ['original bytes'] },
  ])
    expect(
      commandReservation({ version: 2, records: [record] }, 2000, upload),
    ).toBe(cacheLimits.commandReservation);
});

it('distinguishes storage capacity, live backlog and cache access failures', () => {
  expect(
    historyCacheErrorMessage(new DOMException('full', 'QuotaExceededError')),
  ).toContain('额度已满');
  expect(
    historyCacheErrorMessage(
      Object.assign(new Error('busy'), {
        name: 'HistoryCacheBufferFullError',
      }),
    ),
  ).toContain('写入积压');
  expect(
    historyCacheErrorMessage(new DOMException('denied', 'SecurityError')),
  ).toContain('SecurityError: denied');
});
