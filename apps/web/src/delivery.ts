import {
  deliveryWindowSchema,
  webDeliveryLane,
  type DeliveryLane,
  type DeliveryWindow,
} from '../../../packages/protocol/src/delivery.ts';

type Entry = { seq: number; end: number; body: string };
type Lane = {
  next: number;
  bytes: number;
  received: number;
  receivedBytes?: number;
  receiver?: string;
  entries: Entry[];
};
type State = { version: 1; stream: string; normal: Lane; priority: Lane };
type Storage = { record(key: string, value?: unknown): Promise<any> };
const emptyLane = (): Lane => ({ next: 0, bytes: 0, received: 0, entries: [] });

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
  private fatal?: Error;
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
      read: (stream: string, lane: DeliveryLane, seq?: number) => Promise<any>;
      send: (frame: unknown) => Promise<void>;
      heads?: (heads: any) => void;
    },
  ) {
    this.loading = (async () => {
      const saved = await storage.record('delivery-outbox');
      this.state = saved || {
        version: 1,
        stream: crypto.randomUUID(),
        normal: emptyLane(),
        priority: emptyLane(),
      };
      if (this.state.version !== 1)
        throw new Error('Unsupported command outbox');
      if (!saved) await this.save();
    })();
    void this.loading.catch(() => {});
  }
  private receivedResults(lane: DeliveryLane) {
    const state = this.state[lane];
    return state.entries.length ? state.entries[0].seq - 1 : state.next;
  }
  private opening() {
    return {
      type: 'delivery-open',
      stream: this.state.stream,
      received: {
        normal: this.receivedResults('normal'),
        priority: this.receivedResults('priority'),
      },
    };
  }
  private save() {
    return this.storage.record('delivery-outbox', this.state);
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.serial.then(async () => {
      await this.loading;
      return operation();
    });
    this.serial = job.catch(() => {});
    return job;
  }
  connect(send: (frame: unknown) => void) {
    const generation = ++this.generation;
    this.send = send;
    this.windows = {};
    this.attempted.clear();
    return this.enqueue(async () => {
      if (generation === this.generation) {
        this.readAttempts = 0;
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
    this.windows = {};
    this.attempted.clear();
  }
  submit(command: {
    action: string;
    requestId?: string;
    [key: string]: unknown;
  }) {
    return this.enqueue(async () => {
      if (this.fatal) throw this.fatal;
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
          this.flush();
        } catch {
          this.schedule();
        }
        return;
      }
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
      if (
        !Number.isSafeInteger(state.next + 1) ||
        !Number.isSafeInteger(state.bytes + bytes)
      )
        throw new Error('Command sequence exhausted');
      state.entries.push({
        seq: ++state.next,
        end: (state.bytes += bytes),
        body,
      });
      try {
        await this.save();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      try {
        this.flush();
      } catch {
        this.schedule();
      }
    });
  }
  receive(frame: any) {
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation) return;
      const lane: DeliveryLane = frame.lane;
      if (lane !== 'normal' && lane !== 'priority')
        throw new Error('Invalid delivery lane');
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
      if (
        (state.receiver && state.receiver !== window.instance) ||
        (!previous &&
          (window.received < state.received ||
            window.receivedBytes < (state.receivedBytes ?? 0)))
      ) {
        this.fatal = new Error(
          'Receiver journal changed or lost confirmed commands; automatic replay stopped',
        );
        this.disconnect();
        throw this.fatal;
      }
      if (previous && previous.stream !== window.stream)
        throw new Error('Command receiver identity changed');
      const saved = structuredClone(this.state);
      state.receiver = window.instance;
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
      const entry = state.entries.find((entry) => entry.seq === frame.seq);
      let payload: any;
      let completed = false;
      if (
        entry &&
        (frame.type === 'delivery-result' || frame.record?.phase === 'finished')
      ) {
        payload =
          frame.type === 'delivery-result'
            ? frame.payload
            : frame.record.result;
        if (payload?.error && !payload.type)
          payload = {
            type: 'error',
            requestId: JSON.parse(entry.body).requestId,
            error: payload.error,
          };
        state.entries = state.entries.filter((value) => value !== entry);
        completed = true;
      }
      try {
        await this.save();
      } catch (error) {
        this.state = saved;
        this.windows[lane] = previous;
        throw error;
      }
      if (frame.heads) this.transport?.heads?.(frame.heads);
      if (completed) {
        if (payload) this.result(payload);
        const receipt = {
          type: 'delivery-receipt',
          stream: this.state.stream,
          lane,
          received: this.receivedResults(lane),
        };
        if (this.send) {
          if (this.transport) void this.transport.send(receipt).catch(() => {});
          else this.send(receipt);
        }
      }
      this.flush();
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
    if (this.transport && this.send) {
      await this.loading;
      const generation = this.generation;
      for (const lane of ['priority', 'normal'] as const) {
        const entries = [...this.state[lane].entries];
        for (const entry of entries.length ? entries : [undefined]) {
          const result = await this.transport.read(
            this.state.stream,
            lane,
            entry?.seq,
          );
          if (generation !== this.generation) return;
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
      if (this.send) this.send(this.opening());
      this.flush();
    });
  }
  private schedule() {
    if (!this.send) return;
    const pending =
      this.state.normal.entries.length + this.state.priority.entries.length;
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
      Math.min(10000, 1000 * 2 ** Math.min(this.readAttempts, 4)),
    );
  }
  private flush() {
    if (!this.send) return;
    this.schedule();
    for (const lane of ['priority', 'normal'] as const) {
      const window = this.windows[lane];
      if (!window) continue;
      for (const entry of this.state[lane].entries) {
        const query = entry.seq <= window.received;
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
              seq: entry.seq,
            }
          : {
              type: 'delivery-command',
              stream: this.state.stream,
              lane,
              ...entry,
            };
        if (!query && this.transport) {
          const generation = this.generation;
          this.transmissions[lane] = this.transmissions[lane]
            .catch(() => {})
            .then(async () => {
              if (this.send && generation === this.generation)
                await this.transport!.send(frame);
            });
          void this.transmissions[lane].catch(() => {});
        } else this.send(frame);
        this.attempted.add(key);
      }
    }
  }
}
