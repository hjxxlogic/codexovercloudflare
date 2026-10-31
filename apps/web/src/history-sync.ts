// Record sequence identifies a row; revision identifies its latest change.
// Only two watermarks are retained. A predecessor proves an unbroken live
// delivery; otherwise a snapshot fills the gap before advancing received.
export class HistorySync {
  received: number | undefined;
  maximum = 0;
  private valid(value: unknown): value is number {
    return (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    );
  }
  restore(value: number | undefined) {
    if (this.valid(value)) this.received = Math.max(this.received ?? 0, value);
  }
  observe(maximum: unknown, previous: unknown) {
    if (!this.valid(maximum)) return;
    this.maximum = Math.max(this.maximum, maximum);
    if (
      this.received !== undefined &&
      previous === this.received &&
      maximum >= this.received
    )
      this.received = maximum;
  }
  snapshot(page: {
    direction: string;
    more: boolean;
    cursor: number;
    snapshotSeq: number;
  }) {
    if (!this.valid(page.snapshotSeq)) return;
    this.maximum = Math.max(this.maximum, page.snapshotSeq);
    const received =
      page.direction === 'after' && page.more ? page.cursor : page.snapshotSeq;
    if (this.valid(received))
      this.received = Math.max(this.received ?? 0, received);
  }
  get missing() {
    return this.received !== undefined && this.maximum > this.received;
  }
}
