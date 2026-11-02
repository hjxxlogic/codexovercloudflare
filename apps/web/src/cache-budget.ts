// One read/write IndexedDB transaction owns both data and its global accounting.
// Transactions include `pages`, so independent tabs and scopes serialize here.
const MiB = 1024 * 1024;
export const cacheLimits = {
  bytes: 64 * MiB,
  scopeBytes: 16 * MiB,
  records: 100000,
  scopeRecords: 10000,
  scopes: 1024,
  commandReservation: 32 * MiB,
  commandBytes: 512 * MiB,
};
const ledgerKey = ['$coc-transport2-budget', 'ledger'];
type Usage = { bytes: number; records: number };
type Ledger = Usage & {
  scopes: Record<string, Usage>;
  commands: Record<string, number>;
  commandAccounting?: 2;
};
const charge = (key: IDBValidKey, value: unknown) =>
  new TextEncoder().encode(JSON.stringify([key, value])).length + 512;

// Reserve result space only while a durable original or an incomplete result
// remains. Completed journals retain their identities and diagnostic results.
export function commandReservation(
  value: unknown,
  actualBytes: number,
  key?: IDBValidKey,
) {
  const state = value as any;
  const name = Array.isArray(key) ? String(key[1]) : '';
  if (
    state?.version === 2 &&
    name.startsWith('delivery-outbox-http:v2') &&
    Array.isArray(state.order) &&
    state.records &&
    !Array.isArray(state.records) &&
    state.order.every(
      (id: string) => state.records[id]?.state === 'confirmed',
    ) &&
    Object.values(state.records).every(
      (record: any) => record?.state === 'confirmed',
    )
  )
    return actualBytes;
  if (
    state?.version === 2 &&
    name.startsWith('delivery-outbox-upload:v2') &&
    Array.isArray(state.records) &&
    state.records.every(
      (record: any) =>
        ['completed', 'failed'].includes(record?.phase) &&
        !record.chunks?.length,
    )
  )
    return actualBytes;
  const idleLane = (lane: any) =>
    lane &&
    Array.isArray(lane.entries) &&
    lane.entries.length === 0 &&
    lane.results?.buffer &&
    typeof lane.results.buffer === 'object' &&
    Object.keys(lane.results.buffer).length === 0;
  if (
    state?.version === 2 &&
    idleLane(state.normal) &&
    idleLane(state.priority) &&
    (state.retired === undefined ||
      (Array.isArray(state.retired) &&
        state.retired.every(
          (flow: any) => idleLane(flow.normal) && idleLane(flow.priority),
        )))
  )
    return actualBytes;
  // Unknown older formats remain protected until their owner reconciles them.
  return Math.max(actualBytes, cacheLimits.commandReservation);
}

