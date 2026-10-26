import { observe } from './notifications.ts';
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(`${code}: ${message}`);
  }
}
export function retryable(error: unknown) {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === 'TimeoutError') ||
    (error instanceof ApiError &&
      (error.status === 429 || error.status >= 500) &&
      error.code !== 'RESULT_UNKNOWN')
  );
}
export async function api(
  path: string,
  data?: unknown,
  signal?: AbortSignal,
  requestId?: string,
): Promise<any> {
  const response = await fetch('/api/v1' + path, {
    method: data === undefined ? 'GET' : 'POST',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      'X-CoC-Async': '1',
      'Idempotency-Key': requestId || crypto.randomUUID(),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  let result: any;
  try {
    result = await response.json();
  } catch {
    throw new ApiError(
      'INVALID_RESPONSE',
      '服务器返回了无法读取的响应',
      response.ok ? 502 : response.status,
    );
  }
  if (!response.ok)
    throw new ApiError(
      result.error?.code || 'HTTP_ERROR',
      result.error?.message || '请求失败',
      response.status,
    );
  if (
    /^\/(hosts|sessions)(?:[/?]|$)/.test(path) &&
    response.headers.get('X-CoC-Demand') !== '1'
  )
    throw new ApiError(
      'UPGRADE_REQUIRED',
      'Upgrade Relay for demand-v1 asynchronous requests',
      409,
    );
  if (response.status === 202 && result.accepted === true) {
    return waitOperation(result.hostId, result.operationId, signal);
  }
  return result;
}
function waitOperation(
  hostId: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<any> {
  return new Promise((resolve, reject) => {
    let ended = false,
      running = false,
      dirty = false;
    let stop = () => {};
    const finish = (error?: unknown, result?: unknown) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      stop();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () =>
      finish(signal?.reason || new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(
      () =>
        finish(
          new ApiError(
            'RESULT_UNKNOWN',
            `未确认，请刷新并核对原请求结果 (${operationId})`,
            504,
          ),
        ),
      15000,
    );
    const read = async () => {
      if (ended) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      dirty = false;
      try {
        const receipt = await api(
          `/hosts/${hostId}/operations/${operationId}`,
          undefined,
          signal,
        );
        if (receipt.state === 'completed') {
          void api(`/hosts/${hostId}/operations/${operationId}`, {}).catch(
            () => {},
          );
          if (receipt.error)
            finish(
              new ApiError(
                receipt.error.code,
                receipt.error.message,
                receipt.error.status || 409,
              ),
            );
          else finish(undefined, receipt.result);
        }
      } catch (error) {
        finish(error);
      } finally {
        running = false;
        if (dirty && !ended) void read();
      }
    };
    stop = observe(`/ws/v1/hosts/${hostId}`, (event) => {
      if (
        event.type === 'subscribed' ||
        (event.type === 'change' && event.operationId === operationId)
      )
        void read();
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
