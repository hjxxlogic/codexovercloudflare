export type FileChange = {
  path: string;
  diff: string;
  kind?: { type?: string; move_path?: string; movePath?: string };
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Native history can store an item, its params, or the full event envelope.
export function fileChanges(
  text: string | Record<string, unknown>,
  partial = false,
): FileChange[] | undefined {
  let root;
  try {
    root = typeof text === 'string' ? record(JSON.parse(text)) : text;
  } catch {
    return undefined;
  }
  const item = record(record(root?.data)?.item) ?? record(root?.item) ?? root;
  if (!Array.isArray(item?.changes)) return undefined;
  const changes: FileChange[] = [];
  for (const value of item.changes) {
    const change = record(value);
    if (
      typeof change?.path !== 'string' ||
      (!partial && typeof change.diff !== 'string')
    ) {
      if (partial) continue;
      return undefined;
    }
    const kind = record(change.kind);
    changes.push({
      path: change.path,
      diff: typeof change.diff === 'string' ? change.diff : '',
      kind: kind
        ? {
            type: typeof kind.type === 'string' ? kind.type : undefined,
            move_path:
              typeof kind.move_path === 'string' ? kind.move_path : undefined,
            movePath:
              typeof kind.movePath === 'string' ? kind.movePath : undefined,
          }
        : undefined,
    });
  }
  return changes;
}

export function diffLines(diff: string) {
  let inHunk = false;
  return diff.split('\n').map((text) => {
    if (text.startsWith('diff --git ')) inHunk = false;
    if (text.startsWith('@@ ')) inHunk = true;
    const kind =
      !inHunk && (text.startsWith('+++ ') || text.startsWith('--- '))
        ? 'header'
        : text.startsWith('+')
          ? 'add'
          : text.startsWith('-')
            ? 'remove'
            : 'context';
    return { text, kind };
  });
}

export function diffStats(diff: string) {
  let added = 0;
  let removed = 0;
  for (const { kind } of diffLines(diff)) {
    if (kind === 'add') added++;
    if (kind === 'remove') removed++;
  }
  return { added, removed };
}
