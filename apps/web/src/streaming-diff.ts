const escapes: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

// History content may be either a unified diff or a serialized event envelope.
// Decode only a root diff/data.diff string; arbitrary patch text is never parsed
// as object structure. A trailing, incomplete JSON escape waits for the next page.
function jsonString(source: string, start: number, decode: boolean) {
  let text = '';
  let index = start + 1;
  for (; index < source.length; index++) {
    let char = source[index];
    if (char === '"') return { text, end: index + 1, complete: true };
    if (char === '\\') {
      char = source[++index];
      if (char === undefined) break;
      if (char === 'u') {
        const hex = source.slice(index + 1, index + 5);
        if (!/^[\da-f]{4}$/i.test(hex)) break;
        if (decode) text += String.fromCharCode(parseInt(hex, 16));
        index += 4;
        continue;
      }
      if (!Object.hasOwn(escapes, char)) break;
      if (decode) text += escapes[char];
    } else if (decode) text += char;
  }
  // Avoid displaying half a UTF-16 pair at a page boundary.
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return { text, end: index, complete: false };
}

export function streamingDiffText(source: string): string {
  if (!source.trimStart().startsWith('{')) return source;
  const stack: {
    object: boolean;
    key?: string;
    expectingKey: boolean;
    data: boolean;
  }[] = [];
  for (let index = 0; index < source.length;) {
    const char = source[index];
    const parent = stack.at(-1);
    if (char === '"') {
      const target =
        parent?.object &&
        !parent.expectingKey &&
        parent.key === 'diff' &&
        (stack.length === 1 || (stack.length === 2 && parent.data));
      const key = !!parent?.object && parent.expectingKey;
      const value = jsonString(source, index, key || !!target);
      if (target) return value.text;
      if (!value.complete) return '';
      if (key) {
        parent!.key = value.text;
        parent!.expectingKey = false;
      }
      index = value.end;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push({
        object: char === '{',
        expectingKey: char === '{',
        data: stack.length === 1 && !!parent?.object && parent.key === 'data',
      });
    } else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && parent?.object) {
      parent.expectingKey = true;
      parent.key = undefined;
    }
    index++;
  }
  return '';
}
