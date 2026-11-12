'use client';

import { createContext, useContext, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The Orders header (orders/layout.tsx) owns the page title + section tabs, but
 * the page-level actions (Scan, Sync, Create order) belong to whichever board is
 * mounted and depend on its local state. The layout exposes a slot element; a
 * board renders `<OrdersHeaderActions>` and its children are portalled into it.
 */
const SlotCtx = createContext<{
  el: HTMLElement | null;
  setEl: (el: HTMLElement | null) => void;
} | null>(null);

export function OrdersHeaderSlotProvider({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return <SlotCtx.Provider value={{ el, setEl }}>{children}</SlotCtx.Provider>;
}

/** Rendered once by the layout where the actions should appear. */
export function OrdersHeaderSlot({ className }: { className?: string }) {
  const ctx = useContext(SlotCtx);
  // setEl is a stable useState setter → a stable callback ref (an inline arrow
  // would re-fire null→node on every render and loop).
  return <div ref={ctx?.setEl} className={className} />;
}

/** Rendered by a board — its children land in the header slot. */
export function OrdersHeaderActions({ children }: { children: React.ReactNode }) {
  const ctx = useContext(SlotCtx);
  if (!ctx?.el) return null;
  return createPortal(children, ctx.el);
}
