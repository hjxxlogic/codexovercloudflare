import { AppError, MAX_QUEUE } from '../../../packages/protocol/src/index.ts';

// Pure forwarding correlations. Nothing in this container can be archived or
// recovered by a new DO instance; endpoints recover using their original request identity.
export class TransientOperations<
  T extends { id: string; wire?: string; expires: number; state: string },
> {
  private records = new Map<string, { value: T; bytes: number }>();
  private wires = new Map<string, string>();
  private bytes = 0;
  private sweep() {
    for (const [id, record] of this.records)
      if (record.value.expires <= Date.now()) this.delete(id);
  }
  save(value: T) {
    this.sweep();
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    const previous = this.records.get(value.id);
    if (
      (!previous && this.records.size >= 128) ||
      this.bytes - (previous?.bytes ?? 0) + bytes > MAX_QUEUE
    )
      throw new AppError(
        'BACKPRESSURE',
        'Temporary forwarding budget exhausted',
        429,
      );
    this.delete(value.id);
    this.records.set(value.id, { value: structuredClone(value), bytes });
    this.bytes += bytes;
    if (value.wire && value.state === 'pending')
      this.wires.set(value.wire, value.id);
  }
  get(id: string): T | undefined {
    this.sweep();
    const value = this.records.get(id)?.value;
    return value && structuredClone(value);
  }
  find(predicate: (value: Readonly<T>) => boolean): T | undefined {
    this.sweep();
    for (const record of this.records.values())
      if (predicate(record.value)) return structuredClone(record.value);
    return undefined;
  }
  wire(wire: string): string | undefined {
    this.sweep();
    return this.wires.get(wire);
  }
  delete(id: string) {
    const previous = this.records.get(id);
    if (!previous) return;
    this.records.delete(id);
    if (previous.value.wire) this.wires.delete(previous.value.wire);
    this.bytes -= previous.bytes;
  }
}
