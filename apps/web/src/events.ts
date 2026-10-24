import type { Event } from '../../../packages/protocol/src/index.ts';

export function mergeEvents(events: Event[]) {
  const latest = new Map<number, Event>();
  for (const event of events) {
    const previous = latest.get(event.seq);
    if (
      !previous ||
      (event.revision ?? event.seq) >= (previous.revision ?? previous.seq)
    )
      latest.set(event.seq, event);
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

export function eventWindow(
  events: Event[],
  limit = 400,
  maxBytes = 192 * 1024,
) {
  const merged = mergeEvents(events);
  const encoder = new TextEncoder();
  let bytes = 0;
  let start = merged.length;
  while (start > 0 && merged.length - start < limit) {
    const size = encoder.encode(JSON.stringify(merged[start - 1])).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    start--;
  }
  return merged.slice(start);
}

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
    'item/completed',
    'warning',
    'error',
    'approvalResolved',
    'sessionClosed',
    'largeRpc',
  ]);
  const result: Event[] = [];
  const seen = new Set<number>();
  const fragments = new Map<string, number>();
  const tools = new Map<string, number>();
  for (const event of mergeEvents(events)) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    if (!visible.has(event.type) && event.contentSeq === undefined) continue;
    const data = event.data as any;
    if (event.contentSeq !== undefined) {
      result.push(event);
      continue;
    }
    if (['user', 'turn/started', 'turn/completed'].includes(event.type)) {
      fragments.clear();
      tools.clear();
    }
    if (['item/started', 'item/completed'].includes(event.type)) {
      if (
        !['commandExecution', 'fileChange', 'mcpToolCall'].includes(
          data.item?.type,
        )
      )
        continue;
      const previous = data.item.id ? tools.get(data.item.id) : undefined;
      if (previous !== undefined) {
        result[previous] = { ...event, seq: result[previous].seq };
        continue;
      }
      if (data.item.id) tools.set(data.item.id, result.length);
    }
    if (event.type.endsWith('/outputDelta')) {
      const index = data.itemId ? tools.get(data.itemId) : undefined;
      if (index !== undefined) {
        const previous = result[index];
        const item = (previous.data as any).item;
        result[index] = {
          ...previous,
          data: {
            item: {
              ...item,
              aggregatedOutput:
                (item.aggregatedOutput || '') + (data.delta || ''),
            },
          },
        };
        continue;
      }
    }
    if (event.type.endsWith('/delta') || event.type.endsWith('/outputDelta')) {
      const key = `${event.type}:${data.turnId || ''}:${data.itemId || ''}`;
      const index = data.itemId
        ? fragments.get(key)
        : result.at(-1)?.type === event.type
          ? result.length - 1
          : undefined;
      if (index !== undefined) {
        const previous = result[index];
        result[index] = {
          ...previous,
          data: {
            ...data,
            delta: ((previous.data as any).delta || '') + (data.delta || ''),
          },
        };
        continue;
      }
      fragments.set(key, result.length);
    }
    result.push(event);
  }
  return result;
}