export class CacheBudget {
  error?: Error;
  private ledger?: Ledger;
  private queue: (() => void)[] = [];
  private busy = false;
  constructor(private tx: IDBTransaction) {
    const read = tx.objectStore('pages').get(ledgerKey);
    read.onsuccess = () => {
      this.ledger = read.result ?? {
        bytes: 0,
        records: 0,
        scopes: {},
        commands: {},
      };
      this.migrateCommands();
    };
  }
  private migrateCommands() {
    const ledger = this.ledger!;
    if (ledger.commandAccounting === 2) {
      this.next();
      return;
    }
    // Upgrade the old fixed reservations in the same serialized transaction.
    // Never rewrite or remove an outbox, including those owned by another tab.
    const entries = Object.entries(ledger.commands);
    let remaining = entries.length;
    this.busy = true;
    const done = () => {
      if (--remaining > 0) return;
      ledger.commandAccounting = 2;
      this.tx.objectStore('pages').put(ledger, ledgerKey);
      this.busy = false;
      this.next();
    };
    if (!remaining) {
      remaining = 1;
      done();
    }
    for (const [identity, reserved] of entries) {
      const [, key] = JSON.parse(identity);
      const read = this.tx.objectStore('pages').get(key);
      read.onsuccess = () => {
        if (read.result !== undefined)
          ledger.commands[identity] = Math.min(
            reserved,
            commandReservation(read.result, charge(key, read.result), key),
          );
        done();
      };
    }
  }
  private next() {
    if (!this.ledger || this.busy || this.error) return;
    const operation = this.queue.shift();
    if (!operation) return;
    this.busy = true;
    operation();
  }
  put(store: string, key: IDBValidKey, value: unknown, scope: string) {
    this.change(store, key, scope, value);
  }
  remove(store: string, key: IDBValidKey, scope: string) {
    this.change(store, key, scope);
  }
  private change(
    store: string,
    key: IDBValidKey,
    scope: string,
    value?: unknown,
  ) {
    this.queue.push(() => {
      const data = this.tx.objectStore(store);
      const read = data.get(key);
      read.onsuccess = () => {
        const ledger = this.ledger!;
        const old = read.result;
        if (
          store === 'events' &&
          old !== undefined &&
          value !== undefined &&
          (old.event?.revision ?? old.event?.seq) >
            ((value as any).event?.revision ?? (value as any).event?.seq)
        ) {
          this.busy = false;
          this.next();
          return;
        }
        const command =
          store === 'pages' &&
          Array.isArray(key) &&
          String(key[1]).startsWith('delivery-outbox');
        const identity = JSON.stringify([scope, key]);
        const size = value === undefined ? 0 : charge(key, value);
        const previous = old === undefined ? 0 : charge(key, old);
        const scopeKey = JSON.stringify(scope);
        const own = ledger.scopes[scopeKey] ?? { bytes: 0, records: 0 };
        const records = Number(value !== undefined) - Number(old !== undefined);
        if (command) {
          const reserved = ledger.commands[identity] ?? 0;
          const required = commandReservation(value, size, key);
          if (
            value === undefined ||
            size > cacheLimits.commandReservation ||
            (!reserved &&
              Object.keys(ledger.commands).length >= cacheLimits.scopes) ||
            Object.values(ledger.commands).reduce((a, b) => a + b, 0) -
              reserved +
              required >
              cacheLimits.commandBytes
          ) {
            this.fail('command');
            return;
          }
          ledger.commands[identity] = required;
        } else {
          const delta = size - previous;
          if (value !== undefined && size > cacheLimits.scopeBytes) {
            this.fail();
            return;
          }
          const fits = () =>
            value === undefined ||
            (delta <= 0 && records <= 0) ||
            (ledger.bytes + delta <= cacheLimits.bytes &&
              own.bytes + delta <= cacheLimits.scopeBytes &&
              ledger.records + records <= cacheLimits.records &&
              own.records + records <= cacheLimits.scopeRecords &&
              (ledger.scopes[scopeKey] ||
                Object.keys(ledger.scopes).length < cacheLimits.scopes));
          const persist = () => {
            if (!fits()) {
              this.fail();
              return;
            }
            ledger.bytes += delta;
            ledger.records += records;
            own.bytes += delta;
            own.records += records;
            if (own.records) ledger.scopes[scopeKey] = own;
            else delete ledger.scopes[scopeKey];
            this.write(data, key, value);
          };
          if (!fits()) this.reclaim(scope, key, fits, persist);
          else persist();
          return;
        }
        this.write(data, key, value);
      };
    });
    this.next();
  }
  private write(data: IDBObjectStore, key: IDBValidKey, value: unknown) {
    const written =
      value === undefined
        ? data.delete(key)
        : data.name === 'events'
          ? data.put(value)
          : data.put(value, key);
    this.tx.objectStore('pages').put(this.ledger!, ledgerKey);
    written.onsuccess = () => {
      this.busy = false;
      this.next();
    };
  }
  private reclaim(
    scope: string,
    key: IDBValidKey,
    fits: () => unknown,
    done: () => void,
  ) {
    const pages = this.tx.objectStore('pages');
    const scan = (local: boolean) => {
      const request = pages.openCursor(
        local
          ? IDBKeyRange.bound([scope], [scope, []], false, true)
          : undefined,
      );
      request.onsuccess = () => {
        const row = request.result;
        if (fits()) {
          done();
          return;
        }
        if (!row) {
          if (local) scan(false);
          else done();
          return;
        }
        const candidate = row.key as IDBValidKey[];
        // Only redundant page projections and on-demand bodies are disposable.
        // Events, checkpoints, subscription proofs, drafts and originals survive.
        if (
          Array.isArray(candidate) &&
          (typeof candidate[1] === 'number' ||
            String(candidate[1]).startsWith('content:')) &&
          indexedDB.cmp(row.key, key) !== 0
        ) {
          const ledger = this.ledger!;
          const owner = JSON.stringify(candidate[0]);
          const usage = ledger.scopes[owner];
          if (usage) {
            const bytes = charge(row.key, row.value);
            ledger.bytes -= bytes;
            ledger.records--;
            usage.bytes -= bytes;
            usage.records--;
            if (!usage.records) delete ledger.scopes[owner];
            row.delete();
          }
        }
        row.continue();
      };
    };
    scan(true);
  }
  private fail(kind: 'command' | 'cache' = 'cache') {
    this.error = new Error(
      kind === 'command'
        ? 'BACKPRESSURE: 当前浏览器的未决命令存储预算已满，待处理任务已保留；请先恢复未完成会话。'
        : 'BACKPRESSURE: 当前浏览器的本地历史缓存额度已满，未确认任务和草稿已保留。',
    );
    this.tx.abort();
  }
}
