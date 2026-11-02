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
  if (
    error instanceof TypeError &&
    /failed to fetch|networkerror|load failed/i.test(error.message)
  )
    return '网络请求未能完成，请检查网络后刷新状态；未确认的任务已保留，请勿重复发送。';
  if (error instanceof Error && error.message.startsWith('STALE_AGENT:'))
    return 'Agent 正在恢复连接，请稍后刷新状态；未确认的任务已保留。';
  return error instanceof Error ? error.message : String(error);
}
