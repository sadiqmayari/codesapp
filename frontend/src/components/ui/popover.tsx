'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/**
 * Anchored popovers that never leave the screen (mobile audit, Nov-2026).
 *
 * `useAnchoredPosition` measures the anchor + panel and returns a FIXED
 * position that is clamped 8px inside both screen edges, flips ABOVE the
 * anchor when there is more room there, and caps the height to the space
 * left (the panel scrolls). It follows scroll/resize. `AnchoredPopover`
 * portals the panel to <body> (so `overflow` on a parent can never clip it)
 * and closes on outside click / Esc.
 *
 * Use these for every new dropdown, menu, tooltip or picker — never
 * `absolute right-0 w-72` (that ran off phones on the left).
 */

const MARGIN = 8;

export type PopoverAlign = 'start' | 'end' | 'center';

export interface AnchoredStyle {
  left: number;
  top: number;
  maxHeight: number;
  placement: 'below' | 'above';
}

export function useAnchoredPosition(
  open: boolean,
  anchorRef: React.RefObject<HTMLElement | null>,
  panelRef: React.RefObject<HTMLElement | null>,
  opts: { align?: PopoverAlign; gap?: number } = {},
): AnchoredStyle | null {
  const { align = 'end', gap = 6 } = opts;
  const [pos, setPos] = useState<AnchoredStyle | null>(null);

  const place = useCallback(() => {
    const a = anchorRef.current;
    const p = panelRef.current;
    if (!a || !p) return;
    const r = a.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(p.offsetWidth, vw - MARGIN * 2);
    // Natural height (scrollHeight ignores the max-height we set last time).
    const h = p.scrollHeight;
    const want = align === 'start' ? r.left : align === 'center' ? r.left + r.width / 2 - w / 2 : r.right - w;
    const left = Math.min(Math.max(MARGIN, want), vw - w - MARGIN);
    const below = vh - r.bottom - gap - MARGIN;
    const above = r.top - gap - MARGIN;
    const goAbove = h > below && above > below;
    const room = Math.max(120, goAbove ? above : below);
    const shown = Math.min(h, room);
    const top = goAbove ? Math.max(MARGIN, r.top - gap - shown) : Math.min(r.bottom + gap, vh - MARGIN - shown);
    setPos((prev) =>
      prev && prev.left === left && prev.top === top && prev.maxHeight === room
        ? prev
        : { left, top, maxHeight: room, placement: goAbove ? 'above' : 'below' },
    );
  }, [anchorRef, panelRef, align, gap]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const on = () => place();
    window.addEventListener('resize', on);
    window.addEventListener('scroll', on, true);
    const ro = typeof ResizeObserver !== 'undefined' && panelRef.current ? new ResizeObserver(on) : null;
    if (ro && panelRef.current) ro.observe(panelRef.current);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('scroll', on, true);
      ro?.disconnect();
    };
  }, [open, place, panelRef]);

  return pos;
}

export function AnchoredPopover({
  open,
  onClose,
  anchorRef,
  panelRef: externalPanelRef,
  align = 'end',
  gap,
  className,
  children,
  role,
  id,
  onKeyDown,
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Optional ref to the panel (e.g. to treat it as "inside" elsewhere). */
  panelRef?: React.MutableRefObject<HTMLDivElement | null>;
  align?: PopoverAlign;
  gap?: number;
  className?: string;
  children: React.ReactNode;
  role?: string;
  id?: string;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  ariaLabel?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pos = useAnchoredPosition(open, anchorRef, panelRef, { align, gap });
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      panelRef.current = el;
      if (externalPanelRef) externalPanelRef.current = el;
    },
    [externalPanelRef],
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={setRef}
      id={id}
      role={role}
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        left: pos?.left ?? -9999,
        top: pos?.top ?? 0,
        maxHeight: pos?.maxHeight,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className={cn(
        'z-[70] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain whitespace-normal text-left normal-case',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * A fixed panel placed against a captured anchor rect (for menus opened from
 * list rows where only the click's `getBoundingClientRect()` is kept). Same
 * rules: clamped 8px inside the screen, flips up near the bottom, scrolls when
 * taller than the space. Rendered in place (not portalled) so existing
 * "is the click inside?" checks keep working.
 */
export function FloatingAtRect({
  rect,
  align = 'end',
  gap = 4,
  className,
  style,
  children,
  ...rest
}: {
  rect: { left: number; right: number; top: number; bottom: number };
  align?: PopoverAlign;
  gap?: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'className' | 'children'>) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // A virtual anchor: an object that answers getBoundingClientRect like an element.
  anchorRef.current = {
    getBoundingClientRect: () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top }),
  } as unknown as HTMLElement;
  const pos = useAnchoredPosition(true, anchorRef, panelRef, { align, gap });
  return (
    <div
      {...rest}
      ref={panelRef}
      style={{
        ...style,
        position: 'fixed',
        left: pos?.left ?? -9999,
        top: pos?.top ?? 0,
        maxHeight: pos?.maxHeight,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className={cn('max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain', className)}
    >
      {children}
    </div>
  );
}
