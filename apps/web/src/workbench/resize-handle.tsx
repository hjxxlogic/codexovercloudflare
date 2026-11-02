import { useRef } from 'react';

export function ResizeHandle({
  axis,
  size,
  minimum,
  maximum,
  initial,
  reverse = false,
  label,
  change,
}: {
  axis: 'x' | 'y';
  size: number;
  minimum: number;
  maximum: () => number;
  initial: number;
  reverse?: boolean;
  label: string;
  change: (size: number) => void;
}) {
  const drag = useRef<{ coordinate: number; size: number } | null>(null);
  const clamp = (value: number) =>
    Math.round(
      Math.max(minimum, Math.min(Math.max(minimum, maximum()), value)),
    );
  const direction = reverse ? -1 : 1;
  return (
    <div
      className={`pane-resizer resize-${axis}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuemin={minimum}
      aria-valuemax={Math.max(minimum, maximum())}
      aria-valuenow={clamp(size)}
      onDoubleClick={() => change(clamp(initial))}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const bounds =
          event.currentTarget.parentElement!.getBoundingClientRect();
        drag.current = {
          coordinate: axis === 'x' ? event.clientX : event.clientY,
          size: axis === 'x' ? bounds.width : bounds.height,
        };
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (
          !drag.current ||
          !event.currentTarget.hasPointerCapture(event.pointerId)
        )
          return;
        const coordinate = axis === 'x' ? event.clientX : event.clientY;
        change(
          clamp(
            drag.current.size +
              (coordinate - drag.current.coordinate) * direction,
          ),
        );
      }}
      onPointerUp={(event) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const negative = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        const positive = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        if (![negative, positive, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        change(
          clamp(
            event.key === 'Home'
              ? minimum
              : event.key === 'End'
                ? maximum()
                : size +
                  (event.key === positive ? 1 : -1) *
                    direction *
                    (event.shiftKey ? 32 : 16),
          ),
        );
      }}
    />
  );
}
