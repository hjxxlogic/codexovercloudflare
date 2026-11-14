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
  recoveryBytes: 4 * MiB,
  scopeRecoveryBytes: MiB,
  recoveryRecords: 4096,
  scopeRecoveryRecords: 128,
};
// History must not consume the headroom needed to reconnect or save an intent.
// Existing ledgers include these records already; no accounting migration needed.
const recoveryRecord = (store: string, key: IDBValidKey) =>
  store === 'pages' &&
  Array.isArray(key) &&
  (['workspace', 'draft', 'pending', 'model', 'deleted'].includes(
    String(key[1]),
  ) ||
    String(key[1]).startsWith('history-subscription:'));

export function cacheCapacityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'QuotaExceededError' ||
      error.message.startsWith('BACKPRESSURE: 当前浏览器的本地历史缓存'))
  );
}
export function historyCacheErrorMessage(error: unknown): string {
  if (cacheCapacityError(error))
    return '本地历史缓存额度已满，已暂停历史缓存写入；仍可从 Agent 在线读取。可在“信息”中清理本机会话缓存后重试。';
  if (error instanceof Error && error.name === 'HistoryCacheBufferFullError')
    return '本地历史缓存写入积压；仍可从 Agent 读取历史，未保存的内容不会被持久确认。';
  return (
    '本地历史缓存不可用；仍可从 Agent 读取历史。' +
    (error instanceof Error ? ` (${error.name}: ${error.message})` : '')
  );
}
const ledgerKey = ['$coc-transport2-budget', 'ledger'];
type Usage = { bytes: number; records: number };
type Ledger = Usage & {
  scopes: Record<string, Usage>;
  commands: Record<string, number>;
  commandAccounting: 2;
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
  // Pending current requests retain their result reservation.
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
        commandAccounting: 2,
      };
      if (this.ledger!.commandAccounting !== 2) {
        this.error = new Error(
          'UNSUPPORTED_STORAGE_VERSION: Unsupported cache accounting format',
        );
        this.tx.abort();
        return;
      }
      this.next();
    };
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
  remove(store: string, key: IDBValidKey, scope: string, purge = false) {
    this.change(store, key, scope, undefined, purge);
  }
  private change(
    store: string,
    key: IDBValidKey,
    scope: string,
    value?: unknown,
    purge = false,
  ) {
    this.queue.push(() => {
      const data = this.tx.objectStore(store);
      const read = data.get(key);
      read.onsuccess = () => {
        const apply = () => {
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
          const records =
            Number(value !== undefined) - Number(old !== undefined);
          if (
            command &&
            value === undefined &&
            purge &&
            commandReservation(old, 0, key) === 0
          ) {
            delete ledger.commands[identity];
          } else if (command) {
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
            const recovery = recoveryRecord(store, key);
            if (value !== undefined && size > cacheLimits.scopeBytes) {
              this.fail();
              return;
            }
            const fits = () =>
              value === undefined ||
              (delta <= 0 && records <= 0) ||
              (ledger.bytes + delta <=
                cacheLimits.bytes +
                  (recovery ? cacheLimits.recoveryBytes : 0) &&
                own.bytes + delta <=
                  cacheLimits.scopeBytes +
                    (recovery ? cacheLimits.scopeRecoveryBytes : 0) &&
                ledger.records + records <=
                  cacheLimits.records +
                    (recovery ? cacheLimits.recoveryRecords : 0) &&
                own.records + records <=
                  cacheLimits.scopeRecords +
                    (recovery ? cacheLimits.scopeRecoveryRecords : 0) &&
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
            if (!fits())
              this.reclaim(
                store,
                scope,
                key,
                value,
                fits,
                () =>
                  own.bytes + delta >
                    cacheLimits.scopeBytes +
                      (recovery ? cacheLimits.scopeRecoveryBytes : 0) ||
                  own.records + records >
                    cacheLimits.scopeRecords +
                      (recovery ? cacheLimits.scopeRecoveryRecords : 0),
                persist,
                () => {
                  this.tx.objectStore('pages').put(this.ledger!, ledgerKey);
                  this.busy = false;
                  this.next();
                },
              );
            else persist();
            return;
          }
          this.write(data, key, value);
        };
        if (
          value !== undefined &&
          !(store === 'pages' && Array.isArray(key) && key[1] === 'deleted')
        ) {
          const marker = this.tx.objectStore('pages').get([scope, 'deleted']);
          marker.onsuccess = () => {
            if (marker.result) {
              this.error = new Error('SESSION_DELETED: 本机会话副本已删除');
              this.tx.abort();
            } else apply();
          };
        } else apply();
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
    store: string,
    scope: string,
    key: IDBValidKey,
    value: unknown,
    fits: () => unknown,
    ownFull: () => boolean,
    done: () => void,
    skip: () => void,
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
          else reclaimEvents();
          return;
        }
        const candidate = row.key as IDBValidKey[];
        // Drop redundant projections before evicting canonical history.
        // Checkpoints, subscription proofs, drafts and originals survive.
        if (
          Array.isArray(candidate) &&
          (typeof candidate[1] === 'number' ||
            String(candidate[1]).startsWith('content:') ||
            candidate[1] === 'history-archive') &&
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
    const reclaimEvents = () => {
      // Optional projections must never displace newer canonical history.
      if (
        store === 'pages' &&
        Array.isArray(key) &&
        (typeof key[1] === 'number' ||
          String(key[1]).startsWith('content:') ||
          key[1] === 'history-archive')
      ) {
        skip();
        return;
      }
      if (!this.tx.objectStoreNames.contains('events')) {
        done();
        return;
      }
      const localPressure = ownFull();
      // Reclaim a small batch so a full cache does not rescan every retained
      // event for each arriving delta. Recovery state may consume this headroom.
      const reclaimed = () => {
        const ledger = this.ledger!;
        const usage = localPressure
          ? ledger.scopes[JSON.stringify(scope)]
          : ledger;
        return (
          !usage ||
          (usage.bytes <=
            (localPressure ? cacheLimits.scopeBytes : cacheLimits.bytes) *
              0.9 &&
            usage.records <=
              (localPressure ? cacheLimits.scopeRecords : cacheLimits.records) *
                0.9)
        );
      };
      const events = this.tx.objectStore('events');
      const candidates: { key: IDBValidKey; value: any }[] = [];
      const scan = events.openCursor();
      scan.onsuccess = () => {
        const row = scan.result;
        if (row) {
          if (!(store === 'events' && indexedDB.cmp(row.key, key) === 0))
            candidates.push({ key: row.key, value: row.value });
          row.continue();
          return;
        }
        candidates.sort(
          (a, b) =>
            (a.value.event.time ?? 0) - (b.value.event.time ?? 0) ||
            a.value.seq - b.value.seq,
        );
        let retainedNewer = false;
        for (const candidate of candidates) {
          if (fits() && reclaimed()) break;
          const ledger = this.ledger!;
          if (
            (ownFull() || (localPressure && fits())) &&
            candidate.value.scope !== scope
          )
            continue;
          if (store === 'events' && value !== undefined) {
            const incoming = value as any;
            const newer =
              candidate.value.scope === scope
                ? (candidate.value.event.revision ?? candidate.value.seq) >=
                  (incoming.event.revision ?? incoming.seq)
                : (candidate.value.event.time ?? 0) >=
                  (incoming.event.time ?? 0);
            // Backfilling old pages must not push recent messages out of cache.
            if (newer) {
              retainedNewer = true;
              continue;
            }
          }
          const owner = JSON.stringify(candidate.value.scope);
          const usage = ledger.scopes[owner];
          if (!usage) continue;
          const bytes = charge(candidate.key, candidate.value);
          ledger.bytes -= bytes;
          ledger.records--;
          usage.bytes -= bytes;
          usage.records--;
          if (!usage.records) delete ledger.scopes[owner];
          events.delete(candidate.key);
        }
        // An older backfill can be omitted while its online page remains visible.
        if (!fits() && store === 'events' && retainedNewer) skip();
        else done();
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
