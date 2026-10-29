import { eventBytes } from './events.ts';
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
  private generation = 0;
  private live = new Map<number, Event>();
  private liveBytes = 0;
  private liveTimer?: ReturnType<typeof setTimeout>;
  private liveJob?: Promise<void>;
  private liveCheckpoint?: number;
  private checkpointSafe = true;
  private liveError: (error: unknown) => void = () => {};
  private closed = false;
  private draftTimer?: ReturnType<typeof setTimeout>;
  private draftValue?: string;
  saveDraft(value: string): Promise<void> {
    this.draftValue = value;
    clearTimeout(this.draftTimer);
    // A shared, bounded timer; callers observe errors when it flushes.
    return this.recordDraftLater();
  }
  private draftWait?: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  private recordDraftLater() {
    if (!this.draftWait) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const promise = new Promise<void>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      this.draftWait = { promise, resolve, reject };
    }
    this.draftTimer = setTimeout(() => {
      void this.record('draft', this.draftValue).catch(() => {});
    }, 150);
    return this.draftWait.promise;
  }
  private range() {
    return IDBKeyRange.bound([this.scope], [this.scope, []], false, true);
  }
  writeLive(
    event: Event,
    onError: (error: unknown) => void,
    checkpoint?: number,
  ) {
    if (this.closed) return;
    const old = this.live.get(event.seq);
    if (old && (old.revision ?? old.seq) >= (event.revision ?? event.seq))
      return;
    const bytes =
      this.liveBytes - (old ? eventBytes(old) : 0) + eventBytes(event);
    if (bytes > 192 * 1024 || (!old && this.live.size >= 400)) {
      this.checkpointSafe = false;
      onError(
        new Error(
          'Local cache write budget exhausted; replay remains available',
        ),
      );
      return;
    }
    this.live.set(event.seq, event);
    if (checkpoint !== undefined)
      this.liveCheckpoint = Math.max(this.liveCheckpoint ?? 0, checkpoint);
    this.liveBytes = bytes;
    this.liveError = onError;
    if (!this.liveTimer && !this.liveJob) {
      this.liveTimer = setTimeout(() => {
        this.liveTimer = undefined;
        void this.flushLive();
      }, 20);
    }
  }
  private async flushLive(): Promise<void> {
    if (this.liveJob) await this.liveJob;
    if (!this.live.size) return;
    const events = [...this.live.values()];
    const checkpoint = this.liveCheckpoint;
    this.liveCheckpoint = undefined;
    this.live.clear();
    this.liveBytes = 0;
    const job = this.write(events, checkpoint).catch((error) => {
      this.checkpointSafe = false;
      this.liveError(error);
    });
    this.liveJob = job;
    await job;
    if (this.liveJob === job) this.liveJob = undefined;
    if (this.live.size && !this.closed && !this.liveTimer) {
      this.liveTimer = setTimeout(() => {
        this.liveTimer = undefined;
        void this.flushLive();
      }, 20);
    }
  }
  constructor(private scope: string) {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open('coc-history', 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('events'))
          request.result.createObjectStore('events', {
            keyPath: ['scope', 'seq'],
          });
        if (!request.result.objectStoreNames.contains('pages'))
          request.result.createObjectStore('pages');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.liveTimer);
    const draft = this.draftValue;
    void Promise.allSettled([
      this.flushLive(),
      draft === undefined ? Promise.resolve() : this.record('draft', draft),
    ]).finally(() => {
      void this.db.then((db) => db.close()).catch(() => {});
    });
  }
  async latest(): Promise<{ events: Event[]; checkpoint?: number }> {
    await this.flushLive();
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
    const generation = this.generation;
    const db = await this.db;
    if (generation !== this.generation) return;
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
      if (checkpoint !== undefined && this.checkpointSafe) {
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
  async writeSnapshot(
    events: Event[],
    checkpoint: number | undefined,
    before?: number,
    page?: HistoryPage,
  ) {
    // A snapshot can acknowledge live frames already received in RAM. Commit
    // those frames first; never persist a cursor past a failed cache write.
    await this.flushLive();
    try {
      await this.write(events, checkpoint, before, page);
    } catch (error) {
      this.checkpointSafe = false;
      throw error;
    }
  }
  async recent(): Promise<HistoryPage | undefined> {
    const latest = await this.latest();
    const page = await this.page(0);
    if (page && page.events.at(-1)?.seq === latest.events.at(-1)?.seq)
      return page;
    if (!latest.events.length) return undefined;
    return {
      events: latest.events,
      more: true,
      cursor: latest.events[0].seq,
      snapshotSeq: latest.checkpoint ?? 0,
      direction: 'before',
    };
  }
  async page(before: number): Promise<HistoryPage | undefined> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['events', 'pages']);
      let page: HistoryPage | undefined;
      const use = (stored: HistoryPage, exact: boolean) => {
        const events = exact
          ? stored.events
          : stored.events.filter((event) => event.seq < before);
        if (!events.length && !exact) return false;
        page = { ...stored, events, cursor: events[0]?.seq ?? stored.cursor };
        page.events.forEach((event, index) => {
          const updated = tx.objectStore('events').get([this.scope, event.seq]);
          updated.onsuccess = () => {
            if (updated.result) page!.events[index] = updated.result.event;
          };
        });
        return true;
      };
      const findCovering = () => {
        const cursor = tx
          .objectStore('pages')
          .openCursor(
            IDBKeyRange.bound(
              [this.scope, before],
              [this.scope, Number.MAX_SAFE_INTEGER],
            ),
          );
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          if (!use(row.value, false)) row.continue();
        };
      };
      const request = tx.objectStore('pages').get([this.scope, before]);
      request.onsuccess = () => {
        if (request.result) {
          use(request.result, true);
          return;
        }
        if (!before) return;
        const recent = tx.objectStore('pages').get([this.scope, 0]);
        recent.onsuccess = () => {
          if (
            !recent.result ||
            before > (recent.result.events.at(-1)?.seq ?? -Infinity) + 1 ||
            !use(recent.result, false)
          )
            findCovering();
        };
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
    const generation = this.generation;
    const db = await this.db;
    if (value !== undefined && generation !== this.generation) return;
    const result = await new Promise((resolve, reject) => {
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
    return result;
  }
  async record(key: string, value?: unknown): Promise<any> {
    const waiting =
      key === 'draft' && value !== undefined ? this.draftWait : undefined;
    if (key === 'draft' && value !== undefined) {
      clearTimeout(this.draftTimer);
      this.draftValue = undefined;
      this.draftWait = undefined;
    }
    try {
      const result = await this.recordValue(key, value);
      waiting?.resolve();
      return result;
    } catch (error) {
      waiting?.reject(error);
      throw error;
    }
  }
  private async recordValue(key: string, value?: unknown): Promise<any> {
    if (
      value !== undefined &&
      new TextEncoder().encode(JSON.stringify(value)).length > 4 * 1024 * 1024
    )
      throw new Error('Local cache record exceeds its 4 MiB budget');
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
    this.generation++;
    this.liveCheckpoint = undefined;
    this.checkpointSafe = true;
    clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    this.live.clear();
    this.liveBytes = 0;
    if (this.liveJob) await this.liveJob;
    const db = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['events', 'pages'], 'readwrite');
      for (const name of ['events', 'pages']) {
        const request = tx.objectStore(name).openCursor(this.range());
        request.onsuccess = () => {
          const row = request.result;
          if (!row) return;
          if (
            (name === 'events'
              ? row.value.scope
              : (row.key as IDBValidKey[])[0]) === this.scope
          )
            if (
              name === 'events' ||
              !['draft', 'pending'].includes(
                String((row.key as IDBValidKey[])[1]),
              )
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
