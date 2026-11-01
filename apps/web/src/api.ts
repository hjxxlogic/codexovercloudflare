import { observe } from './notifications.ts';
import { relayPath } from './routes.ts';
import {
  idSchema,
  operationIntentSchema,
  type OperationIntent,
} from '../../../packages/protocol/src/index.ts';
export type OperationExchange = {
  instance: string;
  owner: string;
  ack?: boolean;
  commit: (
    envelope: { data?: unknown; error?: unknown },
    receipt: OperationIntent,
  ) => Promise<void>;
};
let emailAccount = '';
const restoredHosts = new Map<string, Promise<void>>();
export function setEmailAccount(accountId: string) {
  if (emailAccount !== accountId) restoredHosts.clear();
  emailAccount = accountId;
}
export function forgetEmailHost(hostId: string) {
  restoredHosts.delete(hostId);
}
export async function ensureEmailHost(hostId: string) {
  if (!emailAccount || !hostId) return;
  let restored = restoredHosts.get(hostId);
  if (!restored) {
    restored = api('/auth/email/restore', { hostId }).then(() => {});
    restoredHosts.set(hostId, restored);
    restored.catch(() => restoredHosts.delete(hostId));
  }
  await restored;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(`${code}: ${message}`);
  }
}
export function authorizationFailed(error: unknown) {
  return error instanceof ApiError && [401, 403].includes(error.status);
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
  headers?: Record<string, string>,
  operation?: OperationExchange,
): Promise<any> {
  const originalId = requestId || crypto.randomUUID();
  if (operation) {
    idSchema.parse(originalId);
    idSchema.parse(operation.instance);
    if (data === undefined)
      throw new ApiError(
        'INVALID_REQUEST',
        'Original operation requires its fixed body',
        400,
      );
  }
  if (emailAccount && /^\/(hosts\/|sessions|client\/)/.test(path)) {
    const url = new URL(path, location.origin);
    const hostId =
      path.match(/^\/hosts\/([\w-]+)/)?.[1] ||
      url.searchParams.get('hostId') ||
      (data as { hostId?: string } | undefined)?.hostId;
    if (hostId) await ensureEmailHost(hostId);
  }
  const response = await fetch(relayPath('/api/v1' + path), {
    method: data === undefined ? 'GET' : 'POST',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      'X-CoC-Async': '1',
      'X-CoC-Delivery': '2',
      'Idempotency-Key': originalId,
      ...headers,
      ...(operation
        ? {
            'Idempotency-Key': originalId,
            'X-CoC-Operation-Instance': operation.instance,
            ...(operation.ack ? { 'X-CoC-Operation-Ack': '1' } : {}),
          }
        : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const html = response.headers.get('Content-Type')?.includes('text/html');
  // Gateway and rate-limit pages do not imply an expired Access identity.
  // Preserve their status so snapshot recovery does not clear the login state.
  if (html && (response.status === 429 || response.status >= 500))
    throw new ApiError(
      'HTTP_ERROR',
      `服务暂时不可用（HTTP ${response.status}），请稍后刷新`,
      response.status,
    );
  if (response.redirected || html)
    throw new ApiError(
      'ACCESS_REQUIRED',
      '请重新打开网站完成 Cloudflare 邮箱登录',
      401,
    );
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
    (response.headers.get('X-CoC-Demand') !== '1' ||
      response.headers.get('X-CoC-Delivery') !== '2')
  )
    throw new ApiError(
      'UPGRADE_REQUIRED',
      'Upgrade Relay for delivery:2 asynchronous requests',
      409,
    );
  if (response.status === 202 && result.accepted === true) {
    return waitOperation(
      result.hostId,
      result.operationId,
      signal,
      path.startsWith('/admin/'),
      operation ? { ...operation, requestId: originalId } : undefined,
    );
  }
  if (operation)
    throw new ApiError(
      'UPGRADE_REQUIRED',
      'Original operation requires endpoint receipt forwarding',
      409,
    );
  return result;
}
// GET reads and explicitly read-only POST queries may be repeated after the
// relay loses a forwarding correlation. Mutations continue to use api().
export async function readApi(
  path: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
) {
  return queryApi(path, undefined, signal, headers);
}
export async function queryApi(
  path: string,
  data?: unknown,
  signal?: AbortSignal,
  headers?: Record<string, string>,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api(path, data, signal, undefined, headers);
    } catch (error) {
      if (
        signal?.aborted ||
        attempt >= 2 ||
        !(
          retryable(error) ||
          (error instanceof ApiError && error.code === 'RESULT_UNKNOWN')
        )
      )
        throw error;
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const timer = setTimeout(finish, 500 * 2 ** attempt);
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }
}
function waitOperation(
  hostId: string,
  operationId: string,
  signal?: AbortSignal,
  admin = false,
  operation?: OperationExchange & { requestId: string },
): Promise<any> {
  return new Promise((resolve, reject) => {
    let ended = false,
      running = false,
      dirty = false,
      attempts = 0;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const reading = new AbortController();
    let stop = () => {};
    const finish = (error?: unknown, result?: unknown) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(poll);
      reading.abort();
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
      30000,
    );
    const read = async () => {
      if (ended) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      dirty = false;
      clearTimeout(poll);
      try {
        const receipt = await api(
          `${admin ? '/admin' : ''}/hosts/${hostId}/operations/${operationId}`,
          undefined,
          reading.signal,
        );
        if (ended) return;
        if (receipt.state === 'completed') {
          if (operation) {
            if (receipt.intent !== undefined) {
              const proof = operationIntentSchema.safeParse(receipt.intent);
              if (
                !proof.success ||
                proof.data.instance !== operation.instance ||
                proof.data.requestId !== operation.requestId ||
                proof.data.owner !== operation.owner ||
                (proof.data.ack ?? false) !== (operation.ack ?? false)
              )
                throw new ApiError(
                  'DELIVERY_STATE_MISMATCH',
                  'Endpoint receipt belongs to another original operation',
                  409,
                );
              if (receipt.error === undefined && receipt.result === undefined)
                throw new ApiError(
                  'INVALID_RESPONSE',
                  'Missing original operation result',
                  502,
                );
              await operation.commit(
                receipt.error === undefined
                  ? { data: receipt.result }
                  : { error: receipt.error },
                proof.data,
              );
              if (ended) return;
            } else if (receipt.error === undefined)
              throw new ApiError(
                'RESULT_UNKNOWN',
                'Endpoint did not confirm a durable original result',
                409,
              );
          }
          void api(
            `${admin ? '/admin' : ''}/hosts/${hostId}/operations/${operationId}`,
            {},
          ).catch(() => {});
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
        if (!ended && !retryable(error)) finish(error);
      } finally {
        running = false;
        if (dirty && !ended) void read();
        else if (!ended)
          poll = setTimeout(
            () => void read(),
            Math.min(2000, 250 * 2 ** Math.min(attempts++, 3)),
          );
      }
    };
    if (!admin)
      stop = observe(`/ws/v1/hosts/${hostId}`, (event) => {
        if (
          event.type === 'subscribed' ||
          (event.type === 'change' && event.operationId === operationId)
        )
          void read();
      });
    if (signal?.aborted) abort();
    else {
      signal?.addEventListener('abort', abort, { once: true });
      // Notifications accelerate completion; a missed/delayed subscription
      // cannot strand a committed result. Only this receipt is retried, and
      // only while the original request is outstanding. Never resend work.
      void read();
    }
  });
}
