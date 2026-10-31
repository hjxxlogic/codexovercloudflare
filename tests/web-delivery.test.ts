import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandDelivery } from '../apps/web/src/delivery.ts';

const active: CommandDelivery[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  active.splice(0).forEach((sender) => sender.disconnect());
  vi.useRealTimers();
});
function harness(saved?: any) {
  let data = saved;
  const storage = {
    record: vi.fn(async (_key: string, value?: unknown) => {
      if (value !== undefined) data = structuredClone(value);
      return structuredClone(data);
    }),
  };
  const result = vi.fn();
  const sender = new CommandDelivery(storage, result);
  active.push(sender);
  const wire = vi.fn();
  return { sender, wire, result, storage, saved: () => structuredClone(data) };
}
const window = (received = 0, credit = 1, receivedBytes = 0) => ({
  stream: 'receiver',
  instance: 'journal',
  received,
  receivedBytes,
  credit,
  byteCredit: 2 * 1024 * 1024,
});
const command = (id: string) => ({ action: 'prompt', requestId: id, text: id });
it('persists commands, obeys credit, and releases a slot only on completion', async () => {
  const h = harness();
  await h.sender.connect(h.wire);
  await h.sender.submit(command('one'));
  await h.sender.submit(command('two'));
  expect(
    h.wire.mock.calls.filter(([v]) => v.type === 'delivery-command'),
  ).toHaveLength(0);
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(),
  });
  const sent = h.wire.mock.calls
    .map(([v]) => v)
    .filter((v) => v.type === 'delivery-command');
  expect(sent).toHaveLength(1);
  expect(h.saved().normal.entries).toHaveLength(2);
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(1, 1, sent[0].end),
  });
  expect(
    h.wire.mock.calls.filter(([v]) => v.type === 'delivery-command'),
  ).toHaveLength(1);
  const result = {
    type: 'delivery-result',
    lane: 'normal',
    seq: 1,
    window: window(1, 2, sent[0].end),
    payload: { type: 'ack', requestId: 'one', result: {} },
  };
  await h.sender.receive(result);
  expect(
    h.wire.mock.calls.filter(([v]) => v.type === 'delivery-command'),
  ).toHaveLength(2);
  await h.sender.receive(result);
  expect(h.result).toHaveBeenCalledOnce();
});
it('reloads the same outbox and queries accepted commands rather than executing them again', async () => {
  const h = harness();
  await h.sender.connect(h.wire);
  await h.sender.submit(command('one'));
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(),
  });
  const sent = h.wire.mock.calls
    .map(([v]) => v)
    .find((v) => v.type === 'delivery-command');
  h.sender.disconnect();
  const resumed = harness(h.saved());
  await resumed.sender.connect(resumed.wire);
  await resumed.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(1, 2, sent.end),
  });
  expect(
    resumed.wire.mock.calls.some(([v]) => v.type === 'delivery-command'),
  ).toBe(false);
  expect(
    resumed.wire.mock.calls.some(
      ([v]) => v.type === 'delivery-query' && v.seq === 1,
    ),
  ).toBe(true);
  await resumed.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    seq: 1,
    window: window(1, 2, sent.end),
    record: {
      phase: 'finished',
      result: { type: 'ack', requestId: 'one', result: {} },
    },
  });
  expect(resumed.saved().normal.entries).toHaveLength(0);
  expect(resumed.result).toHaveBeenCalledOnce();
});
it('does not send when durable storage fails and excludes read operations', async () => {
  const h = harness();
  await h.sender.connect(h.wire);
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(),
  });
  h.storage.record.mockRejectedValueOnce(new Error('disk full'));
  await expect(h.sender.submit(command('one'))).rejects.toThrow('disk full');
  await expect(
    h.sender.submit({ action: 'sync', requestId: 'read' }),
  ).rejects.toThrow('mutation');
  expect(h.wire.mock.calls.some(([v]) => v.type === 'delivery-command')).toBe(
    false,
  );
});
it('reserves independent credit for approvals when normal commands are blocked', async () => {
  const h = harness();
  await h.sender.connect(h.wire);
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(0, 0),
  });
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'priority',
    window: { ...window(), stream: 'priority-receiver' },
  });
  await h.sender.submit(command('one'));
  await h.sender.submit({ action: 'interrupt', requestId: 'cancel' });
  const sent = h.wire.mock.calls
    .map(([v]) => v)
    .filter((v) => v.type === 'delivery-command');
  expect(sent).toHaveLength(1);
  expect(sent[0].lane).toBe('priority');
});
it('keeps local priority space when the normal outbox is full', async () => {
  const h = harness();
  await h.sender.connect(h.wire);
  for (let i = 0; i < 96; i++) await h.sender.submit(command('queued-' + i));
  await expect(h.sender.submit(command('overflow'))).rejects.toThrow('full');
  await h.sender.submit({ action: 'interrupt', requestId: 'emergency' });
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'priority',
    window: window(),
  });
  const sent = h.wire.mock.calls
    .map(([frame]) => frame)
    .filter((frame) => frame.type === 'delivery-command');
  expect(sent).toHaveLength(1);
  expect(sent[0].lane).toBe('priority');
});
it('retains a result until its outbox change commits and accepts a late result with older credit', async () => {
  const h = harness();
  await h.sender.connect(h.wire);
  await h.sender.submit(command('one'));
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(),
  });
  const end = h.saved().normal.bytes;
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(1, 5, end),
  });
  const result = {
    type: 'delivery-result',
    lane: 'normal',
    seq: 1,
    window: window(1, 2, end),
    payload: { type: 'ack', requestId: 'one' },
  };
  h.storage.record.mockRejectedValueOnce(new Error('disk full'));
  await expect(h.sender.receive(result)).rejects.toThrow('disk full');
  expect(h.result).not.toHaveBeenCalled();
  expect(h.saved().normal.entries).toHaveLength(1);
  await h.sender.receive(result);
  expect(h.result).toHaveBeenCalledOnce();
  expect(h.saved().normal.entries).toHaveLength(0);
});
it('coalesces concurrent HTTP receipt recovery', async () => {
  const memory: any = {};
  const storage = {
    record: async (key: string, value?: unknown) =>
      value === undefined
        ? memory[key]
        : (memory[key] = structuredClone(value)),
  };
  let release!: (value: unknown) => void;
  const read = vi.fn().mockImplementation(async (_stream, lane) => ({
    window: { ...window(), stream: lane },
  }));
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const sender = new CommandDelivery(storage, vi.fn(), {
    read,
    send: vi.fn().mockResolvedValue(undefined),
  });
  active.push(sender);
  await sender.connect(vi.fn());
  const first = sender.refresh();
  const second = sender.refresh();
  expect(first).toBe(second);
  await Promise.resolve();
  expect(read).toHaveBeenCalledOnce();
  release({ window: { ...window(), stream: 'priority' } });
  await first;
  expect(read).toHaveBeenCalledTimes(2);
});
it('ignores queued receipt callbacks from a retired connection', async () => {
  const h = harness();
  await h.sender.connect(h.wire);
  await h.sender.submit(command('one'));
  const end = h.saved().normal.bytes;
  const late = h.sender.receive({
    type: 'delivery-result',
    lane: 'normal',
    seq: 1,
    window: window(1, 2, end),
    payload: { type: 'ack', requestId: 'one' },
  });
  h.sender.disconnect();
  await late;
  expect(h.result).not.toHaveBeenCalled();
  expect(h.saved().normal.entries).toHaveLength(1);
});
it('refuses automatic replay into a replacement receiver journal', async () => {
  const h = harness();
  await h.sender.connect(h.wire);
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(),
  });
  await h.sender.submit(command('one'));
  h.sender.disconnect();
  const resumed = harness(h.saved());
  await resumed.sender.connect(resumed.wire);
  await expect(
    resumed.sender.receive({
      type: 'delivery-window',
      lane: 'normal',
      window: { ...window(), instance: 'replacement' },
    }),
  ).rejects.toThrow('journal changed');
  await expect(resumed.sender.submit(command('two'))).rejects.toThrow(
    'journal changed',
  );
  expect(
    resumed.wire.mock.calls.some(
      ([frame]) => frame.type === 'delivery-command',
    ),
  ).toBe(false);
});
