export type ListOptions = {
  prefix?: string;
  startAfter?: string;
  end?: string;
  limit?: number;
};
export interface StateTransaction {
  get<T = any>(key: string): Promise<T | undefined>;
  put(key: string | Record<string, unknown>, value?: unknown): Promise<unknown>;
  delete(key: string | string[]): Promise<unknown>;
  list<T = any>(options?: ListOptions): Promise<Map<string, T>>;
}
// Complete directory scans must not silently inherit a backend's page limit.
// Explicitly paged operations continue to use list() directly.
export async function listAll<T = any>(
  storage: StateTransaction,
  options: Omit<ListOptions, 'limit'> = {},
): Promise<Map<string, T>> {
  const entries = new Map<string, T>();
  let startAfter = options.startAfter;
  for (;;) {
    const page = await storage.list<T>({ ...options, startAfter, limit: 256 });
    for (const [key, value] of page) entries.set(key, value);
    if (page.size < 256) return entries;
    startAfter = [...page.keys()].at(-1);
  }
}

export interface StateStorage extends StateTransaction {
  transaction<T>(callback: (tx: StateTransaction) => Promise<T>): Promise<T>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<unknown>;
  deleteAlarm(): Promise<unknown>;
}
