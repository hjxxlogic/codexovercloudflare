import { deliveryDigest } from '../../../packages/protocol/src/delivery.ts';
import { recoveryDelay } from './recovery.ts';
import { api, ApiError, retryable } from './api.ts';
import type { HistoryCache } from './history.ts';
import {
  idSchema,
  MAX_FRAME,
  type OperationIntent,
} from '../../../packages/protocol/src/index.ts';

const key = 'delivery-outbox-http:v2';
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const canonical = (value: any): any =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((name) => [name, canonical(value[name])]),
        )
      : value;
function digest(value: unknown) {
  return deliveryDigest(JSON.stringify(canonical(value)));
}

type Envelope = {
  data?: any;
  error?: { code: string; message: string; status?: number };
};
export type OriginalOperation = {
  requestId: string;
  path: string;
  body?: Record<string, unknown>;
  digest: string;
  instance: string;
  state: 'pending' | 'completed' | 'confirmed';
  result?: Envelope;
  receipt?: OperationIntent;
  meta?: Record<string, unknown>;
};
type State = {
  version: 2;
  host: string;
  owner: string;
  order: string[];
  records: Record<string, OriginalOperation>;
  paused?: { code: string; message: string };
};
type Journal = Pick<HistoryCache, 'record' | 'updateRecord'>;
type Lock = <T>(signal: AbortSignal, run: () => Promise<T>) => Promise<T>;
type Options = {
  host: string;
  owner: string;
  admin?: boolean;
  request?: typeof api;
  lock?: Lock;
  random?: () => number;
  changed?: (record: OriginalOperation) => void;
};
// Web Locks serialize each authenticated peer across tabs. Four stable buckets
// bound concurrent original-operation exchanges for the whole browser origin.
const peerLock =
  (owner: string, host: string): Lock =>
  async (signal, run) => {
    if (!globalThis.navigator?.locks)
      throw new ApiError(
        'STORAGE_REQUIRED',
        'This browser cannot serialize durable original requests',
        409,
      );
    const scope = JSON.stringify([owner, host]);
    const bucket = parseInt((await digest(scope)).slice(0, 4), 16) % 4;
    return navigator.locks.request(
      'coc-operation-peer:' + scope,
      { signal },
      () =>
        navigator.locks.request(
          'coc-operation-slot:' + bucket,
          { signal },
          run,
        ),
    );
  };
