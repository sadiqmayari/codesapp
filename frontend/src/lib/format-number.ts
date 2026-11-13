'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * App-wide number display mode (device-local, `localStorage.ca_number_format`):
 *  - compact: Rs 12.4M / Rs 48.2K (default on tiles)
 *  - full:    Rs 12,412,356
 *  - lakh:    Rs 1.24 Cr / Rs 4.82 L (South-Asian grouping)
 * Tooltips and `title` attributes always carry the exact full figure.
 */
export type NumberMode = 'compact' | 'full' | 'lakh';

const KEY = 'ca_number_format';
const EVENT = 'ca-number-format';

export function getNumberMode(): NumberMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'full' || v === 'lakh' || v === 'compact') return v;
  } catch {
    /* storage unavailable */
  }
  return 'compact';
}

export function setNumberMode(mode: NumberMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
}

const sym = (cur?: string | null) => (!cur ? '' : cur === 'PKR' ? 'Rs ' : `${cur} `);

/** Exact value, always grouped — used for tooltips and tables. */
export function fullMoney(v: number | null | undefined, cur?: string | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v < 0 ? '−' : '';
  return `${s}${sym(cur)}${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
}

export function money(v: number | null | undefined, cur: string | null | undefined, mode: NumberMode): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v < 0 ? '−' : '';
  const a = Math.abs(v);
  const p = sym(cur);
  if (mode === 'full') return `${s}${p}${Math.round(a).toLocaleString('en-US')}`;
  if (mode === 'lakh') {
    if (a >= 1e7) return `${s}${p}${(a / 1e7).toFixed(2)} Cr`;
    if (a >= 1e5) return `${s}${p}${(a / 1e5).toFixed(2)} L`;
    return `${s}${p}${Math.round(a).toLocaleString('en-IN')}`;
  }
  if (a >= 1e9) return `${s}${p}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}${p}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${s}${p}${(a / 1e3).toFixed(1)}K`;
  return `${s}${p}${Math.round(a).toLocaleString('en-US')}`;
}

/** Short axis labels (no currency). */
export function axisNumber(v: number, mode: NumberMode): string {
  const a = Math.abs(v);
  if (mode === 'lakh') {
    if (a >= 1e7) return `${(v / 1e7).toFixed(1)} Cr`;
    if (a >= 1e5) return `${(v / 1e5).toFixed(1)} L`;
  } else {
    if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  }
  if (a >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(Math.round(v));
}

export function count(v: number | null | undefined, mode: NumberMode): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (mode !== 'full' && Math.abs(v) >= 1e5) return axisNumber(v, mode);
  return Math.round(v).toLocaleString('en-US');
}

export const ratio = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(2)}×`);
export const pct = (v: number | null | undefined, digits = 1) =>
  v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`;

/** React hook: current mode + setter, synced across components and tabs. */
export function useNumberMode() {
  const [mode, setMode] = useState<NumberMode>('compact');
  useEffect(() => {
    setMode(getNumberMode());
    const on = (e: Event) => setMode((e as CustomEvent<NumberMode>).detail ?? getNumberMode());
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setMode(getNumberMode());
    };
    window.addEventListener(EVENT, on);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  const update = useCallback((m: NumberMode) => setNumberMode(m), []);
  return [mode, update] as const;
}
