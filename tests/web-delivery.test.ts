import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandDelivery } from '../apps/web/src/delivery.ts';

const active: CommandDelivery[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  active.splice(0).forEach((sender) => sender.disconnect());
  vi.useRealTimers();
});
const command = (id: string) => ({ action: 'prompt', requestId: id, text: id });
const window = (received = 0, credit = 16, receivedBytes = 0) => ({
  stream: 'receiver',
  instance: 'journal',
  received,
  receivedBytes,
  sent: 100,
  resultBytes: 2 * 1024 * 1024,
  credit,
  byteCredit: 2 * 1024 * 1024,
});
function resultFields(
  payload: unknown,
  seq = 1,
  resultSeq = 1,
  priorBytes = 0,
) {
  const resultBody = JSON.stringify(payload);
  return {
    seq,
    resultSeq,
    resultStream: 'receiver_r',
    resultEnd: priorBytes + Buffer.byteLength(resultBody),
    resultBody,
    resultDigest: createHash('sha256').update(resultBody).digest('hex'),
  };
}
function harness(saved?: any, content?: (...args: any[]) => Promise<any>) {
  let data = saved;
  const storage = {
    record: vi.fn(async (_key: string, value?: unknown) => {
      if (value !== undefined) data = structuredClone(value);
      return structuredClone(data);
    }),
  };
  const result = vi.fn(),
    wire = vi.fn();
  const sender = new CommandDelivery(
    storage,
    result,
    content
      ? {
          read: vi.fn(),
          send: async (frame) => {
            wire(frame);
          },
          content,
        }
      : undefined,
  );
  active.push(sender);
  const frames = (type: string) =>
    wire.mock.calls.map(([v]) => v).filter((v) => v.type === type);
  const exchange = () => frames('delivery-open').at(-1).exchangeId;
  const snapshot = (
    lane = 'normal',
    value = window(),
    exchangeId = exchange(),
  ) =>
    sender.receive({
      type: 'delivery-window',
      lane,
      window: value,
      exchangeId,
    });
  const connect = async (normal = window()) => {
    await sender.connect(wire);
    await snapshot('priority', {
      ...window(0, 4),
      stream: 'priority-receiver',
    });
    await snapshot('normal', normal);
  };
  return {
    sender,
    storage,
    result,
    wire,
    frames,
    snapshot,
    connect,
    exchange,
    saved: () => structuredClone(data),
  };
}
it('persists unpublished commands without sequence numbers until both recovery snapshots and credit arrive', async () => {
  const h = harness();
  await h.sender.connect(h.wire);
  await h.sender.submit(command('one'));
  await h.sender.submit(command('two'));
  expect(h.saved().normal.next).toBe(0);
  expect(h.saved().normal.entries.map((v: any) => v.seq)).toEqual([0, 0]);
  await h.snapshot('normal', window(0, 1));
  expect(h.frames('delivery-command')).toHaveLength(0);
  await h.snapshot('priority', { ...window(), stream: 'priority-receiver' });
  expect(h.frames('delivery-command')).toHaveLength(1);
  const first = h.frames('delivery-command')[0];
  expect(h.saved().normal.next).toBe(1);
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(1, 1, first.end),
  });
  expect(h.frames('delivery-command')).toHaveLength(1);
  await h.sender.receive({
    type: 'delivery-result',
    lane: 'normal',
    window: window(1, 2, first.end),
    ...resultFields({ type: 'ack', requestId: 'one' }),
  });
  expect(h.frames('delivery-command')).toHaveLength(2);
  expect(h.result).toHaveBeenCalledOnce();
});
it('reconnects using original identities and queries accepted commands', async () => {
  const h = harness();
  await h.connect();
  await h.sender.submit(command('one'));
  const first = h.frames('delivery-command')[0];
  h.sender.disconnect();
  const resumed = harness(h.saved());
  await resumed.connect(window(1, 2, first.end));
  expect(resumed.frames('delivery-command')).toHaveLength(0);
  expect(resumed.frames('delivery-query')[0].seq).toBe(1);
  await resumed.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    seq: 1,
    window: window(1, 2, first.end),
    record: {
      phase: 'finished',
      ...resultFields({ type: 'ack', requestId: 'one' }),
    },
  });
  expect(resumed.saved().normal.entries).toHaveLength(0);
  expect(resumed.result).toHaveBeenCalledOnce();
});
it('does not publish or send when durable queue storage fails and excludes reads', async () => {
  const h = harness();
  await h.connect();
  h.storage.record.mockRejectedValueOnce(new Error('disk full'));
  await expect(h.sender.submit(command('one'))).rejects.toThrow('disk full');
  await expect(
    h.sender.submit({ action: 'sync', requestId: 'read' }),
  ).rejects.toThrow('mutation');
  expect(h.saved().normal.next).toBe(0);
  expect(h.frames('delivery-command')).toHaveLength(0);
});