export class OperationClient {
  private preparing = 0;
  private request: typeof api;
  private lock: Lock;
  private current?: AbortController;
  private running = false;
  private stopped = false;
  private frozen?: Error;
  private attempts = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private published = new Set<string>();
  private channel?: BroadcastChannel;
  private waiters = new Map<
    string,
    { resolve: (result: any) => void; reject: (error: unknown) => void }[]
  >();
  constructor(
    private journal: Journal,
    private options: Options,
  ) {
    idSchema.parse(options.host);
    if (!/^[a-f0-9]{64}$/.test(options.owner))
      throw new Error('Invalid operation owner');
    this.request = options.request ?? api;
    this.lock = options.lock ?? peerLock(options.owner, options.host);
    if (!options.lock && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(
        'coc-http-operations:' + JSON.stringify([options.owner, options.host]),
      );
      this.channel.onmessage = () => this.kick();
    }
  }
  get peerKey() {
    return JSON.stringify([this.options.owner, this.options.host]);
  }
  async exchange<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    this.check();
    return this.lock(signal, async () => {
      this.check();
      return run();
    });
  }
  private state(input: unknown): State {
    if (input === undefined || input === null)
      return {
        version: 2,
        host: this.options.host,
        owner: this.options.owner,
        order: [],
        records: {},
      };
    const state = input as State;
    if (
      state.version !== 2 ||
      state.host !== this.options.host ||
      state.owner !== this.options.owner ||
      !Array.isArray(state.order) ||
      state.order.length > 1024 ||
      !state.records ||
      Object.keys(state.records).length !== state.order.length ||
      new Set(state.order).size !== state.order.length ||
      state.order.some(
        (id) =>
          !idSchema.safeParse(id).success ||
          !Object.hasOwn(state.records, id) ||
          !state.records[id] ||
          typeof state.records[id] !== 'object' ||
          state.records[id].requestId !== id ||
          !['pending', 'completed', 'confirmed'].includes(
            state.records[id].state,
          ),
      )
    )
      throw new ApiError(
        'DELIVERY_STATE_MISMATCH',
        'Invalid durable original operation journal',
        409,
      );
    return state;
  }
  private async read() {
    return this.state(await this.journal.record(key));
  }
  private async update(change: (state: State) => void) {
    const result = await this.journal.updateRecord(key, (previous) => {
      const state = this.state(previous);
      change(state);
      return state;
    });
    this.channel?.postMessage('dirty');
    return result;
  }
  async records() {
    const state = await this.read();
    return state.order.map((id) => state.records[id]);
  }
  async start() {
    const state = await this.read();
    if (state.paused) {
      this.freeze(new ApiError(state.paused.code, state.paused.message, 409));
      return;
    }
    this.kick();
  }
  async submit(
    path: string,
    body: Record<string, unknown>,
    requestId: string = crypto.randomUUID(),
    meta?: Record<string, unknown>,
    expectedInstance?: string,
    signal?: AbortSignal,
  ) {
    this.check();
    idSchema.parse(requestId);
    if (expectedInstance) idSchema.parse(expectedInstance);
    if (
      !path.startsWith('/') ||
      path.length > 1024 ||
      /[\r\n]/.test(path) ||
      body === null ||
      Array.isArray(body) ||
      bytes({ path, body }) > MAX_FRAME - 8192 ||
      (meta !== undefined && bytes(meta) > 2048)
    )
      throw new ApiError(
        'MESSAGE_TOO_LARGE',
        'Original intention exceeds its reserved slot',
        413,
      );
    if (this.preparing >= 32)
      throw new ApiError(
        'BACKPRESSURE',
        'Too many original intentions being prepared',
        429,
      );
    this.preparing++;
    try {
      // Copy before any await: callers cannot mutate the original body while
      // discovery or another tab owns the endpoint exchange.
      body = structuredClone(body);
      meta = meta === undefined ? undefined : structuredClone(meta);
      const fingerprint = await digest({ path, body });
      await this.update((state) => {
        if (state.paused)
          throw new ApiError(state.paused.code, state.paused.message, 409);
        const original = Object.hasOwn(state.records, requestId)
          ? state.records[requestId]
          : undefined;
        if (original) {
          if (
            expectedInstance &&
            original.instance &&
            original.instance !== expectedInstance
          )
            throw new ApiError(
              'DELIVERY_STATE_MISMATCH',
              'Original intention belongs to another Agent store',
              409,
            );
          if (original.digest !== fingerprint)
            throw new ApiError(
              'IDEMPOTENCY_CONFLICT',
              'Original intention content or scope changed',
              409,
            );
          return;
        }
        if (
          state.order.length >= 1024 ||
          state.order.filter((id) => state.records[id].state !== 'confirmed')
            .length >= 32
        )
          throw new ApiError(
            'BACKPRESSURE',
            'Original intention pending or retirement budget exhausted',
            429,
          );
        Object.defineProperty(state.records, requestId, {
          enumerable: true,
          writable: true,
          configurable: true,
          value: {
            requestId,
            path,
            body,
            digest: fingerprint,
            instance: expectedInstance || '',
            state: 'pending',
            ...(meta ? { meta } : {}),
          },
        });
        state.order.push(requestId);
      });
    } finally {
      this.preparing--;
    }
    return this.resume(requestId, signal);
  }
  async resume(requestId: string, signal?: AbortSignal): Promise<any> {
    this.check();
    if (signal?.aborted) throw signal.reason;
    const state = await this.read();
    if (state.paused)
      throw new ApiError(state.paused.code, state.paused.message, 409);
    const record = Object.hasOwn(state.records, requestId)
      ? state.records[requestId]
      : undefined;
    if (!record)
      throw new ApiError('NOT_FOUND', 'Unknown local original intention', 404);
    if (record.result) {
      this.kick();
      return this.result(record.result);
    }
    if (record.state === 'confirmed')
      throw new ApiError(
        'RESULT_UNAVAILABLE',
        'Confirmed original result body was retired',
        409,
      );
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(requestId) ?? [];
      if (waiters.length >= 32) {
        reject(
          new ApiError(
            'BACKPRESSURE',
            'Too many local original request listeners',
            429,
          ),
        );
        return;
      }
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const waiter = {
        resolve: (result: any) => {
          cleanup();
          resolve(result);
        },
        reject: (error: unknown) => {
          cleanup();
          reject(error);
        },
      };
      const abort = () => {
        const remaining = (this.waiters.get(requestId) ?? []).filter(
          (entry) => entry !== waiter,
        );
        if (remaining.length) this.waiters.set(requestId, remaining);
        else this.waiters.delete(requestId);
        waiter.reject(signal?.reason);
      };
      waiters.push(waiter);
      this.waiters.set(requestId, waiters);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      this.kick();
    });
  }
  private result(envelope: Envelope) {
    if (envelope.error)
      throw new ApiError(
        envelope.error.code,
        envelope.error.message,
        envelope.error.status ?? 409,
      );
    return envelope.data;
  }
  private publish(record: OriginalOperation) {
    if (this.stopped || !record.result) return;
    const waiters = this.waiters.get(record.requestId) ?? [];
    this.waiters.delete(record.requestId);
    for (const waiter of waiters) {
      try {
        waiter.resolve(this.result(record.result));
      } catch (error) {
        waiter.reject(error);
      }
    }
    if (!this.published.has(record.requestId)) {
      this.published.add(record.requestId);
      try {
        this.options.changed?.(structuredClone(record));
      } catch {
        /* View failure cannot change a durable result. */
      }
    }
  }
  private check() {
    if (this.frozen) throw this.frozen;
    if (this.stopped)
      throw new DOMException(
        'Original operation recovery paused',
        'AbortError',
      );
  }
  private freeze(error: Error) {
    this.frozen = error;
    clearTimeout(this.timer);
    for (const waiting of this.waiters.values())
      for (const waiter of waiting) waiter.reject(error);
    this.waiters.clear();
  }
  stop() {
    this.stopped = true;
    this.current?.abort();
    this.channel?.close();
    clearTimeout(this.timer);
    this.freeze(
      new DOMException('Original operation recovery paused', 'AbortError'),
    );
  }
  private kick() {
    if (this.running || this.stopped || this.frozen) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running = true;
    void this.run().finally(() => {
      this.running = false;
      if (this.waiters.size && !this.timer && !this.stopped && !this.frozen)
        this.kick();
    });
  }
  private async execute(requestId: string, signal: AbortSignal) {
    const state = await this.read();
    let record = state.records[requestId];
    if (state.paused)
      throw new ApiError(state.paused.code, state.paused.message, 409);
    if (!record || record.state === 'confirmed') return;
    if (record.instance === '') {
      // Discovery has no business side effect. Persist its instance binding
      // before the first mutation; reloads never rebind a published intention.
      const result = await this.request(
        `${this.options.admin ? '/admin' : ''}/hosts/${this.options.host}/probe`,
        {},
        signal,
      );
      this.check();
      const instance = idSchema.parse(
        result.operationInstance ?? result.deliveryInstance,
      );
      const bound = await this.update((latest) => {
        const original = latest.records[requestId];
        if (
          !original ||
          original.digest !== record.digest ||
          original.state !== 'pending'
        )
          throw new ApiError(
            'DELIVERY_STATE_MISMATCH',
            'Original intention changed before discovery',
            409,
          );
        if (!original.instance) original.instance = instance;
      });
      record = bound.records[requestId];
    }
    if (
      !record.body ||
      record.requestId !== requestId ||
      !idSchema.safeParse(record.instance).success ||
      (await digest({ path: record.path, body: record.body })) !== record.digest
    )
      throw new ApiError(
        'DELIVERY_STATE_MISMATCH',
        'Original intention body or identity is missing',
        409,
      );
    const ack = record.state === 'completed';
    await this.request(record.path, record.body, signal, requestId, undefined, {
      instance: record.instance,
      owner: this.options.owner,
      ack,
      commit: async (envelope, receipt) => {
        if (bytes(envelope) > MAX_FRAME - 8192)
          throw new ApiError(
            'MESSAGE_TOO_LARGE',
            'Original result exceeds its reserved slot',
            413,
          );
        if (
          !ack &&
          envelope.error === undefined &&
          record.meta?.kind === 'upload-finish'
        ) {
          const result = envelope.data as any;
          if (
            result?.state !== 'completed' ||
            result?.sha256 !== record.meta.sha256 ||
            result?.size !== record.meta.size
          )
            throw new ApiError(
              'DELIVERY_STATE_MISMATCH',
              'Uploaded result does not match the original file',
              409,
            );
        }
        const updated = await this.update((latest) => {
          const original = latest.records[requestId];
          if (
            !original ||
            original.instance !== record.instance ||
            original.digest !== record.digest
          )
            throw new ApiError(
              'DELIVERY_STATE_MISMATCH',
              'Original intention changed during recovery',
              409,
            );
          if (ack) {
            if (
              envelope.error !== undefined ||
              !(envelope.data as any)?.confirmed ||
              (!original.result && original.state !== 'confirmed')
            )
              throw new ApiError(
                'DELIVERY_STATE_MISMATCH',
                'Invalid original result confirmation',
                409,
              );
            original.state = 'confirmed';
            delete original.body;
            let count = 0,
              retained = 0;
            for (const id of [...latest.order].reverse()) {
              const previous = latest.records[id];
              if (previous.state !== 'confirmed' || !previous.result) continue;
              const size = bytes(previous.result);
              if (count < 16 && retained + size <= 4 * 1024 * 1024) {
                count++;
                retained += size;
              } else delete previous.result;
            }
          } else if (original.state === 'pending') {
            original.state = 'completed';
            original.result = envelope as Envelope;
            original.receipt = receipt;
          } else if (
            original.result &&
            JSON.stringify(canonical(original.result)) !==
              JSON.stringify(canonical(envelope))
          )
            throw new ApiError(
              'IDEMPOTENCY_CONFLICT',
              'Original intention already has another result',
              409,
            );
        });
        this.publish(updated.records[requestId]);
      },
    });
  }
  private async run() {
    while (!this.stopped && !this.frozen) {
      let selected: OriginalOperation | undefined;
      try {
        const state = await this.read();
        if (state.paused)
          throw new ApiError(state.paused.code, state.paused.message, 409);
        for (const id of state.order)
          if (state.records[id].result) this.publish(state.records[id]);
        selected = state.order
          .map((id) => state.records[id])
          .find((record) => record.state !== 'confirmed');
        if (!selected) return;
        this.current = new AbortController();
        await this.lock(this.current.signal, () =>
          this.execute(selected!.requestId, this.current!.signal),
        );
        this.attempts = 0;
      } catch (error) {
        if (this.stopped) return;
        // A durable business error still needs confirmation, never re-execution.
        const current = selected
          ? (await this.read().catch(() => undefined))?.records[
              selected.requestId
            ]
          : undefined;
        if (current && current.state !== selected?.state) {
          this.publish(current);
          this.attempts = 0;
          continue;
        }
        if (
          selected &&
          error instanceof ApiError &&
          error.code === 'REQUEST_EXPIRED'
        ) {
          const retired = await this.update((state) => {
            const record = state.records[selected!.requestId];
            record.state = 'confirmed';
            record.result ??= {
              error: { code: error.code, message: error.message },
            };
          });
          this.publish(retired.records[selected.requestId]);
          this.attempts = 0;
          continue;
        }
        if (
          retryable(error) ||
          (error instanceof ApiError &&
            [
              'RESULT_UNKNOWN',
              'RESULT_PENDING',
              'HOST_OFFLINE',
              'AGENT_NEGOTIATING',
              'BACKPRESSURE',
            ].includes(error.code))
        ) {
          const delay = recoveryDelay(this.attempts, 3, this.options.random);
          this.attempts = Math.min(3, this.attempts + 1);
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.kick();
          }, delay);
          return;
        }
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.freeze(failure);
        if (
          error instanceof ApiError &&
          error.code === 'DELIVERY_STATE_MISMATCH'
        )
          await this.update((state) => {
            state.paused = { code: error.code, message: error.message };
          }).catch(() => {});
        return;
      }
    }
  }
}
