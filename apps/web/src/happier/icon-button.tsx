import './icon-button.css';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type AnchorHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icon.tsx';

function useTooltip(label: string) {
  const anchor = useRef<HTMLElement | null>(null);
  const id = useId();
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    above: boolean;
    root: HTMLElement;
  }>();
  const hide = () => setPosition(undefined);
  const show = () => {
    const element = anchor.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const above = rect.top > 64;
    setPosition({
      left: Math.max(
        124,
        Math.min(innerWidth - 124, rect.left + rect.width / 2),
      ),
      top: above ? rect.top - 8 : rect.bottom + 8,
      above,
      root: element.closest('dialog[open]') || document.body,
    });
  };
  useEffect(() => {
    if (!position) return;
    window.addEventListener('resize', hide);
    document.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('resize', hide);
      document.removeEventListener('scroll', hide, true);
    };
  }, [!!position]);
  return {
    anchor,
    hide,
    attributes: {
      'aria-label': label,
      'aria-describedby': position ? id : undefined,
      onPointerEnter: show,
      onPointerLeave: hide,
      onFocus: show,
      onBlur: hide,
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === 'Escape' && position) {
          hide();
        }
      },
    },
    tooltip:
      position &&
      createPortal(
        <span
          id={id}
          role="tooltip"
          className="action-tooltip"
          data-above={position.above}
          style={{ left: position.left, top: position.top }}
        >
          {label}
        </span>,
        position.root,
      ),
  };
}
export function IconButton({
  icon,
  label,
  ref: forwardedRef,
  ...props
}: Omit<ComponentProps<'button'>, 'children' | 'aria-label'> & {
  icon: IconName;
  label: string;
}) {
  const tooltip = useTooltip(label);
  return (
    <>
      <button
        {...props}
        {...tooltip.attributes}
        onPointerEnter={(event) => {
          tooltip.attributes.onPointerEnter();
          props.onPointerEnter?.(event);
        }}
        onPointerLeave={(event) => {
          tooltip.attributes.onPointerLeave();
          props.onPointerLeave?.(event);
        }}
        onFocus={(event) => {
          tooltip.attributes.onFocus();
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          tooltip.attributes.onBlur();
          props.onBlur?.(event);
        }}
        onKeyDown={(event) => {
          tooltip.attributes.onKeyDown(event);
          props.onKeyDown?.(event);
        }}
        type={props.type || 'button'}
        ref={(element) => {
          tooltip.anchor.current = element;
          if (typeof forwardedRef === 'function') forwardedRef(element);
          else if (forwardedRef) forwardedRef.current = element;
        }}
        className={`icon-button ${props.className || ''}`}
        onClick={(event) => {
          tooltip.hide();
          props.onClick?.(event);
        }}
      >
        <Icon name={icon} />
      </button>
      {tooltip.tooltip}
    </>
  );
}
export function IconLink({
  icon,
  label,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children' | 'aria-label'> & {
  icon: IconName;
  label: string;
}) {
  const tooltip = useTooltip(label);
  return (
    <>
      <a
        {...props}
        {...tooltip.attributes}
        ref={(element) => {
          tooltip.anchor.current = element;
        }}
        className={`icon-button ${props.className || ''}`}
        onClick={(event) => {
          tooltip.hide();
          props.onClick?.(event);
        }}
      >
        <Icon name={icon} />
      </a>
      {tooltip.tooltip}
    </>
  );
}
