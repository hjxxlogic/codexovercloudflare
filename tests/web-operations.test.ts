import { afterEach, expect, it, vi } from 'vitest';
import { OperationClient } from '../apps/web/src/operations.ts';
import { ApiError, type OperationExchange } from '../apps/web/src/api.ts';

const owner = 'a'.repeat(64);
const clients: OperationClient[] = [];
class Journal {
  value: any;
  failure?: (next: any) => boolean;
  private tail: Promise<unknown> = Promise.resolve();
  async record() {
    return structuredClone(this.value);
  }
  updateRecord<T>(_key: string, update: (previous: unknown) => T): Promise<T> {
    const result = this.tail.then(() => {
      const next = update(structuredClone(this.value));
      if (this.failure?.(next)) throw new Error('Local storage failed');
      this.value = structuredClone(next);
      return next;
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
const direct = async <T>(_signal: AbortSignal, run: () => Promise<T>) => run();
function peer(journal = new Journal()) {
  let effects = 0,
    queryLoss = 0,
    ackLoss = 0;
  const originals = new Map<string, unknown>();
  const wires: { id: string; ack: boolean; body: unknown; instance: string }[] =
    [];
  const request = vi.fn(
    async (
      path: string,
      body?: any,
      _signal?: AbortSignal,
      id?: string,
      _headers?: unknown,
      exchange?: OperationExchange,
    ) => {
      if (path.endsWith('/probe'))
        return {
          deliveryInstance: 'agent-store',
          operationInstance: 'agent-store',
        };
      expect(exchange).toBeDefined();
      const record = journal.value.records[id!];
      expect(record.instance).toBe(exchange!.instance);
      expect(record.path).toBe(path);
      expect(record.body).toEqual(body);
      wires.push({
        id: id!,
        ack: !!exchange!.ack,
        body: structuredClone(body),
        instance: exchange!.instance,
      });
      if (exchange!.ack) {
        expect(record.state).toBe('completed');
        expect(record.result).toBeDefined();
        if (ackLoss-- > 0) throw new TypeError('Lost confirmation');
        await exchange!.commit(
          { data: { confirmed: true } },
          { requestId: id!, owner, instance: 'agent-store', ack: true },
        );
        return { confirmed: true };
      }
      if (!originals.has(id!)) {
        effects++;
        originals.set(id!, { id: 'host~' + id, projectId: body.projectId });
      }
      if (queryLoss-- > 0) throw new TypeError('Lost result');
      await exchange!.commit(
        { data: originals.get(id!) },
        { requestId: id!, owner, instance: 'agent-store' },
      );
      return originals.get(id!);
    },
  );
  function client(lock = direct) {
    const value = new OperationClient(journal, {
      host: 'host',
      owner,
      request,
      lock,
      random: () => 0,
    });
    clients.push(value);
    return value;
  }
  return {
    journal,
    request,
    wires,
    client,
    effects: () => effects,
    loseQueries: (n: number) => {
      queryLoss = n;
    },
    loseAcks: (n: number) => {
      ackLoss = n;
    },
  };
}
afterEach(() => {
  clients.splice(0).forEach((client) => client.stop());
  vi.useRealTimers();
});
it('rejects probes without an admission identity before sending a mutation', async () => {
  const h = peer();
  h.request.mockResolvedValue({ deliveryInstance: 'agent-store' });
  await expect(
    h.client().submit('/sessions', {}, 'unsupported'),
  ).rejects.toMatchObject({
    code: 'UPGRADE_REQUIRED',
    status: 426,
  });
  expect(h.effects()).toBe(0);
  expect(h.wires).toEqual([]);
  expect(h.request.mock.calls.every(([path]) => path.endsWith('/probe'))).toBe(
    true,
  );
  expect(h.journal.value.records.unsupported.instance).toBe('');
});
it('retires an expired original locally and permits the next independent request', async () => {
  const h = peer();
  const normal = h.request.getMockImplementation()!;
  h.request.mockImplementation(async (...args) => {
    if (args[3] === 'expired')
      throw new ApiError('REQUEST_EXPIRED', 'expired by Agent', 409);
    return normal(...args);
  });
  const client = h.client();
  await expect(client.submit('/sessions', {}, 'expired')).rejects.toThrow(
    'expired by Agent',
  );
  expect(h.journal.value.records.expired.state).toBe('confirmed');
  await expect(client.submit('/sessions', {}, 'next')).resolves.toMatchObject({
    id: 'host~next',
  });
  expect(h.effects()).toBe(1);
});
it('preserves the locally completed result when its Agent confirmation expires', async () => {
  const h = peer();
  const normal = h.request.getMockImplementation()!;
  h.request.mockImplementation(async (...args) => {
    if (args[5]?.ack)
      throw new ApiError('REQUEST_EXPIRED', 'confirmation expired', 409);
    return normal(...args);
  });
  const client = h.client();
  await expect(
    client.submit('/sessions', {}, 'completed'),
  ).resolves.toMatchObject({ id: 'host~completed' });
  await vi.waitFor(() =>
    expect(h.journal.value.records.completed.state).toBe('confirmed'),
  );
  expect(h.journal.value.records.completed.result).toEqual({
    data: { id: 'host~completed' },
  });
  await expect(client.resume('completed')).resolves.toMatchObject({
    id: 'host~completed',
  });
  expect(h.effects()).toBe(1);
});
it('persists a fixed original before wire and its complete result before confirmation', async () => {
  const h = peer(),
    client = h.client();
  const body = { projectId: 'project' };
  const sending = client.submit('/sessions', body, 'original');
  body.projectId = 'mutated-after-submit';
  await expect(sending).resolves.toEqual({
    id: 'host~original',
    projectId: 'project',
  });
  await vi.waitFor(() =>
    expect(h.journal.value.records.original.state).toBe('confirmed'),
  );
  expect(h.wires.map((wire) => wire.ack)).toEqual([false, true]);
  expect(h.journal.value.records.original.body).toBeUndefined();
  const count = h.request.mock.calls.length;
  await expect(client.resume('original')).resolves.toMatchObject({
    id: 'host~original',
  });
  expect(h.request).toHaveBeenCalledTimes(count);
  await expect(
    client.submit('/sessions', { projectId: 'changed' }, 'original'),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(h.effects()).toBe(1);
});
it('recovers lost original results and confirmations using only the fixed original identity', async () => {
  vi.useFakeTimers();
  const h = peer(),
    client = h.client();
  h.loseQueries(1);
  h.loseAcks(1);
  const sending = client.submit(
    '/sessions',
    { projectId: 'project' },
    'original',
  );
  await vi.waitFor(() => expect(h.wires).toHaveLength(1));
  expect(h.journal.value.records.original.state).toBe('pending');
  await vi.advanceTimersByTimeAsync(1000);
  await expect(sending).resolves.toMatchObject({ id: 'host~original' });
  await vi.waitFor(() => expect(h.wires).toHaveLength(3));
  expect(h.journal.value.records.original.state).toBe('completed');
  await vi.advanceTimersByTimeAsync(1000);
  await vi.waitFor(() =>
    expect(h.journal.value.records.original.state).toBe('confirmed'),
  );
  expect(h.wires.map((wire) => wire.ack)).toEqual([false, false, true, true]);
  expect(new Set(h.wires.map((wire) => wire.id)).size).toBe(1);
  expect(h.effects()).toBe(1);
  const count = h.request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120000);
  expect(h.request).toHaveBeenCalledTimes(count);
});
it('keeps pending originals across page closure and resumes the same receiver instance', async () => {
  vi.useFakeTimers();
  const h = peer(),
    first = h.client();
  h.loseQueries(1);
  const sending = first
    .submit('/sessions', { projectId: 'project' }, 'original')
    .catch((error) => error);
  await vi.waitFor(() => expect(h.wires).toHaveLength(1));
  first.stop();
  expect((await sending).name).toBe('AbortError');
  const second = h.client();
  await expect(second.resume('original')).resolves.toMatchObject({
    id: 'host~original',
  });
  await vi.waitFor(() =>
    expect(h.journal.value.records.original.state).toBe('confirmed'),
  );
  expect(h.effects()).toBe(1);
  expect(
    h.request.mock.calls.filter(([path]) => path.endsWith('/probe')),
  ).toHaveLength(1);
  expect(h.wires.every((wire) => wire.instance === 'agent-store')).toBe(true);
});
it('continues slow recovery after the finite fast phase and stops when idle', async () => {
  vi.useFakeTimers();
  const h = peer(),
    client = h.client();
  h.loseQueries(4);
  const sending = client.submit('/sessions', {}, 'original');
  await vi.waitFor(() => expect(h.wires).toHaveLength(1));
  for (const [delay, count] of [
    [1000, 2],
    [2000, 3],
    [4000, 4],
  ]) {
    await vi.advanceTimersByTimeAsync(delay);
    await vi.waitFor(() => expect(h.wires).toHaveLength(count));
  }
  await vi.advanceTimersByTimeAsync(29000);
  expect(h.wires).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(sending).resolves.toMatchObject({ id: 'host~original' });
  await vi.waitFor(() =>
    expect(h.journal.value.records.original.state).toBe('confirmed'),
  );
  expect(h.effects()).toBe(1);
});
it('rejects first-wire and terminal storage failure without acknowledging unsaved results', async () => {
  const h = peer(),
    first = h.client();
  h.journal.failure = () => true;
  await expect(first.submit('/sessions', {}, 'first-failure')).rejects.toThrow(
    'Local storage failed',
  );
  expect(h.wires).toHaveLength(0);
  h.journal.failure = (next) => next.records.original?.state === 'completed';
  const second = h.client();
  await expect(second.submit('/sessions', {}, 'original')).rejects.toThrow(
    'Local storage failed',
  );
  expect(h.journal.value.records.original.state).toBe('pending');
  expect(h.wires.some((wire) => wire.ack)).toBe(false);
  h.journal.failure = undefined;
  const restored = h.client();
  await expect(restored.resume('original')).resolves.toMatchObject({
    id: 'host~original',
  });
  await vi.waitFor(() =>
    expect(h.journal.value.records.original.state).toBe('confirmed'),
  );
  expect(h.effects()).toBe(1);
});
it('persists an instance conflict pause and never rebinds a saved intention after reload', async () => {
  vi.useFakeTimers();
  const h = peer(),
    client = h.client();
  const request = h.request.getMockImplementation()!;
  h.request.mockImplementation(async (...args) => {
    if (args[0].endsWith('/probe')) return request(...args);
    throw new ApiError('DELIVERY_STATE_MISMATCH', 'Agent store changed', 409);
  });
  await expect(
    client.submit('/sessions', {}, 'original'),
  ).rejects.toMatchObject({ code: 'DELIVERY_STATE_MISMATCH' });
  await vi.waitFor(() =>
    expect(h.journal.value.paused?.code).toBe('DELIVERY_STATE_MISMATCH'),
  );
  const restored = h.client();
  await restored.start();
  await expect(restored.resume('original')).rejects.toMatchObject({
    code: 'DELIVERY_STATE_MISMATCH',
  });
  expect(h.journal.value.records.original.instance).toBe('agent-store');
  const count = h.request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120000);
  expect(h.request).toHaveBeenCalledTimes(count);
});
it('does not interpret a retired result or full identity budget as a new intention', async () => {
  const h = peer();
  h.journal.value = { version: 2, host: 'host', owner, order: [], records: {} };
  for (let i = 0; i < 1024; i++) {
    const id = 'retired-' + i;
    h.journal.value.order.push(id);
    h.journal.value.records[id] = {
      requestId: id,
      path: '/sessions',
      digest: 'retired',
      instance: 'agent-store',
      state: 'confirmed',
    };
  }
  const client = h.client();
  await expect(client.resume('retired-0')).rejects.toMatchObject({
    code: 'RESULT_UNAVAILABLE',
  });
  await expect(client.submit('/sessions', {}, 'extra')).rejects.toMatchObject({
    code: 'BACKPRESSURE',
  });
  expect(h.wires).toHaveLength(0);
  expect((await h.journal.record()).order).toHaveLength(1024);
});
it('treats prototype-looking request ids as ordinary isolated identities', async () => {
  const h = peer(),
    client = h.client();
  for (const id of ['constructor', '__proto__']) {
    await expect(client.submit('/sessions', {}, id)).resolves.toMatchObject({
      id: 'host~' + id,
    });
    await vi.waitFor(() =>
      expect(h.journal.value.records[id].state).toBe('confirmed'),
    );
  }
  expect(h.journal.value.order).toEqual(['constructor', '__proto__']);
  expect(h.effects()).toBe(2);
});
it('serializes two clients sharing an intention without overwriting or executing it twice', async () => {
  const h = peer();
  let tail: Promise<unknown> = Promise.resolve();
  const lock = <T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
    const next = tail.then(() => {
      if (signal.aborted) throw signal.reason;
      return run();
    });
    tail = next.catch(() => {});
    return next;
  };
  const first = h.client(lock),
    second = h.client(lock);
  const results = await Promise.all([
    first.submit('/sessions', { projectId: 'project' }, 'shared'),
    second.submit('/sessions', { projectId: 'project' }, 'shared'),
  ]);
  expect(results[0]).toEqual(results[1]);
  await vi.waitFor(() =>
    expect(h.journal.value.records.shared.state).toBe('confirmed'),
  );
  expect(h.journal.value.order).toEqual(['shared']);
  expect(h.effects()).toBe(1);
  expect(h.wires.filter((wire) => !wire.ack)).toHaveLength(1);
  expect(h.wires.filter((wire) => wire.ack)).toHaveLength(1);
});
it('compacts the result tail while preserving the original identity refusal boundary', async () => {
  const h = peer(),
    client = h.client();
  for (let i = 0; i < 20; i++) {
    await client.submit('/sessions', {}, 'completed-' + i);
    await vi.waitFor(() =>
      expect(h.journal.value.records['completed-' + i].state).toBe('confirmed'),
    );
  }
  expect(
    Object.values(h.journal.value.records).filter(
      (record: any) => record.result,
    ),
  ).toHaveLength(16);
  const calls = h.request.mock.calls.length;
  await expect(client.resume('completed-0')).rejects.toMatchObject({
    code: 'RESULT_UNAVAILABLE',
  });
  await expect(
    client.submit('/sessions', {}, 'completed-0'),
  ).rejects.toMatchObject({ code: 'RESULT_UNAVAILABLE' });
  expect(h.request).toHaveBeenCalledTimes(calls);
  expect(h.effects()).toBe(20);
});