it('keeps recovering admitted results after credit exhaustion or closure without publishing new commands', async () => {
  for (const retired of [{ exhausted: true }, { closed: true }]) {
    const h = harness();
    await h.connect();
    await h.sender.submit(command('original'));
    const published = h.frames('delivery-command')[0];
    await h.snapshot('normal', {
      ...window(1, 1, published.end),
      ...retired,
    } as any);
    await expect(h.sender.submit(command('new'))).rejects.toThrow(
      'STREAM_CLOSED',
    );
    h.sender.disconnect();
    const restored = harness(h.saved());
    await restored.connect({
      ...window(1, 1, published.end),
      ...retired,
    } as any);
    expect(restored.frames('delivery-command')).toHaveLength(0);
    expect(restored.frames('delivery-query').at(-1).seq).toBe(1);
    await restored.sender.receive({
      type: 'delivery-window',
      lane: 'normal',
      window: { ...window(1, 1, published.end), ...retired },
      record: {
        phase: 'finished',
        ...resultFields({ type: 'ack', requestId: 'original' }),
      },
    });
    expect(restored.result).toHaveBeenCalledOnce();
    expect(restored.saved().normal.entries).toHaveLength(0);
    expect(restored.frames('delivery-receipt')).toHaveLength(1);
    const polls = restored.frames('delivery-open').length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(restored.frames('delivery-open')).toHaveLength(polls);
  }
});
it('rolls back sequence allocation when publication cannot be committed', async () => {
  const h = harness();
  await h.connect(window(0, 0));
  await h.sender.submit(command('one'));
  // WINDOW commits first; the next commit would publish the command.
  h.storage.record
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('disk full'));
  await expect(
    h.sender.receive({
      type: 'delivery-window',
      lane: 'normal',
      window: window(),
    }),
  ).rejects.toThrow('disk full');
  expect(h.frames('delivery-command')).toHaveLength(0);
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(),
  });
  expect(h.frames('delivery-command')[0].seq).toBe(1);
});
it('keeps priority capacity when the normal outbox is full and has no credit', async () => {
  const h = harness();
  await h.connect(window(0, 0));
  for (let i = 0; i < 96; i++) await h.sender.submit(command('queued-' + i));
  await expect(h.sender.submit(command('overflow'))).rejects.toThrow('full');
  await h.sender.submit({ action: 'interrupt', requestId: 'cancel' });
  expect(h.frames('delivery-command')).toHaveLength(1);
  expect(h.frames('delivery-command')[0].lane).toBe('priority');
  expect(h.saved().normal.next).toBe(0);
});
it('ignores older online ACKs while preserving larger credit and validates byte boundaries', async () => {
  const h = harness();
  await h.connect();
  await h.sender.submit(command('one'));
  await h.sender.submit(command('two'));
  const [one, two] = h.frames('delivery-command');
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(2, 5, two.end),
  });
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(1, 3, one.end),
  });
  expect(h.saved().normal.received).toBe(2);
  await expect(
    h.sender.receive({
      type: 'delivery-window',
      lane: 'normal',
      window: window(2, 5, two.end - 1),
    }),
  ).rejects.toThrow('byte position');
  expect(h.saved().normal.receivedBytes).toBe(two.end);
  for (const id of ['three', 'four', 'five'])
    await h.sender.submit(command(id));
  expect(h.frames('delivery-command')).toHaveLength(5);
});
it('rejects an ACK between published byte boundaries and beyond the published head', async () => {
  const h = harness();
  await h.connect();
  await h.sender.submit(command('one'));
  const [one] = h.frames('delivery-command');
  await expect(
    h.sender.receive({
      type: 'delivery-window',
      lane: 'normal',
      window: window(1, 5, one.end - 1),
    }),
  ).rejects.toThrow('boundary');
  await expect(
    h.sender.receive({
      type: 'delivery-window',
      lane: 'normal',
      window: window(2, 5, one.end),
    }),
  ).rejects.toThrow('inconsistent');
});
it('retains a result until persistence and applies a duplicate result only once', async () => {
  const h = harness();
  await h.connect();
  await h.sender.submit(command('one'));
  const end = h.saved().normal.bytes;
  const result = {
    type: 'delivery-result',
    lane: 'normal',
    window: window(1, 2, end),
    ...resultFields({ type: 'ack', requestId: 'one' }),
  };
  h.storage.record.mockRejectedValueOnce(new Error('disk full'));
  await expect(h.sender.receive(result)).rejects.toThrow('disk full');
  expect(h.result).not.toHaveBeenCalled();
  expect(h.saved().normal.entries).toHaveLength(1);
  await h.sender.receive(result);
  await h.sender.receive(result);
  expect(h.result).toHaveBeenCalledOnce();
  expect(h.saved().normal.entries).toHaveLength(0);
});
it('drops queued callbacks and snapshots from retired connections', async () => {
  const h = harness();
  await h.connect();
  await h.sender.submit(command('one'));
  const old = h.exchange(),
    end = h.saved().normal.bytes;
  const late = h.sender.receive({
    type: 'delivery-result',
    lane: 'normal',
    window: window(1, 2, end),
    ...resultFields({ type: 'ack', requestId: 'one' }),
  });
  h.sender.disconnect();
  await late;
  expect(h.result).not.toHaveBeenCalled();
  await h.sender.connect(h.wire);
  await h.snapshot('normal', window(1, 2, end), old);
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(1, 2, end),
  });
  expect(h.saved().normal.received).toBe(0);
  await h.snapshot();
  await h.snapshot('priority', { ...window(), stream: 'priority-receiver' });
});
it('freezes on a current authoritative rollback, but not an old ACK received before recovery', async () => {
  const h = harness();
  await h.connect();
  await h.sender.submit(command('one'));
  const end = h.saved().normal.bytes;
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(1, 2, end),
  });
  h.sender.disconnect();
  await h.sender.connect(h.wire);
  await h.sender.receive({
    type: 'delivery-window',
    lane: 'normal',
    window: window(),
  });
  await expect(h.snapshot()).rejects.toThrow('journal changed');
  await expect(h.sender.submit(command('two'))).rejects.toThrow(
    'journal changed',
  );
  await expect(h.sender.connect(h.wire)).rejects.toThrow('journal changed');
});
it('freezes when the receiver storage instance changes', async () => {
  const h = harness();
  await h.connect();
  h.sender.disconnect();
  await h.sender.connect(h.wire);
  await expect(
    h.snapshot('normal', { ...window(), instance: 'replacement' }),
  ).rejects.toThrow('journal changed');
});
it('coalesces HTTP recovery and binds reads to the current exchange', async () => {
  const memory: any = {};
  let release!: (value: unknown) => void;
  const read = vi.fn(
    async (
      _stream: string,
      lane: string,
      _seq?: number,
      exchangeId?: string,
    ): Promise<any> => ({ exchangeId, window: { ...window(), stream: lane } }),
  );
  read.mockImplementationOnce(
    (_stream, _lane, _seq, exchangeId) =>
      new Promise((resolve) => {
        release = (v: any) => resolve({ ...v, exchangeId });
      }),
  );
  const wire = vi.fn();
  const sender = new CommandDelivery(
    {
      record: async (key, value) =>
        value === undefined
          ? memory[key]
          : (memory[key] = structuredClone(value)),
    },
    vi.fn(),
    { read, send: vi.fn().mockResolvedValue(undefined) },
  );
  active.push(sender);
  await sender.connect(wire);
  const first = sender.refresh();
  expect(sender.refresh()).toBe(first);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  release({ window: { ...window(), stream: 'priority' } });
  await first;
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[0][3]).toBe(wire.mock.calls[0][0].exchangeId);
});
it('continues slow recovery after fast retries, even without new business', async () => {
  const h = harness();
  await h.connect(window(0, 0));
  await h.sender.submit(command('one'));
  const before = h.frames('delivery-open').length;
  await vi.advanceTimersByTimeAsync(240000);
  expect(h.frames('delivery-open').length).toBeGreaterThan(before + 5);
  expect(h.saved().normal.entries).toHaveLength(1);
  expect(h.saved().normal.next).toBe(0);
});
it('stops scheduling after recovery finishes with no pending work', async () => {
  const h = harness();
  await h.connect();
  const before = h.wire.mock.calls.length;
  await vi.advanceTimersByTimeAsync(240000);
  expect(h.wire.mock.calls.length).toBe(before);
});

