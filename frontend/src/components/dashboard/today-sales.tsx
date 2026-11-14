'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { zonedTodayRange } from '@/lib/utils';
import { GROSS_HELP, NET_HELP, SalesBreakdownRows, type SalesBreakdown } from '@/components/ui/sales-breakdown';

/**
 * Today's sales (tenant clock): the two headline numbers — Gross and Net —
 * with "How Gross becomes Net" underneath. Owner/admin only (money).
 */
export function TodaySales() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const { on } = useSocket();
  const [b, setB] = useState<SalesBreakdown | null>(null);
  const [cur, setCur] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!isAdmin) return;
    apiFetch<{ currency: string | null; salesBreakdown?: SalesBreakdown }>('/analytics/orders', {
      params: { ...zonedTodayRange(), compare: 'false' },
    })
      .then((r) => {
        setB(r.salesBreakdown ?? null);
        setCur(r.currency);
      })
      .catch(() => undefined);
  }, [isAdmin]);

  useEffect(() => {
    load();
    const t = setInterval(load, 120_000);
    const off = on('orders.changed', () => load());
    return () => {
      clearInterval(t);
      off?.();
    };
  }, [load, on]);

  if (!isAdmin || !b) return null;
  const fmt = (v: number) => `${cur ? `${cur} ` : ''}${Math.round(v).toLocaleString()}`;
  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-ink">Today’s sales</h2>
        <Link href="/orders/analytics" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">
          Orders analytics <ArrowRight size={12} />
        </Link>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-line px-3 py-2.5" title={GROSS_HELP}>
          <div className="text-xs font-semibold text-muted">Gross sales</div>
          <div className="text-2xl font-extrabold tabular-nums text-ink">{fmt(b.gross)}</div>
          <div className="text-xs text-muted">{b.orders.toLocaleString()} orders</div>
        </div>
        <div className="rounded-lg bg-emerald-50 px-3 py-2.5 dark:bg-emerald-950/30" title={NET_HELP}>
          <div className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">Net sales</div>
          <div className="text-2xl font-extrabold tabular-nums text-emerald-700 dark:text-emerald-400">{fmt(b.net)}</div>
          <div className="text-xs text-emerald-800/80 dark:text-emerald-300/80">{b.gross > 0 ? `${((b.net / b.gross) * 100).toFixed(1)}% of gross kept` : '—'}</div>
        </div>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-semibold text-muted hover:text-ink">How Gross becomes Net</summary>
        <SalesBreakdownRows b={b} fmt={fmt} className="mt-2 max-w-lg" />
      </details>
    </section>
  );
}
