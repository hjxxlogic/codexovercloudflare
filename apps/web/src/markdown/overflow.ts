import { useEffect, useState, type RefObject } from 'react';

// Measure scroll containers, including asynchronously inserted KaTeX and fonts.
export function useContentOverflow(
  ref: RefObject<HTMLElement | null>,
  expanded: boolean,
) {
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const root = ref.current;
    if (!root || expanded) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nodes = [
          root,
          ...root.querySelectorAll<HTMLElement>(
            'pre, table, .math-result, .rich-fallback',
          ),
        ];
        nodes.forEach((node) => resize.observe(node));
        setOverflow(
          nodes.some(
            (node) =>
              node.clientWidth > 0 &&
              (node.scrollWidth > node.clientWidth + 1 ||
                node.scrollHeight > node.clientHeight + 1),
          ),
        );
      });
    };
    const resize = new ResizeObserver(measure);
    const mutations = new MutationObserver(measure);
    resize.observe(root);
    mutations.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    document.fonts.addEventListener('loadingdone', measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [ref, expanded]);
  return overflow;
}