it('rejects cross-stream snapshots after reconnect even when the Agent instance matches', async () => {
  const h = harness();
  await h.connect();
  await h.sender.submit(command('one'));
  h.sender.disconnect();
  await h.sender.connect(h.wire);
  await expect(
    h.snapshot('normal', { ...window(), stream: 'foreign-stream' }),
  ).rejects.toThrow('stream changed');
  expect(h.frames('delivery-command')).toHaveLength(1);
  await h.snapshot();
  await h.snapshot('priority', { ...window(), stream: 'priority-receiver' });
  expect(h.frames('delivery-command')).toHaveLength(2);
});

it('commits complete transfer content before ACK/UI, including a failed receiver commit and lost ACK', async () => {
  const payload = {
    type: 'ack',
    requestId: 'large',
    text: '你好'.repeat(50000),
  };
  const full = JSON.stringify(payload);
  const digest = createHash('sha256').update(full).digest('hex');
  const descriptor = {
    type: 'delivery-content',
    retention: 'transfer',
    contentId: digest,
    digest,
    revision: 1,
    length: Buffer.byteLength(full),
  };
  const read = vi.fn(async (_stream, _lane, _instance, resultSeq, offset) => {
    const bytes = Buffer.from(full);
    let next = Math.min(bytes.length, offset + 16384);
    while (next < bytes.length && (bytes[next] & 0xc0) === 0x80) next--;
    return {
      window: window(),
      content: {
        resultSeq,
        offset,
        next,
        length: bytes.length,
        body: bytes.subarray(offset, next).toString('utf8'),
      },
    };
  });
  const h = harness(undefined, read);
  await h.connect();
  await h.sender.submit(command('large'));
  const end = h.saved().normal.bytes;
  const result = {
    type: 'delivery-result',
    lane: 'normal',
    window: window(1, 2, end),
    ...resultFields(descriptor),
  };
  h.storage.record.mockRejectedValueOnce(new Error('disk full'));
  await expect(h.sender.receive(result)).rejects.toThrow('disk full');
  expect(h.result).not.toHaveBeenCalled();
  expect(h.frames('delivery-receipt')).toHaveLength(0);
  expect(h.saved().normal.results.received).toBe(0);
  await h.sender.receive(result);
  const reads = read.mock.calls.length;
  expect(h.saved().normal.results.cache[0].content).toBe(full);
  expect(h.result).toHaveBeenCalledWith(payload);
  expect(h.frames('delivery-receipt').at(-1).received).toBe(1);
  await h.sender.receive(result);
  expect(read).toHaveBeenCalledTimes(reads);
  expect(h.result).toHaveBeenCalledOnce();
  expect(h.frames('delivery-receipt')).toHaveLength(2);
});

