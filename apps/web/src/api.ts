import { endpointHost, endpointRequest, ChannelError } from './channel.ts';
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
      (error.status === 429 ||
        error.status >= 500 ||
        error.code === 'STALE_AGENT') &&
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
  if (endpointHost(path, data)) {
    try {
      const packet = await endpointRequest(
        path,
        data,
        originalId,
        signal,
        operation
          ? { instance: operation.instance, ack: operation.ack }
          : undefined,
        headers,
      );
      if (operation && packet.intent !== undefined) {
        const proof = operationIntentSchema.parse(packet.intent);
        if (
          proof.instance !== operation.instance ||
          proof.owner !== operation.owner ||
          proof.requestId !== originalId ||
          (proof.ack ?? false) !== (operation.ack ?? false)
        )
          throw new ApiError(
            'DELIVERY_STATE_MISMATCH',
            'Endpoint receipt identity mismatch',
            409,
          );
        await operation.commit(
          packet.error ? { error: packet.error } : { data: packet.data },
          proof,
        );
      } else if (operation && !packet.error)
        throw new ApiError('RESULT_UNKNOWN', 'Missing endpoint receipt', 409);
      if (packet.error)
        throw new ApiError(
          packet.error.code,
          packet.error.message,
          packet.error.status ||
            (packet.error.code === 'UNAUTHORIZED'
              ? 401
              : packet.error.code === 'FORBIDDEN'
                ? 403
                : packet.error.code === 'BACKPRESSURE'
                  ? 429
                  : [
                        'HOST_OFFLINE',
                        'AGENT_OFFLINE',
                        'CODEX_EXITED',
                        'INTERNAL_ERROR',
                      ].includes(packet.error.code)
                    ? 503
                    : packet.error.code === 'TIMEOUT'
                      ? 504
                      : 409),
        );
      return packet.data;
    } catch (error) {
      if (error instanceof ChannelError)
        throw new ApiError(error.code, error.message, error.status);
      throw error;
    }
  }
  if (
    /^\/sessions(?:[/?]|$)/.test(path) ||
    /^\/(?:admin\/)?hosts\/[^/]+\/(?:projects|project-management|probe|threads|files|terminal|configuration|build|operations)(?:[/?]|$)/.test(
      path,
    )
  )
    throw new ApiError(
      'INVALID_REQUEST',
      '缺少加密业务目标或使用了过期接口',
      400,
    );
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
  if (response.status === 202)
    throw new ApiError('UPGRADE_REQUIRED', '业务结果必须由加密端点确认', 409);
  if (operation)
    throw new ApiError(
      'UPGRADE_REQUIRED',
      'Original operation requires endpoint receipt forwarding',
      409,
    );
  if (path === '/admin/hosts' && Array.isArray(result)) {
    await Promise.all(
      result
        .filter((h: any) => h.online)
        .map(async (h: any) => {
          try {
            h.build = await api(
              `/admin/hosts/${h.id}/build`,
              undefined,
              signal,
            );
          } catch {
            /* A lost endpoint does not hide the connection directory. */
          }
        }),
    );
  }
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
