// Extensions operate on the Markdown AST. Code and raw HTML are never reparsed.
type Node = {
  type: string;
  value?: string;
  depth?: number;
  url?: string;
  children?: Node[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};
export function nodeText(node: Node): string {
  return node.value ?? node.children?.map(nodeText).join('') ?? '';
}
export function headingId(scope: string, index: number) {
  return `${scope}-heading-${index}`;
}
export function remarkStructure(options: { scope: string }) {
  return (tree: Node) => {
    let heading = 0;
    const anchors = new Map<string, string>();
    function visit(node: Node) {
      if (node.type === 'heading') {
        const id = headingId(options.scope, heading++);
        const slug = nodeText(node)
          .toLowerCase()
          .replace(/[^\p{L}\p{N} _-]/gu, '')
          .replace(/ /g, '-');
        if (!anchors.has(slug)) anchors.set(slug, id);
        node.data = { hProperties: { id } };
      }
      if (node.type === 'blockquote') {
        const first = node.children?.[0]?.children?.[0];
        const match = first?.value?.match(
          /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s*\n|\s*$)/,
        );
        if (match && first) {
          first.value = first.value!.slice(match[0].length);
          node.data = {
            hProperties: {
              className: `callout callout-${match[1].toLowerCase()}`,
              'aria-label': match[1],
            },
          };
          node.children?.unshift({
            type: 'paragraph',
            children: [
              { type: 'strong', children: [{ type: 'text', value: match[1] }] },
            ],
          });
        }
      }
      node.children?.forEach(visit);
    }
    visit(tree);
    function extensions(node: Node) {
      if (node.type === 'link' && node.url?.startsWith('#')) {
        let fragment = node.url.slice(1);
        try {
          fragment = decodeURIComponent(fragment);
        } catch {
          /* Keep literal malformed fragment. */
        }
        if (anchors.has(fragment)) node.url = '#' + anchors.get(fragment);
      }
      if (node.type === 'inlineMath' && node.value !== node.value?.trim()) {
        node.type = 'text';
        node.value = '$' + node.value + '$';
        node.data = undefined;
      }
      node.children?.forEach(extensions);
      if (!node.children) return;
      const result: Node[] = [];
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const match =
          child.type === 'paragraph' &&
          nodeText(child).match(/^:::details (.+)$/);
        const end = match
          ? node.children.findIndex(
              (candidate, index) =>
                index > i &&
                candidate.type === 'paragraph' &&
                nodeText(candidate) === ':::',
            )
          : -1;
        if (match && end > i) {
          result.push({
            type: 'container',
            data: { hName: 'details' },
            children: [
              {
                type: 'container',
                data: { hName: 'summary' },
                children: [{ type: 'text', value: match[1] }],
              },
              ...node.children.slice(i + 1, end),
            ],
          });
          i = end;
        } else result.push(child);
      }
      node.children = result;
    }
    extensions(tree);
  };
}

// Single-dollar math is parsed only inside text nodes, after code/link syntax.
// This prevents a currency sign from swallowing a later inline code span.
export function remarkInlineMath() {
  return (tree: Node, file: { value: unknown }) => {
    const original = String(file.value);
    const visit = (
      node: Node & {
        position?: { start: { offset?: number }; end: { offset?: number } };
      },
    ) => {
      if (
        ['code', 'inlineCode', 'math', 'inlineMath', 'link', 'image'].includes(
          node.type,
        ) ||
        !node.children
      )
        return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text' || !child.value) {
          visit(child);
          return [child];
        }
        const positioned = child as typeof node;
        const raw = original.slice(
          positioned.position?.start.offset,
          positioned.position?.end.offset,
        );
        // Keep explicitly escaped dollar nodes literal, including mixed text.
        if (raw.includes('\\$')) return [child];
        const result: Node[] = [];
        let offset = 0;
        for (const match of child.value.matchAll(
          /(?<![\\\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g,
        )) {
          result.push({
            type: 'text',
            value: child.value.slice(offset, match.index),
          });
          result.push({
            type: 'inlineCode',
            value: match[1],
            data: {
              hName: 'code',
              hProperties: { className: ['language-math', 'math-inline'] },
            },
          });
          offset = match.index + match[0].length;
        }
        result.push({ type: 'text', value: child.value.slice(offset) });
        return result;
      });
    };
    visit(tree);
  };
}
