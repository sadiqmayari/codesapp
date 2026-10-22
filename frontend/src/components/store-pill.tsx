'use client';

import { storeColor } from '@/lib/store-colors';

/**
 * A small colour-coded store chip, used on order rows, the order-detail header,
 * the analytics split and the catalog picker so one store always reads the same
 * everywhere. Colour is derived from the store id.
 */
export function StorePill({
  storeId,
  label,
  size = 'sm',
  className = '',
}: {
  storeId: number | null | undefined;
  label: string | null | undefined;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  if (!label) return null;
  const c = storeColor(storeId);
  const pad = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]';
  const dot = size === 'xs' ? 'h-1.5 w-1.5' : 'h-2 w-2';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-semibold leading-none ${pad} ${className}`}
      style={{ color: c.text, background: c.soft, borderColor: c.line }}
      title={label}
    >
      <span className={`${dot} flex-none rounded-full`} style={{ background: c.solid }} />
      <span className="max-w-[9rem] truncate">{label}</span>
    </span>
  );
}
