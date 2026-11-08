import { recoveryDelay } from './recovery.ts';
// Only endpoint checkpoints and a bounded notification are retained per reader.
// A dirty hint never acknowledges data: only a committed cache revision does.
type Saved = {
  stream: string;
  instance: string;
  agentInstance?: string;
  streamSerial?: number;
  creditGeneration?: string;
  acknowledgedRevision: number;
};
type Cache = {
  durableRevision: number | undefined;
  updateRecord<T>(key: string, update: (previous: unknown) => T): Promise<T>;
};
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export class HistorySubscription {
  private exchangeId = '';
  private send?: (frame: unknown) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private maximum = 0;
  private published = 0;
  private released: number | undefined;
  private opened = false;
  private stopped = false;
  private pending?: { requestId: string; revision: number };
  private tail = Promise.resolve();
  private checkpointTail = Promise.resolve();
  private queued = 0;
  private queuedBytes = 0;
  private constructor(
    private cache: Cache,
    private key: string,
    private saved: Saved,
    private dirty: (maximum: number) => void,
    private ready: () => void,
    private failure: (error: Error) => void,
  ) {}
  static async create(
    cache: Cache,
    key: string,
    dirty: (maximum: number) => void,
    ready: () => void,
    failure: (error: Error) => void,
  ) {
    const initial = {
      stream: crypto.randomUUID(),
      instance: crypto.randomUUID(),
      acknowledgedRevision: 0,
    };
    const saved = await cache.updateRecord(
      key,
      (previous) => (previous ?? initial) as Saved,
    );
    if (
      !revision(saved.acknowledgedRevision) ||
      saved.acknowledgedRevision > (cache.durableRevision ?? 0)
    )
      throw new Error('本地历史确认水位发生回退，已停止自动恢复。');
    return new HistorySubscription(cache, key, saved, dirty, ready, failure);
  }
  connect(send: (frame: unknown) => void) {
    this.disconnect();
    if (this.stopped) return;
    this.send = send;
    this.exchangeId = crypto.randomUUID();
    this.attempts = 0;
    this.published = this.cache.durableRevision ?? 0;
    this.pending = {
      requestId: crypto.randomUUID(),
      revision: this.cache.durableRevision ?? 0,
    };
    return this.transmit();
  }
  disconnect() {
    clearTimeout(this.timer);
    this.send = undefined;
    this.exchangeId = '';
    this.opened = false;
    this.released = undefined;
    this.pending = undefined;
  }
  stop() {
    this.stopped = true;
    this.disconnect();
  }
  private freeze(error: string | Error) {
    this.stop();
    this.failure(typeof error === 'string' ? new Error(error) : error);
  }
  private checkpoint<T>(action: () => Promise<T>) {
    const result = this.checkpointTail.then(action);
    this.checkpointTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private assertSaved(previous: unknown) {
    if (JSON.stringify(previous) !== JSON.stringify(this.saved))
      throw new Error('历史订阅已被其他页面清除或修改，已停止自动恢复。');
  }
  private async transmit() {
    const exchange = this.exchangeId;
    try {
      await this.checkpoint(async () => {
        if (
          exchange !== this.exchangeId ||
          !this.send ||
          !this.pending ||
          this.stopped
        )
          return;
        await this.cache.updateRecord(this.key, (previous) => {
          this.assertSaved(previous);
          return this.saved;
        });
        if (
          exchange !== this.exchangeId ||
          !this.send ||
          !this.pending ||
          this.stopped
        )
          return;
        clearTimeout(this.timer);
        this.published = Math.max(this.published, this.pending.revision);
        this.send({
          operation: this.opened ? 'ack' : 'subscribe',
          requestId: this.pending.requestId,
          ...this.saved,
          exchangeId: this.exchangeId,
          receivedRevision: this.pending.revision,
          ...(this.opened && this.released !== undefined
            ? { releasedRevision: this.pending.revision }
            : {}),
        });
        const delay = recoveryDelay(this.attempts);
        this.attempts = Math.min(3, this.attempts + 1);
        this.timer = setTimeout(() => void this.transmit(), delay);
      });
    } catch (error) {
      this.freeze(error instanceof Error ? error : String(error));
    }
  }
  commit() {
    if (!this.opened || !this.send || this.stopped) return;
    const durable = Math.min(this.cache.durableRevision ?? 0, this.maximum);
    if (
      (durable <= this.saved.acknowledgedRevision &&
        (this.released === undefined || durable <= this.released)) ||
      durable <= (this.pending?.revision ?? -1)
    )
      return this.checkpointTail;
    this.pending = { requestId: crypto.randomUUID(), revision: durable };
    this.attempts = 0;
    return this.transmit();
  }
  handle(frame: any) {
    if (
      !['history-window', 'history-dirty', 'error'].includes(frame.type) ||
      this.stopped
    )
      return Promise.resolve();
    const bytes = new TextEncoder().encode(JSON.stringify(frame)).length;
    if (
      bytes > 4096 ||
      this.queued >= 32 ||
      this.queuedBytes + bytes > 64 * 1024
    ) {
      this.freeze('历史确认队列已满，已停止自动恢复。');
      return Promise.resolve();
    }
    this.queued++;
    this.queuedBytes += bytes;
    const exchange = this.exchangeId;
    this.tail = this.tail
      .then(async () => {
        if (!exchange || exchange !== this.exchangeId || this.stopped) return;
        if (frame.type === 'error') {
          if (
            frame.error?.code === 'HISTORY_SUBSCRIPTION_EXPIRED' &&
            this.send &&
            (frame.requestId === this.pending?.requestId ||
              (frame.stream === this.saved.stream &&
                frame.instance === this.saved.instance))
          ) {
            const send = this.send;
            await this.checkpoint(async () => {
              this.saved = await this.cache.updateRecord(
                this.key,
                (previous) => {
                  this.assertSaved(previous);
                  return {
                    stream: crypto.randomUUID(),
                    instance: crypto.randomUUID(),
                    acknowledgedRevision: 0,
                  };
                },
              );
            });
            await this.connect(send);
            return;
          }
          if (frame.requestId !== this.pending?.requestId) return;
          if (
            [
              'DELIVERY_STATE_MISMATCH',
              'STREAM_CLOSED',
              'FORBIDDEN',
              'UNAUTHORIZED',
            ].includes(frame.error?.code)
          )
            this.freeze(frame.error.message);
          return;
        }
        if (
          !['history-window', 'history-dirty'].includes(frame.type) ||
          frame.exchangeId !== exchange ||
          frame.stream !== this.saved.stream ||
          frame.instance !== this.saved.instance
        )
          return;
        if (
          typeof frame.agentInstance !== 'string' ||
          !revision(frame.streamSerial) ||
          frame.streamSerial < 1 ||
          typeof frame.creditGeneration !== 'string' ||
          !revision(frame.receivedRevision) ||
          !revision(frame.maxRevision)
        )
          return;
        if (
          (this.saved.agentInstance &&
            this.saved.agentInstance !== frame.agentInstance) ||
          (this.saved.streamSerial !== undefined &&
            this.saved.streamSerial !== frame.streamSerial) ||
          (this.saved.creditGeneration &&
            this.saved.creditGeneration !== frame.creditGeneration)
        ) {
          this.freeze('历史存储实例或订阅代际已改变，已停止自动恢复。');
          return;
        }
        if (frame.type === 'history-dirty') {
          if (!this.opened) return;
          this.maximum = Math.max(this.maximum, frame.maxRevision);
          this.dirty(this.maximum);
          await this.commit();
          return;
        }
        if (!this.opened && frame.requestId !== this.pending?.requestId) return;
        if (
          (!this.opened &&
            (frame.receivedRevision < this.saved.acknowledgedRevision ||
              frame.maxRevision < (this.pending?.revision ?? 0))) ||
          frame.receivedRevision > this.published ||
          frame.receivedRevision > (this.cache.durableRevision ?? 0) ||
          frame.receivedRevision > frame.maxRevision
        ) {
          this.freeze('历史持久水位发生回退，已停止自动恢复。');
          return;
        }
        if (frame.releasedRevision !== undefined) {
          if (
            !revision(frame.releasedRevision) ||
            frame.releasedRevision > frame.receivedRevision
          ) {
            this.freeze('历史引用释放位置无效，已停止自动恢复。');
            return;
          }
          this.released = Math.max(this.released ?? 0, frame.releasedRevision);
        }
        this.maximum = Math.max(this.maximum, frame.maxRevision);
        const next = {
          ...this.saved,
          agentInstance: frame.agentInstance,
          streamSerial: frame.streamSerial,
          creditGeneration: frame.creditGeneration,
          acknowledgedRevision: Math.max(
            this.saved.acknowledgedRevision,
            frame.receivedRevision,
          ),
        };
        await this.checkpoint(async () => {
          if (exchange !== this.exchangeId || this.stopped) return;
          await this.cache.updateRecord(this.key, (previous) => {
            this.assertSaved(previous);
            return next;
          });
          this.saved = next;
        });
        if (exchange !== this.exchangeId || this.stopped) return;
        const opening = !this.opened;
        this.opened = true;
        if (
          opening ||
          (this.pending &&
            frame.receivedRevision >= this.pending.revision &&
            (this.released === undefined ||
              this.released >= this.pending.revision))
        ) {
          this.pending = undefined;
          clearTimeout(this.timer);
        }
        if (opening) this.ready();
        if (this.maximum > (this.cache.durableRevision ?? 0))
          this.dirty(this.maximum);
        await this.commit();
      })
      .catch((error: unknown) =>
        this.freeze(error instanceof Error ? error : String(error)),
      )
      .finally(() => {
        this.queued--;
        this.queuedBytes -= bytes;
      });
    return this.tail;
  }
}
