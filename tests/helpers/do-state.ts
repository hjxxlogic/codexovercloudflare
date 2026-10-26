export class MemoryStorage {
  values = new Map<string, any>();
  alarm: number | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  async get<T = any>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key));
  }
  async put(key: string | Record<string, unknown>, value?: unknown) {
    for (const [name, data] of typeof key === 'string'
      ? [[key, value]]
      : Object.entries(key))
      this.values.set(name as string, structuredClone(data));
  }
  async delete(key: string | string[]) {
    for (const name of typeof key === 'string' ? [key] : key)
      this.values.delete(name);
  }
  async list<T = any>(
    options: {
      prefix?: string;
      startAfter?: string;
      end?: string;
      limit?: number;
    } = {},
  ): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(
          ([key]) =>
            (!options.prefix || key.startsWith(options.prefix)) &&
            (!options.startAfter || key > options.startAfter) &&
            (!options.end || key < options.end),
        )
        .slice(0, options.limit)
        .map(([key, value]) => [key, structuredClone(value)]),
    );
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(at: number) {
    this.alarm = at;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>) {
    const result = this.tail.then(() => callback(this));
    this.tail = result.catch(() => {});
    return result;
  }
}
