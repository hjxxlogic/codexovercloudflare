// Bound the UI wait even when an underlying storage or transport read stalls.
// Callers check the signal between stages to avoid starting work after expiry.
export async function boundedRefresh(
  action: (signal: AbortSignal) => Promise<void>,
  timeout = 20000,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      action(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('刷新超时，已恢复操作；请稍后重试。');
          controller.abort(error);
          reject(error);
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function requestErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.name === 'AbortError') return undefined;
  if (error instanceof Error && error.name === 'TimeoutError')
    return '请求超时，请刷新重试。';
  return error instanceof Error ? error.message : String(error);
}
