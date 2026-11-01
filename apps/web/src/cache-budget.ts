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
};
const charge = (key: IDBValidKey, value: unknown) =>
  new TextEncoder().encode(JSON.stringify([key, value])).length + 512;

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
          // Retain the promise across disconnect, clear and page closure. A new
          // tab cannot obtain a second promise without the same global debit.
          const reserved = ledger.commands[identity] ?? 0;
          if (
            value === undefined ||
            size > cacheLimits.commandReservation ||
            (!reserved &&
              Object.values(ledger.commands).reduce((a, b) => a + b, 0) +
                cacheLimits.commandReservation >
                cacheLimits.commandBytes)
          ) {
            this.fail();
            return;
          }
          ledger.commands[identity] = cacheLimits.commandReservation;
        } else {
          const delta = size - previous;
          if (
            ledger.bytes + delta > cacheLimits.bytes ||
            own.bytes + delta > cacheLimits.scopeBytes ||
            ledger.records + records > cacheLimits.records ||
            own.records + records > cacheLimits.scopeRecords ||
            (!ledger.scopes[scopeKey] &&
              Object.keys(ledger.scopes).length >= cacheLimits.scopes)
          ) {
            this.fail();
            return;
          }
          ledger.bytes += delta;
          ledger.records += records;
          own.bytes += delta;
          own.records += records;
          if (own.records) ledger.scopes[scopeKey] = own;
          else delete ledger.scopes[scopeKey];
        }
        const written =
          value === undefined
            ? data.delete(key)
            : store === 'events'
              ? data.put(value)
              : data.put(value, key);
        this.tx.objectStore('pages').put(ledger, ledgerKey);
        written.onsuccess = () => {
          this.busy = false;
          this.next();
        };
      };
    });
    this.next();
  }
  private fail() {
    this.error = new Error(
      'BACKPRESSURE: Global or session local storage budget exhausted; pending work was preserved',
    );
    this.tx.abort();
  }
}
