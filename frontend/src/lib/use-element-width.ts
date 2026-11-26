'use client';

import { useLayoutEffect, useState } from 'react';

/**
 * Width of an element, kept live with a ResizeObserver. Use it when a layout
 * must react to the space a component ACTUALLY has, not the screen width —
 * e.g. the inbox thread header, which can be 300px wide on a 1280px screen
 * once the sidebar, conversation list and contact drawer are all open.
 * Returns `null` until first measured (render the roomy layout by default).
 */
export function useElementWidth(ref: React.RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
