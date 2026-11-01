import {
  controlProofSchema,
  commandTargetSchema,
  type CommandTarget,
  type ControlProof,
} from '../../../packages/protocol/src/index.ts';
import {
  deliveryWindowSchema,
  deliveryResetSchema,
  deliveryDigest,
  webDeliveryLane,
  type DeliveryLane,
  type DeliveryWindow,
  type DeliveryAllocation,
} from '../../../packages/protocol/src/delivery.ts';

import {
  emptyResults,
  receiveResults,
  type ResultJournal,
} from './delivery-results.ts';

type Entry = { seq: number; end: number; body: string };
type Lane = {
  next: number;
  bytes: number;
  received: number;
  receivedBytes?: number;
  receiver?: string;
  receiverStream?: string;
  streamSerial?: number;
  creditGeneration?: string;
  closed?: boolean;
  exhausted?: boolean;
  entries: Entry[];
  results: ResultJournal;
};
type State = {
  version: 2;
  stream: string;
  normal: Lane;
  priority: Lane;
  claimId?: string;
  controller?: string;
  control?: ControlProof;
  cancelled?: { requestId: string; body: string }[];
  cancelledKeys?: string[];
  retired?: {
    stream: string;
    normal: Lane;
    priority: Lane;
    control: ControlProof;
  }[];
};
type Storage = { record(key: string, value?: unknown): Promise<any> };
const emptyLane = (): Lane => ({
  next: 0,
  bytes: 0,
  received: 0,
  entries: [],
  results: emptyResults(),
});