it('freezes on the current Agent reset but discards a reset from a retired exchange', async () => {
  const h = harness();
  await h.connect();
  await h.sender.submit(command('pending'));
  const old = h.exchange();
  h.sender.disconnect();
  await h.sender.connect(h.wire);
  const reset = {
    type: 'delivery-reset',
    lane: 'normal',
    exchangeId: old,
    error: {
      code: 'DELIVERY_STATE_MISMATCH',
      message: 'Receiver lost confirmed results',
    },
  };
  await h.sender.receive(reset);
  expect(h.saved().normal.entries).toHaveLength(1);
  await expect(
    h.sender.receive({ ...reset, exchangeId: h.exchange() }),
  ).rejects.toThrow('lost confirmed results');
  await expect(h.sender.connect(h.wire)).rejects.toThrow(
    'lost confirmed results',
  );
  await expect(h.sender.submit(command('another'))).rejects.toThrow(
    'lost confirmed results',
  );
  expect(h.frames('delivery-command')).toHaveLength(1);
});

it('persists the control claim before attaching and requires matching Agent readiness on both lanes', async () => {
  const h = harness();
  const claim = await h.sender.claim();
  expect(h.saved().claimId).toBe(claim.claimId);
  const proof = {
    controlEpoch: 4,
    connectionGeneration: 9,
    controlId: claim.claimId,
    owner: 'owner',
  };
  await h.sender.connect(h.wire, { control: proof, controller: 'controller' });
  await h.sender.submit(command('protected'));
  const snapshot = (lane: string, controlReady?: any) =>
    h.sender.receive({
      type: 'delivery-window',
      lane,
      exchangeId: h.exchange(),
      window: { ...window(), stream: lane },
      controlReady,
    });
  await expect(snapshot('normal')).rejects.toThrow('confirmed');
  const ready = { ...proof, exchangeId: h.exchange(), instance: 'journal' };
  await expect(
    snapshot('normal', { ...ready, controlEpoch: 3 }),
  ).rejects.toThrow('confirmed');
  await snapshot('normal', ready);
  expect(h.frames('delivery-command')).toHaveLength(0);
  await snapshot('priority', ready);
  expect(h.frames('delivery-command')).toHaveLength(1);
  const restored = harness(h.saved());
  expect(await restored.sender.claim()).toEqual({
    delivery: 2,
    claimId: claim.claimId,
    resume: { stream: h.saved().stream, controller: 'controller' },
  });
});
it('isolates a takeover into a new flow while preserving pending old command identities', async () => {
  const h = harness();
  const first = {
    controlEpoch: 1,
    connectionGeneration: 1,
    controlId: 'first-claim',
    owner: 'owner',
  };
  await h.sender.connect(h.wire, {
    control: first,
    controller: 'first-controller',
  });
  await h.sender.submit(command('old-work'));
  const previous = h.saved();
  h.sender.disconnect();
  await h.sender.connect(h.wire, {
    control: {
      ...first,
      controlEpoch: 2,
      connectionGeneration: 2,
      controlId: 'next-claim',
    },
    controller: 'next-controller',
  });
  expect(h.saved().stream).not.toBe(previous.stream);
  expect(h.saved().normal.entries).toEqual([]);
  expect(h.saved().retired[0].normal.entries[0].body).toBe(
    previous.normal.entries[0].body,
  );
  expect(h.frames('delivery-command')).toHaveLength(0);
});

