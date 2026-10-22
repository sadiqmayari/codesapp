// Shared store identity colours — one stable colour per connected store, reused
// by the Stores settings cards, the order-board store pill + filter, the
// analytics split, and the order-detail drawer pill. Keyed on the store id so
// every surface shows the same colour for the same store without threading the
// full store list around. Light-UI palette (the app has no dark theme).

import type { CSSProperties } from 'react';

export interface StoreColor {
  /** Solid identity colour — the dot, the rail. */
  solid: string;
  /** Tinted background for the pill. */
  soft: string;
  /** Pill border. */
  line: string;
  /** Readable text colour on the soft background. */
  text: string;
}

const PALETTE: StoreColor[] = [
  { solid: '#059669', soft: '#ecfdf5', line: '#a7f3d0', text: '#047857' }, // emerald
  { solid: '#d97706', soft: '#fff7ed', line: '#fed7aa', text: '#b45309' }, // amber
  { solid: '#7c3aed', soft: '#f5f3ff', line: '#ddd6fe', text: '#6d28d9' }, // violet
  { solid: '#2563eb', soft: '#eff6ff', line: '#bfdbfe', text: '#1d4ed8' }, // blue
  { solid: '#db2777', soft: '#fdf2f8', line: '#fbcfe8', text: '#be185d' }, // pink
  { solid: '#0891b2', soft: '#ecfeff', line: '#a5f3fc', text: '#0e7490' }, // cyan
];

/** Deterministic colour for a store id (stable across every screen). */
export function storeColor(storeId: number | null | undefined): StoreColor {
  if (storeId == null || !Number.isFinite(storeId)) return PALETTE[0];
  const i = ((Math.trunc(storeId) % PALETTE.length) + PALETTE.length) % PALETTE.length;
  return PALETTE[i];
}

/** Inline styles for a store pill (dot + tinted chip) given a store id. */
export function storePillStyle(storeId: number | null | undefined): CSSProperties {
  const c = storeColor(storeId);
  return { color: c.text, background: c.soft, borderColor: c.line };
}
