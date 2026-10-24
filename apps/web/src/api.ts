export async function api(
  path: string,
  data?: unknown,
  signal?: AbortSignal,
): Promise<any> {
  const r = await fetch('/api/v1' + path, {
    method: data === undefined ? 'GET' : 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const b: any = await r.json();
  if (!r.ok) throw new Error(b.error?.code + ': ' + b.error?.message);
  return b;
}