it('cancels an unpublished item durably without allocating a sequence or sending a remote cancellation', async () => {
  const h = harness();
  await h.connect(window(0, 0));
  await h.sender.submit(command('cancel-me'));
  expect(await h.sender.cancelUnpublished('cancel-me')).toBe(true);
  expect(h.saved().normal.next).toBe(0);
  expect(h.saved().normal.entries).toEqual([]);
  expect(h.saved().cancelled[0].requestId).toBe('cancel-me');
  expect(h.frames('delivery-command')).toEqual([]);
  const restored = harness(h.saved());
  await restored.connect();
  expect(restored.frames('delivery-command')).toEqual([]);
});
it('keeps cancelled identity refusals after diagnostic trimming and reconstruction', async () => {
  const h = harness();
  await h.connect(window(0, 0));
  for (let i = 0; i < 70; i++) {
    await h.sender.submit(command('retired-' + i));
    expect(await h.sender.cancelUnpublished('retired-' + i)).toBe(true);
  }
  expect(h.saved().cancelled).toHaveLength(64);
  expect(
    h.saved().cancelled.some((v: any) => v.requestId === 'retired-0'),
  ).toBe(false);
  expect(h.saved().cancelledKeys).toHaveLength(70);
  const restored = harness(h.saved());
  await restored.connect(window(0, 0));
  await expect(restored.sender.submit(command('retired-0'))).rejects.toThrow(
    'CANCELLED_BEFORE_START',
  );
  expect(restored.frames('delivery-command')).toEqual([]);
});
it('refuses cancellation when permanent identity capacity is full and retains the queued command', async () => {
  const initial = harness();
  await initial.connect(window(0, 0));
  const state = initial.saved();
  state.cancelledKeys = Array.from({ length: 1024 }, (_, i) =>
    createHash('sha256')
      .update('web:retired-' + i)
      .digest('hex'),
  );
  const h = harness(state);
  await h.connect(window(0, 0));
  await h.sender.submit(command('keep-queued'));
  const before = h.saved();
  await expect(h.sender.cancelUnpublished('keep-queued')).rejects.toThrow(
    'BACKPRESSURE',
  );
  expect(h.saved()).toEqual(before);
  await h.snapshot('normal', window());
  expect(JSON.parse(h.frames('delivery-command')[0].body).requestId).toBe(
    'keep-queued',
  );
  expect(h.saved().cancelledKeys).toHaveLength(1024);
});

