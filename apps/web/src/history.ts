import type { Event } from '../../../packages/protocol/src/index.ts';

export type HistoryPage = {
  events: Event[];
  more: boolean;
  cursor: number;
  snapshotSeq: number;
  direction: 'before' | 'after';
};

// Every record is scoped by relay origin, credential identity, host and session.
export class HistoryCache {
  private db: Promise<IDBDatabase>;
  constructor(private scope: string) {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open('coc-history', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('events', {
          keyPath: ['scope', 'seq'],
        });
        request.result.createObjectStore('pages');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async latest(): Promise<{ events: Event[]; checkpoint?: number }> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['events', 'pages']);
      const events: Event[] = [];
      let checkpoint: number | undefined;
      let bytes = 0;
      const cursor = tx
        .objectStore('events')
        .openCursor(
          IDBKeyRange.bound(
            [this.scope, -Number.MAX_SAFE_INTEGER],
            [this.scope, Number.MAX_SAFE_INTEGER],
          ),
          'prev',
        );
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row || events.length >= 200) return;
        const event = row.value.event as Event;
        const size = new TextEncoder().encode(JSON.stringify(event)).length;
        if (bytes + size > 96 * 1024) return;
        events.unshift(event);
        bytes += size;
        row.continue();
      };
      const meta = tx.objectStore('pages').get([this.scope, 'checkpoint']);
      meta.onsuccess = () => {
        checkpoint = meta.result;
      };
      tx.oncomplete = () => resolve({ events, checkpoint });
      tx.onerror = () => reject(tx.error);
    });
  }
  async write(
    events: Event[],
    checkpoint?: number,
    before?: number,
    page?: HistoryPage,
  ) {
    const db = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['events', 'pages'], 'readwrite');
      for (const event of events) {
        const store = tx.objectStore('events');
        const previous = store.get([this.scope, event.seq]);
        previous.onsuccess = () => {
          const old = previous.result?.event as Event | undefined;
          if (
            !old ||
            (event.revision ?? event.seq) >= (old.revision ?? old.seq)
          )
            store.put({ scope: this.scope, seq: event.seq, event });
        };
      }
      if (checkpoint !== undefined) {
        const store = tx.objectStore('pages');
        const previous = store.get([this.scope, 'checkpoint']);
        previous.onsuccess = () =>
          store.put(Math.max(checkpoint, previous.result ?? 0), [
            this.scope,
            'checkpoint',
          ]);
      }
      if (before !== undefined && page)
        tx.objectStore('pages').put(page, [this.scope, before]);
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error || new Error('Local history write aborted'));
      tx.onerror = () => reject(tx.error);
    });
  }
  async page(before: number): Promise<HistoryPage | undefined> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['events', 'pages']);
      let page: HistoryPage | undefined;
      const request = tx.objectStore('pages').get([this.scope, before]);
      request.onsuccess = () => {
        page = request.result;
        page?.events.forEach((event, index) => {
          const updated = tx.objectStore('events').get([this.scope, event.seq]);
          updated.onsuccess = () => {
            if (updated.result) page!.events[index] = updated.result.event;
          };
        });
      };
      tx.oncomplete = () => resolve(page);
      tx.onerror = () => reject(tx.error);
    });
  }
  async content(
    seq: number,
    offset: number,
    revision: number,
    value?: unknown,
  ): Promise<any> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        'pages',
        value === undefined ? 'readonly' : 'readwrite',
      );
      const key = [this.scope, `content:${seq}:${revision}:${offset}`];
      const request =
        value === undefined
          ? tx.objectStore('pages').get(key)
          : tx.objectStore('pages').put(value, key);
      tx.oncomplete = () => resolve(value ?? request.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  async record(key: string, value?: unknown): Promise<any> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        'pages',
        value === undefined ? 'readonly' : 'readwrite',
      );
      const request =
        value === undefined
          ? tx.objectStore('pages').get([this.scope, key])
          : tx.objectStore('pages').put(value, [this.scope, key]);
      tx.oncomplete = () => resolve(value ?? request.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  async clear() {
    const db = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['events', 'pages'], 'readwrite');
      for (const name of ['events', 'pages']) {
        const request = tx.objectStore(name).openCursor();
        request.onsuccess = () => {
          const row = request.result;
          if (!row) return;
          if (
            (name === 'events'
              ? row.value.scope
              : (row.key as IDBValidKey[])[0]) === this.scope
          )
            row.delete();
          row.continue();
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