// The durable outbox owns command identity. A connection only owns transient
// credit and wire attempts; disconnecting it never discards queued commands.
export class CommandDelivery {
  private state!: State;
  private loading: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private windows: Partial<Record<DeliveryLane, DeliveryWindow>> = {};
  private attempted = new Set<string>();
  private send?: (frame: unknown) => void;
  private generation = 0;
  private exchangeId = '';
  private baseline: Partial<
    Record<
      DeliveryLane,
      {
        received: number;
        bytes: number;
        resultReceived: number;
        resultBytes: number;
      }
    >
  > = {};
  private snapshots = new Set<DeliveryLane>();
  private fatal?: Error;
  private expectedControl?: ControlProof;
  get ready() {
    return this.snapshots.size === 2;
  }
  claim() {
    return this.enqueue(async () => {
      if (!this.state.claimId) {
        this.state.claimId = crypto.randomUUID();
        await this.save();
      }
      return {
        delivery: 2,
        claimId: this.state.claimId,
        ...(this.state.controller
          ? {
              resume: {
                stream: this.state.stream,
                controller: this.state.controller,
              },
            }
          : {}),
      };
    });
  }
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readAttempts = 0;
  private refreshing?: Promise<void>;
  private transmissions: Record<DeliveryLane, Promise<unknown>> = {
    normal: Promise.resolve(),
    priority: Promise.resolve(),
  };
  constructor(
    private storage: Storage,
    private result: (payload: any) => void,
    private transport?: {
      read: (
        stream: string,
        lane: DeliveryLane,
        seq?: number,
        exchangeId?: string,
        receipt?: Partial<DeliveryAllocation> & {
          received: number;
          bytes: number;
        },
      ) => Promise<any>;
      send: (frame: unknown) => Promise<void>;
      content?: (
        stream: string,
        lane: DeliveryLane,
        allocation: DeliveryAllocation,
        resultSeq: number,
        offset: number,
      ) => Promise<any>;
      heads?: (heads: any) => void;
    },
  ) {
    this.loading = (async () => {
      const saved = await storage.record('delivery-outbox-v2');
      this.state = saved || {
        version: 2,
        stream: crypto.randomUUID(),
        normal: emptyLane(),
        priority: emptyLane(),
      };
      if (this.state.version !== 2)
        throw new Error('Unsupported command outbox');
      if (!saved) await this.save();
    })();
    void this.loading.catch(() => {});
  }
  private receivedResults(lane: DeliveryLane) {
    return this.state[lane].results.received;
  }
  private opening() {
    return {
      type: 'delivery-open',
      exchangeId: this.exchangeId,
      stream: this.state.stream,
      instance: this.state.normal.receiver ?? this.state.priority.receiver,
      allocations: Object.fromEntries(
        (['normal', 'priority'] as const).flatMap((lane) => {
          const state = this.state[lane];
          return state.receiver && state.streamSerial && state.creditGeneration
            ? [
                [
                  lane,
                  {
                    instance: state.receiver,
                    streamSerial: state.streamSerial,
                    creditGeneration: state.creditGeneration,
                  },
                ],
              ]
            : [];
        }),
      ),
      receivedBytes: {
        normal: this.state.normal.results.bytes,
        priority: this.state.priority.results.bytes,
      },
      received: {
        normal: this.receivedResults('normal'),
        priority: this.receivedResults('priority'),
      },
    };
  }
  private beginRecovery() {
    this.exchangeId = crypto.randomUUID();
    this.windows = {};
    this.snapshots.clear();
    this.attempted.clear();
    for (const lane of ['normal', 'priority'] as const)
      this.baseline[lane] = {
        received: this.state[lane].received,
        bytes: this.state[lane].receivedBytes ?? 0,
        resultReceived: this.state[lane].results.received,
        resultBytes: this.state[lane].results.bytes,
      };
  }
  private save() {
    return this.storage.record('delivery-outbox-v2', this.state);
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.serial.then(async () => {
      await this.loading;
      return operation();
    });
    this.serial = job.catch(() => {});
    return job;
  }
  connect(
    send: (frame: unknown) => void,
    binding?: { control: unknown; controller: string },
  ) {
    const generation = ++this.generation;
    this.send = send;
    this.snapshots.clear();
    this.exchangeId = '';
    this.windows = {};
    this.attempted.clear();
    return this.enqueue(async () => {
      if (generation === this.generation) {
        if (this.fatal) {
          this.disconnect();
          throw this.fatal;
        }
        if (binding) {
          const control = controlProofSchema.parse(binding.control);
          const previous = structuredClone(this.state);
          const prior = this.state.control;
          if (
            prior &&
            (control.controlEpoch < prior.controlEpoch ||
              (control.controlId !== prior.controlId &&
                control.controlEpoch === prior.controlEpoch) ||
              control.connectionGeneration < prior.connectionGeneration ||
              (control.controlId === prior.controlId &&
                (control.controlEpoch !== prior.controlEpoch ||
                  control.owner !== prior.owner)))
          )
            throw new Error(
              'Control proof conflicts with the durable controller identity',
            );
          if (
            this.state.control &&
            this.state.control.controlId !== control.controlId
          ) {
            const retired = [...(this.state.retired || [])];
            retired.push({
              stream: this.state.stream,
              normal: this.state.normal,
              priority: this.state.priority,
              control: this.state.control,
            });
            if (
              retired.length > 4 ||
              new TextEncoder().encode(JSON.stringify(retired)).length >
                8 * 1024 * 1024
            )
              throw new Error(
                'Retired command flow budget exhausted; reconcile previous results',
              );
            this.state.retired = retired;
            this.state.stream = crypto.randomUUID();
            this.state.normal = emptyLane();
            this.state.priority = emptyLane();
          }
          this.state.control = control;
          this.state.controller = binding.controller;
          this.state.claimId = control.controlId;
          try {
            await this.save();
          } catch (error) {
            this.state = previous;
            throw error;
          }
          this.expectedControl = control;
        } else this.expectedControl = undefined;
        this.readAttempts = 0;
        this.beginRecovery();
        send(this.opening());
        this.schedule();
      }
    });
  }
  disconnect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.generation++;
    this.send = undefined;
    this.snapshots.clear();
    this.exchangeId = '';
    this.windows = {};
    this.attempted.clear();
  }
  target(requestId: string, activeTask?: CommandTarget) {
    return this.enqueue(async () => {
      for (const lane of ['normal', 'priority'] as const) {
        const state = this.state[lane];
        const entry = state.entries.find(
          (v) => JSON.parse(v.body).requestId === requestId,
        );
        if (
          entry &&
          entry.seq > 0 &&
          state.receiver &&
          state.receiverStream &&
          this.state.control
        ) {
          const target = {
            controlEpoch: this.state.control.controlEpoch,
            instance: state.receiver,
            owner: this.state.control.owner,
            requestId: 'web:' + requestId,
            stream: state.receiverStream,
          };
          const observed = commandTargetSchema.safeParse(activeTask);
          if (
            observed.success &&
            Object.entries(target).every(
              ([key, value]) =>
                observed.data[key as keyof CommandTarget] === value,
            )
          )
            return observed.data;
          return target;
        }
      }
      return undefined;
    });
  }
  cancelUnpublished(requestId: string) {
    return this.enqueue(async () => {
      for (const lane of ['normal', 'priority'] as const) {
        const entry = this.state[lane].entries.find(
          (v) => JSON.parse(v.body).requestId === requestId,
        );
        if (!entry || entry.seq !== 0) continue;
        const key = await deliveryDigest('web:' + requestId);
        if ((this.state.cancelledKeys?.length || 0) >= 1024)
          throw new Error(
            'BACKPRESSURE: Local cancellation identity budget exhausted',
          );
        const previous = structuredClone(this.state);
        this.state.cancelledKeys = [...(this.state.cancelledKeys || []), key];
        this.state[lane].entries = this.state[lane].entries.filter(
          (v) => v !== entry,
        );
        this.state.cancelled = [
          ...(this.state.cancelled || []),
          { requestId, body: entry.body },
        ].slice(-64);
        while (
          new TextEncoder().encode(JSON.stringify(this.state.cancelled))
            .length >
          512 * 1024
        )
          this.state.cancelled.shift();
        try {
          await this.save();
        } catch (error) {
          this.state = previous;
          throw error;
        }
        return true;
      }
      return false;
    });
  }
  submit(command: {
    action: string;
    requestId?: string;
    [key: string]: unknown;
  }) {
    return this.enqueue(async () => {
      if (this.fatal) throw this.fatal;
      if (
        this.state.cancelled?.some((v) => v.requestId === command.requestId) ||
        (command.requestId &&
          this.state.cancelledKeys?.includes(
            await deliveryDigest('web:' + command.requestId),
          ))
      )
        throw new Error(
          'CANCELLED_BEFORE_START: This original request was cancelled locally',
        );
      const lane = webDeliveryLane(command);
      if (!lane || !command.requestId)
        throw new Error('Only identified mutation commands use delivery');
      const body = JSON.stringify(command);
      const bytes = new TextEncoder().encode(body).length;
      if (
        new TextEncoder().encode(JSON.stringify(body)).length >
        256 * 1024 - 4096
      )
        throw new Error('Command exceeds delivery frame budget');
      const entries = [
        ...this.state.normal.entries,
        ...this.state.priority.entries,
      ];
      const duplicate = entries.find(
        (entry) => JSON.parse(entry.body).requestId === command.requestId,
      );
      if (duplicate) {
        if (duplicate.body !== body)
          throw new Error('Command identity reused with different content');
        try {
          await this.flush();
        } catch {
          this.schedule();
        }
        return;
      }
      if (this.state[lane].closed || this.state[lane].exhausted)
        throw new Error(
          'STREAM_CLOSED: Reconcile the original results before starting a new command flow',
        );
      const laneEntries = this.state[lane].entries;
      if (
        laneEntries.length >= (lane === 'priority' ? 4 : 96) ||
        laneEntries.reduce(
          (sum, entry) => sum + new TextEncoder().encode(entry.body).length,
          bytes,
        ) >
          (lane === 'priority' ? 512 : 1536) * 1024
      )
        throw new Error(
          'Local command buffer is full; wait for confirmed results',
        );
      const previous = structuredClone(this.state);
      const state = this.state[lane];
      state.entries.push({ seq: 0, end: 0, body });
      try {
        await this.save();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      try {
        await this.flush();
      } catch {
        this.schedule();
      }
    });
  }
  receive(frame: any) {
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation || !this.send) return;
      if (frame.exchangeId && frame.exchangeId !== this.exchangeId) return;
      if (frame.type === 'delivery-reset') {
        if (frame.exchangeId !== this.exchangeId) return;
        const reset = deliveryResetSchema.parse(frame);
        this.fatal = new Error(`${reset.error.code}: ${reset.error.message}`);
        this.disconnect();
        throw this.fatal;
      }
      const lane: DeliveryLane = frame.lane;
      if (lane !== 'normal' && lane !== 'priority')
        throw new Error('Invalid delivery lane');
      if (!this.snapshots.has(lane) && frame.exchangeId !== this.exchangeId)
        return;
      if (!this.snapshots.has(lane) && this.expectedControl) {
        const ready = frame.controlReady;
        if (
          !ready ||
          ready.exchangeId !== this.exchangeId ||
          ready.instance !== frame.window?.instance ||
          Object.entries(this.expectedControl).some(
            ([key, value]) => ready[key] !== value,
          )
        )
          throw new Error('Agent has not confirmed the current control claim');
      }
      const window = deliveryWindowSchema.parse(frame.window);
      const state = this.state[lane];
      if (
        window.received > state.next ||
        window.credit < window.received ||
        window.byteCredit < window.receivedBytes ||
        window.receivedBytes > state.bytes
      )
        throw new Error('Command receiver progress is inconsistent');
      const previous = this.windows[lane];
      if (state.receiverStream && state.receiverStream !== window.stream)
        throw new Error('Command receiver stream changed');
      if (
        (state.receiver && state.receiver !== window.instance) ||
        (state.streamSerial !== undefined &&
          state.streamSerial !== window.streamSerial) ||
        (state.creditGeneration !== undefined &&
          state.creditGeneration !== window.creditGeneration) ||
        (frame.exchangeId === this.exchangeId &&
          !this.snapshots.has(lane) &&
          (window.received < this.baseline[lane]!.received ||
            window.receivedBytes < this.baseline[lane]!.bytes ||
            (window.sent ?? 0) < this.baseline[lane]!.resultReceived ||
            (window.resultBytes ?? 0) < this.baseline[lane]!.resultBytes))
      ) {
        this.fatal = new Error(
          'Receiver journal changed or lost confirmed commands; automatic replay stopped',
        );
        this.disconnect();
        throw this.fatal;
      }
      if (
        window.received === state.received &&
        window.receivedBytes !== (state.receivedBytes ?? 0)
      )
        throw new Error('Same command ACK changed its byte position');
      if (window.received > state.received) {
        const boundary = state.entries.find(
          (entry) => entry.seq === window.received,
        );
        if (!boundary || boundary.end !== window.receivedBytes)
          throw new Error('Command ACK is not a published byte boundary');
      }
      if (previous && previous.stream !== window.stream)
        throw new Error('Command receiver identity changed');
      const envelopes: unknown[] = [...(frame.results ?? [])];
      if (frame.type === 'delivery-result') envelopes.push(frame);
      else if (frame.record?.phase === 'finished') {
        if (frame.record.resultBody == null)
          throw new Error('Result content is unavailable');
        envelopes.push({ seq: frame.seq, ...frame.record });
      }
      const accepted = await receiveResults(
        state.results,
        state.entries,
        envelopes,
        window,
        this.transport?.content
          ? async (resultSeq, descriptor: any) => {
              let content = '',
                offset = 0;
              while (offset < descriptor.length) {
                const result = await this.transport!.content!(
                  this.state.stream,
                  lane,
                  window,
                  resultSeq,
                  offset,
                );
                if (generation !== this.generation || !this.send)
                  throw new Error('Result transfer connection retired');
                const chunk = result.content;
                if (
                  result.window?.instance !== window.instance ||
                  result.window?.stream !== window.stream ||
                  result.window?.streamSerial !== window.streamSerial ||
                  result.window?.creditGeneration !== window.creditGeneration ||
                  chunk?.resultSeq !== resultSeq ||
                  chunk?.offset !== offset ||
                  chunk?.length !== descriptor.length ||
                  typeof chunk.body !== 'string' ||
                  chunk.next !==
                    offset + new TextEncoder().encode(chunk.body).length ||
                  chunk.next <= offset ||
                  chunk.next > descriptor.length
                )
                  throw new Error('Invalid result content chunk');
                content += chunk.body;
                offset = chunk.next;
              }
              return content;
            }
          : undefined,
      );
      if (generation !== this.generation || !this.send) return;
      const saved = structuredClone(this.state);
      state.receiver = window.instance;
      state.receiverStream = window.stream;
      state.streamSerial = window.streamSerial;
      state.creditGeneration = window.creditGeneration;
      state.received = Math.max(state.received, window.received);
      state.receivedBytes = Math.max(
        state.receivedBytes ?? 0,
        window.receivedBytes,
      );
      this.windows[lane] = previous
        ? {
            ...window,
            received: Math.max(previous.received, window.received),
            receivedBytes: Math.max(
              previous.receivedBytes,
              window.receivedBytes,
            ),
            credit: Math.max(previous.credit, window.credit),
            byteCredit: Math.max(previous.byteCredit, window.byteCredit),
          }
        : window;
      state.entries = accepted.entries;
      state.results = accepted.journal;
      state.closed = !!(state.closed || window.closed);
      state.exhausted = !!(state.exhausted || window.exhausted);
      const completed = accepted.completed.length > 0;
      try {
        await this.save();
      } catch (error) {
        this.state = saved;
        this.windows[lane] = previous;
        throw error;
      }
      if (window.received > saved[lane].received || completed)
        this.readAttempts = 0;
      if (frame.exchangeId === this.exchangeId) this.snapshots.add(lane);
      if (frame.heads) this.transport?.heads?.(frame.heads);
      // Duplicate results repeat the continuous receipt, even if the first ACK was lost.
      if (envelopes.length && this.send) {
        const receipt = {
          type: 'delivery-receipt',
          stream: this.state.stream,
          lane,
          instance: window.instance,
          streamSerial: window.streamSerial,
          creditGeneration: window.creditGeneration,
          received: state.results.received,
          receivedBytes: state.results.bytes,
        };
        if (this.transport) void this.transport.send(receipt).catch(() => {});
        else this.send(receipt);
      }
      for (const completion of accepted.completed) {
        let payload = completion.payload;
        if (payload?.error && !payload.type)
          payload = {
            type: 'error',
            requestId: JSON.parse(completion.body).requestId,
            error: payload.error,
          };
        if (payload) this.result(payload);
      }
      await this.flush();
    });
  }
  refresh(): Promise<void> {
    if (!this.refreshing)
      this.refreshing = this.refreshOnce().finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
  private async refreshOnce() {
    const generation = this.generation;
    await this.enqueue(async () => {
      if (!this.send || generation !== this.generation) return;
      if (this.snapshots.size === 2) this.beginRecovery();
      this.send(this.opening());
    });
    const exchangeId = this.exchangeId;
    if (this.transport && this.send) {
      await this.loading;
      for (const lane of ['priority', 'normal'] as const) {
        const entries = this.state[lane].entries.filter(
          (entry) => entry.seq > 0,
        );
        for (const entry of entries.length ? entries : [undefined]) {
          let result: any;
          try {
            result = await this.transport.read(
              this.state.stream,
              lane,
              entry?.seq || undefined,
              exchangeId,
              {
                instance: this.state[lane].receiver,
                streamSerial: this.state[lane].streamSerial,
                creditGeneration: this.state[lane].creditGeneration,
                received: this.state[lane].results.received,
                bytes: this.state[lane].results.bytes,
              },
            );
          } catch (error: any) {
            if (
              generation === this.generation &&
              exchangeId === this.exchangeId &&
              [
                'DELIVERY_STATE_MISMATCH',
                'STREAM_CLOSED',
                'RESULT_UNAVAILABLE',
                'STALE_CONTROLLER',
                'UNAUTHORIZED',
                'FORBIDDEN',
              ].includes(error?.code)
            ) {
              this.fatal =
                error instanceof Error ? error : new Error(error.code);
              this.disconnect();
            }
            throw error;
          }
          if (generation !== this.generation || exchangeId !== this.exchangeId)
            return;
          await this.receive({
            type: 'delivery-window',
            lane,
            seq: entry?.seq,
            ...result,
          });
        }
      }
    }
    return this.enqueue(async () => {
      this.attempted.clear();
      if (generation !== this.generation || exchangeId !== this.exchangeId)
        return;
      await this.flush();
    });
  }
  private schedule() {
    if (!this.send) return;
    const pending = (['normal', 'priority'] as const).some((lane) => {
      const state = this.state[lane];
      return (
        Object.keys(state.results.buffer).length ||
        state.entries.some((entry) =>
          state.closed
            ? entry.seq > 0 && entry.seq <= state.received
            : state.exhausted
              ? entry.seq > 0
              : true,
        )
      );
    });
    if (
      !pending &&
      ((this.windows.normal && this.windows.priority) || this.readAttempts >= 3)
    ) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      return;
    }
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        this.readAttempts++;
        void this.refresh()
          .catch(() => {})
          .finally(() => this.schedule());
      },
      this.readAttempts < 5
        ? Math.min(10000, 1000 * 2 ** this.readAttempts)
        : 30000 + Math.random() * 30000,
    );
  }
  private async flush() {
    if (!this.send || this.fatal) return;
    this.schedule();
    if (this.snapshots.size !== 2) return;
    const activeGeneration = this.generation;
    for (const lane of ['priority', 'normal'] as const) {
      const window = this.windows[lane];
      if (!window) continue;
      for (const entry of this.state[lane].entries) {
        if (!entry.seq) {
          const state = this.state[lane];
          if (state.closed || state.exhausted) continue;
          const seq = state.next + 1;
          const end = state.bytes + new TextEncoder().encode(entry.body).length;
          if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(end))
            throw new Error('Command sequence exhausted');
          if (seq > window.credit || end > window.byteCredit) break;
          const saved = structuredClone(this.state);
          entry.seq = state.next = seq;
          entry.end = state.bytes = end;
          try {
            await this.save();
          } catch (error) {
            this.state = saved;
            throw error;
          }
        }
        if (!this.send || activeGeneration !== this.generation) return;
        const query = entry.seq <= window.received;
        if (!query && this.state[lane].closed) continue;
        if (
          !query &&
          (entry.seq > window.credit || entry.end > window.byteCredit)
        )
          break;
        const key = `${lane}:${entry.seq}:${query ? 'query' : 'send'}`;
        if (this.attempted.has(key)) continue;
        const frame = query
          ? {
              type: 'delivery-query',
              stream: this.state.stream,
              lane,
              instance: window.instance,
              streamSerial: window.streamSerial,
              creditGeneration: window.creditGeneration,
              seq: entry.seq,
            }
          : {
              type: 'delivery-command',
              stream: this.state.stream,
              lane,
              instance: window.instance,
              streamSerial: window.streamSerial,
              creditGeneration: window.creditGeneration,
              ...entry,
            };
        if (!query && this.transport) {
          const generation = this.generation;
          const exchangeId = this.exchangeId;
          this.transmissions[lane] = this.transmissions[lane]
            .catch(() => {})
            .then(async () => {
              if (
                this.send &&
                generation === this.generation &&
                exchangeId === this.exchangeId &&
                this.snapshots.size === 2
              )
                await this.transport!.send(frame);
            });
          void this.transmissions[lane].catch(() => {});
        } else this.send(frame);
        this.attempted.add(key);
      }
    }
  }
}