it('serializes cancellation with publication and preserves already published commands', async () => {
  const h = harness();
  await h.connect();
  await h.sender.submit(command('published'));
  expect(await h.sender.cancelUnpublished('published')).toBe(false);
  expect(h.saved().normal.entries[0].seq).toBe(1);
  expect(h.saved().cancelled).toBeUndefined();
});
it('retains the original queued command if local cancellation cannot be committed', async () => {
  const h = harness();
  await h.connect(window(0, 0));
  await h.sender.submit(command('disk-failure'));
  const before = h.saved();
  h.storage.record.mockRejectedValueOnce(new Error('disk full'));
  await expect(h.sender.cancelUnpublished('disk-failure')).rejects.toThrow(
    'disk full',
  );
  expect(h.saved()).toEqual(before);
  await h.snapshot('normal', window());
  expect(h.frames('delivery-command')[0].seq).toBe(1);
});

it('does not resubmit a locally cancelled identity and refuses a changed claim at the same control epoch', async () => {
  const h = harness();
  const proof = {
    controlEpoch: 2,
    connectionGeneration: 3,
    controlId: 'claim',
    owner: 'owner',
  };
  await h.sender.connect(h.wire, { control: proof, controller: 'controller' });
  await h.sender.submit(command('cancelled'));
  await h.sender.cancelUnpublished('cancelled');
  await expect(h.sender.submit(command('cancelled'))).rejects.toThrow(
    'CANCELLED_BEFORE_START',
  );
  await expect(
    h.sender.connect(h.wire, {
      control: { ...proof, controlId: 'conflict', connectionGeneration: 4 },
      controller: 'other',
    }),
  ).rejects.toThrow('conflicts');
  expect(h.sender.ready).toBe(false);
});

it('retains the observed turn for a pending request with lost result without borrowing another task identity', async () => {
  const h = harness();
  const proof = {
    controlEpoch: 4,
    connectionGeneration: 9,
    controlId: 'claim',
    owner: 'owner',
  };
  await h.sender.connect(h.wire, { control: proof, controller: 'controller' });
  await h.sender.submit(command('pending'));
  for (const lane of ['normal', 'priority'])
    await h.sender.receive({
      type: 'delivery-window',
      lane,
      exchangeId: h.exchange(),
      window: { ...window(), stream: lane },
      controlReady: { ...proof, exchangeId: h.exchange(), instance: 'journal' },
    });
  const original = {
    controlEpoch: 4,
    instance: 'journal',
    owner: 'owner',
    requestId: 'web:pending',
    stream: 'normal',
  };
  expect(
    await h.sender.target('pending', { ...original, turnId: 'actual-turn' }),
  ).toEqual({ ...original, turnId: 'actual-turn' });
  for (const unrelated of [
    { owner: 'another' },
    { instance: 'another' },
    { controlEpoch: 5 },
    { stream: 'another' },
    { requestId: 'web:another' },
  ])
    expect(
      await h.sender.target('pending', {
        ...original,
        turnId: 'wrong-turn',
        ...unrelated,
      }),
    ).toEqual(original);
});

it('persists the receiver allocation and freezes a changed serial or credit generation after reconnect', async () => {
  for (const changed of [
    { streamSerial: 2 },
    { creditGeneration: 'another-generation' },
  ]) {
    const h = harness();
    await h.connect({
      ...window(),
      streamSerial: 1,
      creditGeneration: 'generation',
    } as any);
    await h.sender.submit(command('kept'));
    const saved = h.saved();
    expect(saved.normal.streamSerial).toBe(1);
    expect(saved.normal.creditGeneration).toBe('generation');
    const restored = harness(saved);
    await restored.sender.connect(restored.wire);
    await expect(
      restored.snapshot('normal', {
        ...window(),
        streamSerial: 1,
        creditGeneration: 'generation',
        ...changed,
      } as any),
    ).rejects.toThrow('journal changed');
    expect(restored.saved().normal.entries).toHaveLength(1);
    expect(restored.frames('delivery-command')).toHaveLength(0);
  }
});
