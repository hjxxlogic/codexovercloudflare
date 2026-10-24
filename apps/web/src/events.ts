import type { Event } from '../../../packages/protocol/src/index.ts';

export function visibleEvents(events: Event[]) {
  const visible = new Set([
    'user',
    'item/agentMessage/delta',
    'turn/started',
    'turn/completed',
    'turn/diff/updated',
    'turn/plan/updated',
    'item/commandExecution/outputDelta',
    'item/fileChange/outputDelta',
    'item/started',
    'warning',
    'error',
    'approvalResolved',
    'sessionClosed',
  ]);
  const result: Event[] = [];
  const seen = new Set<number>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    if (!visible.has(event.type)) continue;
    if (
      event.type === 'item/started' &&
      !['commandExecution', 'fileChange', 'mcpToolCall'].includes(
        (event.data as any)?.item?.type,
      )
    )
      continue;
    const previous = result.at(-1);
    if (event.type.endsWith('/delta') || event.type.endsWith('/outputDelta')) {
      if (
        previous?.type === event.type &&
        (previous.data as any).itemId === (event.data as any).itemId
      ) {
        result[result.length - 1] = {
          ...previous,
          data: {
            ...(event.data as object),
            delta:
              ((previous.data as any).delta || '') +
              ((event.data as any).delta || ''),
          },
        };
        continue;
      }
    }
    result.push(event);
  }
  return result;
}
