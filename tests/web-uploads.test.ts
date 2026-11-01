import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { OperationClient } from '../apps/web/src/operations.ts';
import {
  prepareUpload,
  resumeUpload,
  uploadRecords,
} from '../apps/web/src/uploads.ts';
import { api, ApiError, type OperationExchange } from '../apps/web/src/api.ts';
vi.mock('../apps/web/src/api.ts', async (original) => ({
  ...(await original<typeof import('../apps/web/src/api.ts')>()),
  api: vi.fn(),
}));
const owner = 'a'.repeat(64),
  uploadKey = 'delivery-outbox-upload:v2';
const clients: OperationClient[] = [];
class Journal {
  values = new Map<string, any>();
  failure?: (key: string, next: any) => boolean;
  private tail: Promise<unknown> = Promise.resolve();
  async record(key: string) {
    return structuredClone(this.values.get(key));
  }
  updateRecord<T>(key: string, change: (previous: unknown) => T): Promise<T> {
    const result = this.tail.then(() => {
      const next = change(structuredClone(this.values.get(key)));
      if (this.failure?.(key, next)) throw new Error('Storage failed');
      this.values.set(key, structuredClone(next));
      return next;
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
const direct = async <T>(_signal: AbortSignal, run: () => Promise<T>) => run();
beforeEach(() => {
  vi.stubGlobal('navigator', {
    locks: {
      request: async (_key: string, options: any, run: () => Promise<any>) => {
        options.signal?.throwIfAborted();
        return run();
      },
    },
  });
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.stop());
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(api).mockReset();
});
function harness() {
  const journal = new Journal();
  const data = Buffer.alloc(150000, 197);
  const sha256 = createHash('sha256').update(data).digest('hex');
  let offset = 0,
    begins = 0,
    publishes = 0,
    loseChunk = false,
    lostChunk = false;
  let remoteState = 'uploading',
    instance = 'agent-store';
  const chunks: number[] = [],
    confirmations: string[] = [];
  const request = vi.fn(
    async (
      path: string,
      body?: any,
      _signal?: AbortSignal,
      id?: string,
      _headers?: unknown,
      exchange?: OperationExchange,
    ) => {
      if (path.endsWith('/probe')) return { deliveryInstance: instance };
      const stored = (await uploadRecords(journal))[0];
      if (body.agentInstance && body.agentInstance !== instance)
        throw new ApiError('DELIVERY_STATE_MISMATCH', 'Replaced Agent', 409);
      if (exchange?.ack) {
        confirmations.push(body.operation);
        await exchange.commit(
          { data: { confirmed: true } },
          { requestId: id!, instance: exchange.instance, owner, ack: true },
        );
        return { confirmed: true };
      }
      expect(stored.chunks?.join('')).toBeDefined();
      let result: any;
      if (body.operation === 'begin') {
        expect(stored.phase).toBe('queued');
        expect(stored.size).toBe(data.length);
        expect(stored.sha256).toBe(sha256);
        begins++;
        result = { offset, window: 4 };
      } else if (body.operation === 'status')
        result = { state: remoteState, offset, sha256, size: data.length };
      else if (body.operation === 'chunk') {
        const bytes = Buffer.from(body.data, 'base64');
        expect(bytes).toEqual(
          data.subarray(body.offset, body.offset + bytes.length),
        );
        if (body.offset === offset) {
          chunks.push(body.offset);
          offset += bytes.length;
        } else expect(body.offset + bytes.length).toBeLessThanOrEqual(offset);
        if (loseChunk) {
          loseChunk = false;
          lostChunk = true;
          throw new TypeError('Lost chunk response');
        }
        result = { offset };
      } else if (body.operation === 'finish') {
        expect(offset).toBe(data.length);
        expect(body.sha256).toBe(sha256);
        expect(stored.phase).toBe('finishing');
        publishes++;
        remoteState = 'completed';
        result = { state: 'completed', sha256, size: data.length };
      } else throw new Error('Unexpected operation');
      if (exchange)
        await exchange.commit(
          { data: result },
          { requestId: id!, instance: exchange.instance, owner },
        );
      return result;
    },
  );
  vi.mocked(api).mockImplementation(request);
  function client() {
    const operations = new OperationClient(journal, {
      host: 'host',
      owner,
      lock: direct,
      request,
    });
    clients.push(operations);
    return operations;
  }
  async function prepare(
    operations: OperationClient,
    signal = new AbortController().signal,
  ) {
    return prepareUpload(
      journal,
      operations,
      new Blob([new Uint8Array(data)]),
      { host: 'host', project: 'project', path: 'proof.bin', overwrite: false },
      signal,
    );
  }
  return {
    journal,
    data,
    sha256,
    request,
    client,
    prepare,
    chunks,
    confirmations,
    begins: () => begins,
    publishes: () => publishes,
    lost: () => lostChunk,
    lose: () => {
      loseChunk = true;
    },
    unknown: () => {
      remoteState = 'unknown';
    },
    replace: () => {
      instance = 'replacement-store';
    },
  };
}
it('persists the complete fixed file before begin and confirms only a verified published result', async () => {
  const h = harness(),
    client = h.client();
  const id = await h.prepare(client);
  expect(h.request).not.toHaveBeenCalled();
  const result = await resumeUpload(
    h.journal,
    client,
    id,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    state: 'completed',
    size: h.data.length,
    sha256: h.sha256,
  });
  expect(h.begins()).toBe(1);
  expect(h.publishes()).toBe(1);
  expect(h.chunks).toEqual([0, 65536, 131072]);
  const stored = (await uploadRecords(h.journal))[0];
  expect(stored.phase).toBe('completed');
  expect(stored.chunks).toBeUndefined();
  await vi.waitFor(() => expect(h.confirmations).toContain('finish'));
  const count = h.request.mock.calls.length;
  await expect(
    resumeUpload(h.journal, client, id, new AbortController().signal),
  ).resolves.toEqual(result);
  expect(h.request).toHaveBeenCalledTimes(count);
});
it('retains the original full file when paused after a lost chunk and resumes the fixed instance and offset', async () => {
  vi.useFakeTimers();
  const h = harness(),
    first = h.client();
  const id = await h.prepare(first);
  h.lose();
  const controller = new AbortController();
  const sending = resumeUpload(h.journal, first, id, controller.signal).catch(
    (error) => error,
  );
  await vi.waitFor(() => expect(h.lost()).toBe(true));
  controller.abort();
  expect((await sending).name).toBe('AbortError');
  first.stop();
  expect((await uploadRecords(h.journal))[0]).toMatchObject({
    phase: 'uploading',
    instance: 'agent-store',
  });
  const second = h.client();
  await expect(
    resumeUpload(h.journal, second, id, new AbortController().signal),
  ).resolves.toMatchObject({ sha256: h.sha256 });
  expect(h.begins()).toBe(1);
  expect(h.publishes()).toBe(1);
  expect(h.chunks).toEqual([0, 65536, 131072]);
});
it('does not send a begin when the full-body admission fails or the saved body is corrupted', async () => {
  const h = harness(),
    client = h.client();
  h.journal.failure = (key) => key === uploadKey;
  await expect(h.prepare(client)).rejects.toThrow('Storage failed');
  expect(h.request).not.toHaveBeenCalled();
  h.journal.failure = undefined;
  const id = await h.prepare(client);
  h.journal.values.get(uploadKey).records[0].chunks[0] = 'AAAA';
  await expect(
    resumeUpload(h.journal, client, id, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'DELIVERY_STATE_MISMATCH' });
  expect(h.request).not.toHaveBeenCalled();
  expect((await uploadRecords(h.journal))[0].phase).toBe('unknown');
});
it('recovers a local final journal commit failure without publishing the file twice', async () => {
  const h = harness(),
    client = h.client();
  const id = await h.prepare(client);
  h.journal.failure = (key, next) =>
    key === uploadKey && next.records[0].phase === 'completed';
  await expect(
    resumeUpload(h.journal, client, id, new AbortController().signal),
  ).rejects.toThrow('Storage failed');
  expect(h.publishes()).toBe(1);
  expect((await uploadRecords(h.journal))[0]).toMatchObject({
    phase: 'finishing',
    sha256: h.sha256,
  });
  h.journal.failure = undefined;
  await expect(
    resumeUpload(h.journal, client, id, new AbortController().signal),
  ).resolves.toMatchObject({ sha256: h.sha256 });
  expect(h.publishes()).toBe(1);
  expect((await uploadRecords(h.journal))[0].chunks).toBeUndefined();
});
it.each(['unknown', 'replacement'] as const)(
  'freezes an original upload on %s without publishing or creating a new intention',
  async (mode) => {
    vi.useFakeTimers();
    const h = harness(),
      first = h.client();
    const id = await h.prepare(first);
    h.lose();
    const controller = new AbortController();
    const sending = resumeUpload(h.journal, first, id, controller.signal).catch(
      () => {},
    );
    await vi.waitFor(() => expect(h.lost()).toBe(true));
    controller.abort();
    await sending;
    first.stop();
    if (mode === 'unknown') h.unknown();
    else h.replace();
    const second = h.client();
    await expect(
      resumeUpload(h.journal, second, id, new AbortController().signal),
    ).rejects.toBeInstanceOf(ApiError);
    expect((await uploadRecords(h.journal))[0].phase).toBe('unknown');
    expect(h.publishes()).toBe(0);
    expect(h.begins()).toBe(1);
    const count = h.request.mock.calls.length;
    await expect(h.prepare(second)).rejects.toMatchObject({
      code: 'BACKPRESSURE',
    });
    expect(h.request).toHaveBeenCalledTimes(count);
  },
);

it.each(['begin', 'finish'] as const)(
  'recovers the original staging identity after the confirmed %s result tail was retired',
  async (step) => {
    const h = harness(),
      client = h.client();
    const id = await h.prepare(client);
    h.journal.failure = (key, next) =>
      key === uploadKey &&
      next.records[0].phase === (step === 'begin' ? 'uploading' : 'completed');
    await expect(
      resumeUpload(h.journal, client, id, new AbortController().signal),
    ).rejects.toThrow('Storage failed');
    await vi.waitFor(() => expect(h.confirmations).toContain(step));
    const ledger = h.journal.values.get('delivery-outbox-http:v2');
    delete ledger.records[id + '-' + step].result;
    h.journal.failure = undefined;
    await expect(
      resumeUpload(h.journal, client, id, new AbortController().signal),
    ).resolves.toMatchObject({ sha256: h.sha256 });
    expect(h.begins()).toBe(1);
    expect(h.publishes()).toBe(1);
  },
);
