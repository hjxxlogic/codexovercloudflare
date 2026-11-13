// Decode a valid JSON prefix without inventing closing syntax. Incomplete escape
// sequences and object keys are withheld until their next page arrives.
export function streamingJson(
  source: string,
): { value: unknown; complete: boolean } | undefined {
  let index = 0;
  let invalid = false;
  const whitespace = () => {
    while (/\s/.test(source[index] || '') && index < source.length) index++;
  };
  const string = () => {
    index++;
    let value = '';
    while (index < source.length) {
      const char = source[index++];
      if (char === '"') return { value, complete: true };
      if (char === '\\') {
        if (index === source.length) break;
        const escape = source[index++];
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
        if (escape === 'u') {
          const hex = source.slice(index, index + 4);
          if (!/^[\da-f]{0,4}$/i.test(hex)) {
            invalid = true;
            break;
          }
          if (hex.length < 4) break;
          value += String.fromCharCode(parseInt(hex, 16));
          index += 4;
        } else if (Object.hasOwn(escapes, escape)) value += escapes[escape];
        else {
          invalid = true;
          break;
        }
      } else if (char.charCodeAt(0) < 32) {
        invalid = true;
        break;
      } else value += char;
    }
    if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
    return { value, complete: false };
  };
  function read(depth: number): { value: unknown; complete: boolean } {
    whitespace();
    if (depth > 64) {
      invalid = true;
      return { value: undefined, complete: false };
    }
    const char = source[index];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      index++;
      const object = char === '{';
      const value: Record<string, unknown> | unknown[] = object
        ? Object.create(null)
        : [];
      const close = object ? '}' : ']';
      whitespace();
      if (source[index] === close) {
        index++;
        return { value, complete: true };
      }
      while (index < source.length && !invalid) {
        whitespace();
        let key = '';
        if (object) {
          if (source[index] !== '"') {
            if (index < source.length) invalid = true;
            break;
          }
          const field = string();
          if (!field.complete) break;
          key = field.value;
          whitespace();
          if (index === source.length) break;
          if (source[index++] !== ':') {
            invalid = true;
            break;
          }
        }
        const child = read(depth + 1);
        if (child.value !== undefined) {
          if (Array.isArray(value)) value.push(child.value);
          else value[key] = child.value;
        }
        if (!child.complete) break;
        whitespace();
        if (source[index] === close) {
          index++;
          return { value, complete: true };
        }
        if (index === source.length) break;
        if (source[index++] !== ',') {
          invalid = true;
          break;
        }
        whitespace();
        if (source[index] === close) {
          invalid = true;
          break;
        }
      }
      return { value, complete: false };
    }
    const start = index;
    while (index < source.length && !/[\s,}\]]/.test(source[index])) index++;
    const token = source.slice(start, index);
    try {
      return { value: JSON.parse(token), complete: true };
    } catch {
      if (
        index < source.length ||
        !/^(?:t(?:r(?:u(?:e)?)?)?|f(?:a(?:l(?:s(?:e)?)?)?)?|n(?:u(?:l(?:l)?)?)?|-?(?:\d+(?:\.\d*)?(?:[eE][+-]?\d*)?)?)$/.test(
          token,
        )
      )
        invalid = true;
      return { value: undefined, complete: false };
    }
  }
  const result = read(0);
  whitespace();
  if (invalid || (result.complete && index !== source.length)) return undefined;
  return result;
}

export function objectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function itemFromValue(value: unknown) {
  const root = objectValue(value);
  return (
    objectValue(objectValue(root?.data)?.item) ??
    objectValue(root?.item) ??
    root
  );
}
