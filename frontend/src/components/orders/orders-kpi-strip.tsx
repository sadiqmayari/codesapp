'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { TrendingDown, TrendingUp, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useSocket } from '@/context/socket-context';
import { AnimatedNumber } from '@/components/ui/animated-number';
import {
  cn,
  zonedTodayRange,
  zonedYesterdayRange,
  zonedMonthRange,
} from '@/lib/utils';

type Kpi = { value: number; prev: number | null; deltaPct: number | null };

interface OrdersAnalytics {
  currency: string | null;
  kpis: {
    sales: Kpi;
    salesActive: Kpi;
    deliveredAmount: Kpi;
    failedAmount: Kpi;
    orders: Kpi;
    ordersNet: Kpi;
    delivered: Kpi;
  };
  delivery: {
    shipped: number;
    delivered: number;
    failed: number;
    deliveryRate: number | null;
    codOutstanding: number;
    codCollected: number;
  };
}

type PresetKey = 'today' | 'yesterday' | 'month' | 'last_month';
const PRESETS: Array<[PresetKey, string]> = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['month', 'This month'],
  ['last_month', 'Last month'],
];

function money(v: number, c: string | null): string {
  return `${c ? c + ' ' : ''}${Math.round(v).toLocaleString()}`;
}

function Delta({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  const up = pct >= 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[11px] font-medium',
        up ? 'text-emerald-600' : 'text-rose-600',
      )}
    >
      {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {Math.abs(pct)}%
    </span>
  );
}

function Tile({
  label,
  value,
  delta,
  accent,
}: {
  label: string;
  value: ReactNode;
  delta?: number | null;
  accent?: 'green' | 'red' | 'amber';
}) {
  return (
    <div className="min-w-[150px] shrink-0 border-r border-gray-100 px-4 py-2.5 last:border-r-0">
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span
          className={cn(
            'text-lg font-semibold tabular-nums',
            accent === 'green'
              ? 'text-emerald-600'
              : accent === 'red'
                ? 'text-rose-600'
                : accent === 'amber'
                  ? 'text-amber-600'
                  : 'text-gray-900',
          )}
        >
          {value}
        </span>
        {delta !== undefined && <Delta pct={delta} />}
      </div>
    </div>
  );
}

/**
 * Compact Shopify-style KPI strip for the Orders view. Reuses the orders
 * analytics endpoint (GET /analytics/orders) for the selected period, with a
 * small period switch. Delivery metrics bucket on shipment event date (see
 * AnalyticsService.orderKpis), so "Delivered / Shipped" reflect what actually
 * happened in the period, not just orders placed in it.
 */
export function OrdersKpiStrip() {
  const [preset, setPreset] = useState<PresetKey>('today');
  const [data, setData] = useState<OrdersAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const { on, status: socketStatus } = useSocket();

  const params = useMemo(() => {
    switch (preset) {
      case 'today':
        return zonedTodayRange();
      case 'yesterday':
        return zonedYesterdayRange();
      case 'month':
        return zonedMonthRange(0);
      case 'last_month':
        return zonedMonthRange(-1);
    }
  }, [preset]);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const d = await apiFetch<OrdersAnalytics>('/analytics/orders', {
          params: { ...params, compare: 'true' },
        });
        setData(d);
      } catch {
        if (!silent) setData(null);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [params],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Live: a coalesced `orders.changed` ping (fired server-side on any order /
  // shipment webhook) silently re-pulls this period's figures so the tiles roll
  // to their new value without a refresh. A ref keeps the socket subscription
  // from re-binding on every `load` identity change (period switch).
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = on('orders.changed', () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => loadRef.current(true), 400);
    });
    return () => {
      if (t) clearTimeout(t);
      off();
    };
  }, [on]);

  // Reseed once the socket (re)connects — covers events missed while offline.
  const prevSock = useRef(socketStatus);
  useEffect(() => {
    if (prevSock.current !== 'connected' && socketStatus === 'connected') {
      loadRef.current(true);
    }
    prevSock.current = socketStatus;
  }, [socketStatus]);

  const c = data?.currency ?? null;

  return (
    <div className="mb-3 rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-2">
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-0.5">
          {PRESETS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setPreset(k)}
              className={cn(
                'shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-xs transition-colors',
                preset === k
                  ? 'bg-white font-semibold text-gray-900 shadow-sm ring-1 ring-gray-200'
                  : 'text-gray-600 hover:text-gray-900',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {loading && <Loader2 size={15} className="animate-spin text-gray-300" />}
      </div>
      {data ? (
        <div className="flex overflow-x-auto">
          <Tile
            label="Orders"
            value={<AnimatedNumber value={data.kpis.orders.value} />}
            delta={data.kpis.orders.deltaPct}
          />
          <Tile
            label="Sales"
            value={<AnimatedNumber value={data.kpis.sales.value} format={(v) => money(v, c)} />}
            delta={data.kpis.sales.deltaPct}
          />
          <Tile label="Shipped" value={<AnimatedNumber value={data.delivery.shipped} />} />
          <Tile
            label="Delivered"
            value={<AnimatedNumber value={data.delivery.delivered} />}
            delta={data.kpis.delivered.deltaPct}
            accent="green"
          />
          <Tile
            label="Delivered amount"
            value={
              <AnimatedNumber value={data.kpis.deliveredAmount.value} format={(v) => money(v, c)} />
            }
            delta={data.kpis.deliveredAmount.deltaPct}
            accent="green"
          />
          <Tile label="Failed" value={<AnimatedNumber value={data.delivery.failed} />} accent="red" />
          <Tile
            label="Delivery rate"
            value={
              data.delivery.deliveryRate == null ? (
                '—'
              ) : (
                <AnimatedNumber
                  value={data.delivery.deliveryRate}
                  format={(v) => `${Math.round(v)}%`}
                />
              )
            }
          />
          <Tile
            label="COD outstanding"
            value={<AnimatedNumber value={data.delivery.codOutstanding} format={(v) => money(v, c)} />}
            accent="amber"
          />
        </div>
      ) : (
        !loading && (
          <p className="px-4 py-3 text-xs text-gray-400">
            Couldn’t load metrics for this period.
          </p>
        )
      )}
    </div>
  );
}
