'use client';

import { AlertTriangle, CheckCircle2, Clock, Layers } from 'lucide-react';
import { fullMoney } from '@/lib/format-number';
import { Badge } from '@/components/ui/badge';
import { PRODUCT_STATUS_META, STOCK_STATUS_META, type ItemListing, type ProductStatus, type StockStatus } from '@/lib/inventory';

/** Inventory money — tenant currency from the summary (set once per board). */
let activeCurrency: string | null = null;
export const setInventoryCurrency = (c: string | null) => {
  activeCurrency = c;
};
export const money = (v: number | null | undefined) => fullMoney(v ?? null, activeCurrency);

export const inputCls =
  'h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:opacity-60';

export function StockBadge({ status }: { status: StockStatus }) {
  const m = STOCK_STATUS_META[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function ProductStatusBadge({ status }: { status: string | null }) {
  const m = PRODUCT_STATUS_META[(status ?? 'active') as ProductStatus];
  if (!m) return <Badge tone="neutral">{status}</Badge>;
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function BundleBadge() {
  return (
    <Badge tone="violet">
      <Layers className="h-3 w-3" aria-hidden="true" /> Bundle
    </Badge>
  );
}

/** One chip for every store push of a listing: error wins, then pending, then ok. */
export function pushStateOf(ls: ItemListing[]): { state: 'error' | 'pending' | 'ok' | null; message: string | null } {
  let pending = false;
  let ok = false;
  for (const l of ls) {
    for (const [s, e] of [
      [l.qtyPushStatus, l.qtyPushError],
      [l.pricePushStatus, l.pricePushError],
      [l.costPushStatus, l.costPushError],
      [l.productStatusPush, l.productStatusError],
    ] as const) {
      if (s === 'error') return { state: 'error', message: `${l.storeLabel}: ${e ?? 'push failed'}` };
      if (s === 'pending') pending = true;
      if (s === 'ok') ok = true;
    }
  }
  return { state: pending ? 'pending' : ok ? 'ok' : null, message: null };
}

export function PushChip({ listings, compact }: { listings: ItemListing[]; compact?: boolean }) {
  const { state, message } = pushStateOf(listings);
  if (!state) return <span className="text-xs text-muted">—</span>;
  if (state === 'error') {
    return (
      <span className="inline-flex max-w-[16rem] items-start gap-1 text-xs font-semibold text-red-700">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className={compact ? 'truncate' : ''} title={message ?? undefined}>
          {compact ? 'Push failed' : message}
        </span>
      </span>
    );
  }
  if (state === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-sky-700">
        <Clock className="h-3.5 w-3.5" aria-hidden="true" /> Pending
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Synced
    </span>
  );
}

/** Product + variant title in one line ("Default Title" hidden). */
export function itemName(i: { title: string; variantTitle: string | null }) {
  const v = i.variantTitle && i.variantTitle !== 'Default Title' ? i.variantTitle : null;
  return v ? `${i.title} · ${v}` : i.title;
}

export function Thumb({ src, alt }: { src: string | null; alt: string }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className="h-9 w-9 shrink-0 rounded-lg border border-line object-cover" />
  ) : (
    <div className="h-9 w-9 shrink-0 rounded-lg bg-sunken" aria-hidden="true" />
  );
}

/** Parse a money field ("1,250.5") → number | null | 'invalid'. */
export function parseMoney(raw: string): number | null | 'invalid' {
  const t = raw.replace(/,/g, '').trim();
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return 'invalid';
  return Number(t);
}
