'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, TrendingUp, TrendingDown } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import {
  cn,
  zonedTodayRange,
  zonedYesterdayRange,
  zonedMonthRange,
  zonedStartOfDay,
} from '@/lib/utils';

interface Kpi {
  value: number;
  prev: number | null;
  deltaPct: number | null;
}
interface CourierRow {
  courier: string;
  courierName: string;
  delivered: number;
  failed: number;
  inTransit: number;
  deliveredAmount: number;
  codOutstanding: number;
}
interface AgentRow {
  userId: number;
  name: string;
  orders: number;
  amount: number;
  currency: string | null;
}
interface TrendRow {
  bucket: string;
  orders: number;
  sales: number;
  delivered: number;
}
interface OrdersAnalytics {
  range: { granularity: 'hour' | 'day'; spanDays: number };
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
  byCourier: CourierRow[];
  byAgent: AgentRow[];
  trend: TrendRow[];
}

type PresetKey = 'today' | 'yesterday' | 'month' | 'last_month' | 'custom';

const PRESETS: { key: PresetKey; label: string; compareLabel: string }[] = [
  { key: 'today', label: 'Today', compareLabel: 'vs yesterday' },
  { key: 'yesterday', label: 'Yesterday', compareLabel: 'vs prev day' },
  { key: 'month', label: 'This month', compareLabel: 'vs last month' },
  { key: 'last_month', label: 'Last month', compareLabel: 'vs prev month' },
  { key: 'custom', label: 'Custom', compareLabel: 'vs prev period' },
];

function ymd(d: Date): string {
  // yyyy-mm-dd for the <input type=date> defaults (browser-local is fine here).
  return d.toISOString().slice(0, 10);
}

export default function OrdersAnalyticsPage() {
  const toast = useToast();
  const [preset, setPreset] = useState<PresetKey>('month');
  const [customFrom, setCustomFrom] = useState(() =>
    ymd(new Date(Date.now() - 7 * 86_400_000)),
  );
  const [customTo, setCustomTo] = useState(() => ymd(new Date()));
  const [data, setData] = useState<OrdersAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  const compareLabel =
    PRESETS.find((p) => p.key === preset)?.compareLabel ?? 'vs prev period';

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
      case 'custom': {
        const from = zonedStartOfDay(new Date(customFrom + 'T12:00:00Z'));
        const toStart = zonedStartOfDay(new Date(customTo + 'T12:00:00Z'));
        const to = new Date(toStart.getTime() + 86_400_000 - 1); // end of that day
        return { from: from.toISOString(), to: to.toISOString() };
      }
    }
  }, [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiFetch<OrdersAnalytics>('/analytics/orders', {
        params: { ...params, compare: 'true' },
      });
      setData(d);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load orders analytics',
      );
    } finally {
      setLoading(false);
    }
  }, [params, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const cur = data?.currency ?? null;
  const money = (amt: number) =>
    `${cur ? cur + ' ' : ''}${amt.toLocaleString(undefined, {
      maximumFractionDigits: 0,
    })}`;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-4">
        <Link
          href="/orders/fulfillment"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft className="w-4 h-4" /> Orders
        </Link>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Orders analytics</h1>
        <div className="flex flex-wrap bg-white border border-gray-200 rounded-lg overflow-hidden">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className={cn(
                'px-3 py-1.5 text-sm whitespace-nowrap',
                preset === p.key
                  ? 'bg-green-600 text-white'
                  : 'text-gray-600 hover:bg-gray-50',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {preset === 'custom' && (
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <label className="text-sm">
            <span className="block text-xs text-gray-500 mb-1">From</span>
            <input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-500 mb-1">To</span>
            <input
              type="date"
              value={customTo}
              min={customFrom}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
            />
          </label>
        </div>
      )}

      {loading && !data ? (
        <div className="p-10 flex justify-center">
          <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : !data ? (
        <p className="text-sm text-gray-400 py-10 text-center">No data.</p>
      ) : (
        <div className={cn(loading && 'opacity-60 pointer-events-none')}>
          {data.kpis.orders.value === 0 && (
            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
              No orders fall in this period yet. Orders are counted by their order
              date in your timezone
              {preset === 'today' ? ' — today has only just begun.' : '.'}
            </div>
          )}

          {/* Money KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <KpiCard
              label="Total sales"
              kpi={data.kpis.sales}
              fmt={money}
              compareLabel={compareLabel}
            />
            <KpiCard
              label="Sales (excl. cancelled)"
              kpi={data.kpis.salesActive}
              fmt={money}
              compareLabel={compareLabel}
            />
            <KpiCard
              label="Delivered amount"
              kpi={data.kpis.deliveredAmount}
              fmt={money}
              compareLabel={compareLabel}
              tone="green"
            />
            <KpiCard
              label="Failed-delivery amount"
              kpi={data.kpis.failedAmount}
              fmt={money}
              compareLabel={compareLabel}
              tone="red"
              invertDelta
            />
          </div>

          {/* Count KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <KpiCard
              label="Total orders"
              kpi={data.kpis.orders}
              fmt={(v) => v.toLocaleString()}
              compareLabel={compareLabel}
            />
            <KpiCard
              label="Orders (excl. cancelled/failed)"
              kpi={data.kpis.ordersNet}
              fmt={(v) => v.toLocaleString()}
              compareLabel={compareLabel}
            />
            <KpiCard
              label="Delivered orders"
              kpi={data.kpis.delivered}
              fmt={(v) => v.toLocaleString()}
              compareLabel={compareLabel}
              tone="green"
            />
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <p className="text-sm text-gray-500">Delivery rate</p>
              <p className="text-3xl font-bold text-green-600 mt-2">
                {data.delivery.deliveryRate == null
                  ? '—'
                  : `${data.delivery.deliveryRate}%`}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {data.delivery.delivered.toLocaleString()} of{' '}
                {data.delivery.shipped.toLocaleString()} shipped
              </p>
            </div>
          </div>

          {/* COD */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <p className="text-sm text-gray-500">COD outstanding</p>
              <p className="text-2xl font-bold text-amber-600 mt-2">
                {money(data.delivery.codOutstanding)}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                delivered, not yet settled by courier
              </p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <p className="text-sm text-gray-500">COD collected</p>
              <p className="text-2xl font-bold text-gray-900 mt-2">
                {money(data.delivery.codCollected)}
              </p>
              <p className="text-xs text-gray-400 mt-1">settled by courier</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <p className="text-sm text-gray-500">Failed deliveries</p>
              <p className="text-2xl font-bold text-red-600 mt-2">
                {data.delivery.failed.toLocaleString()}
              </p>
              <p className="text-xs text-gray-400 mt-1">parcels in this period</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <p className="text-sm text-gray-500">Shipped</p>
              <p className="text-2xl font-bold text-gray-900 mt-2">
                {data.delivery.shipped.toLocaleString()}
              </p>
              <p className="text-xs text-gray-400 mt-1">parcels booked</p>
            </div>
          </div>

          {/* Trend */}
          <Card title="Sales & orders trend">
            {data.trend.length === 0 ? (
              <p className="text-sm text-gray-400 py-6 text-center">
                No orders in this period.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={data.trend} margin={{ left: 8, right: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis
                    dataKey="bucket"
                    tick={{ fontSize: 10 }}
                    tickFormatter={(b: string) =>
                      data.range.granularity === 'hour' ? b.slice(11) : b.slice(5)
                    }
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 11 }}
                    allowDecimals={false}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 11 }}
                    allowDecimals={false}
                  />
                  <Tooltip
                    formatter={(v: number, name: string) =>
                      name === 'sales' ? money(v) : v.toLocaleString()
                    }
                  />
                  <Bar
                    yAxisId="left"
                    dataKey="sales"
                    name="sales"
                    fill="#16a34a"
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar
                    yAxisId="right"
                    dataKey="orders"
                    name="orders"
                    fill="#3b82f6"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
            {/* By courier */}
            <Card title="By courier">
              {data.byCourier.length === 0 ? (
                <p className="text-sm text-gray-400 py-6 text-center">
                  No shipments in this period.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-500 border-b border-gray-200">
                        <th className="py-2 pr-2">Courier</th>
                        <th className="py-2 px-2 text-right">Delivered</th>
                        <th className="py-2 px-2 text-right">Failed</th>
                        <th className="py-2 px-2 text-right">In transit</th>
                        <th className="py-2 pl-2 text-right">COD due</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byCourier.map((c) => (
                        <tr
                          key={c.courier}
                          className="border-b border-gray-100 last:border-0"
                        >
                          <td className="py-2 pr-2 font-medium text-gray-800">
                            {c.courierName}
                          </td>
                          <td className="py-2 px-2 text-right text-green-700">
                            {c.delivered.toLocaleString()}
                          </td>
                          <td className="py-2 px-2 text-right text-red-600">
                            {c.failed.toLocaleString()}
                          </td>
                          <td className="py-2 px-2 text-right text-gray-600">
                            {c.inTransit.toLocaleString()}
                          </td>
                          <td className="py-2 pl-2 text-right text-gray-700">
                            {money(c.codOutstanding)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* By agent */}
            <Card title="Orders created by agents">
              {data.byAgent.length === 0 ? (
                <p className="text-sm text-gray-400 py-6 text-center">
                  No agent-created orders in this period.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-500 border-b border-gray-200">
                        <th className="py-2 pr-2">Agent</th>
                        <th className="py-2 px-2 text-right">Orders</th>
                        <th className="py-2 pl-2 text-right">Order value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byAgent.map((a) => (
                        <tr
                          key={a.userId}
                          className="border-b border-gray-100 last:border-0"
                        >
                          <td className="py-2 pr-2 font-medium text-gray-800">
                            {a.name}
                          </td>
                          <td className="py-2 px-2 text-right">
                            {a.orders.toLocaleString()}
                          </td>
                          <td className="py-2 pl-2 text-right text-gray-700">
                            {a.amount > 0
                              ? `${a.currency ? a.currency + ' ' : ''}${a.amount.toLocaleString(
                                  undefined,
                                  { maximumFractionDigits: 0 },
                                )}`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-xs text-gray-400 mt-3">
                    Order value is captured for orders created after this feature
                    shipped; older orders count but show no value.
                  </p>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({
  label,
  kpi,
  fmt,
  compareLabel,
  tone,
  invertDelta,
}: {
  label: string;
  kpi: Kpi;
  fmt: (v: number) => string;
  compareLabel: string;
  tone?: 'green' | 'red';
  invertDelta?: boolean;
}) {
  const valueColor =
    tone === 'green'
      ? 'text-green-600'
      : tone === 'red'
        ? 'text-red-600'
        : 'text-gray-900';
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <p className="text-sm text-gray-500">{label}</p>
      <p className={cn('text-2xl font-bold mt-2', valueColor)}>
        {fmt(kpi.value)}
      </p>
      <Delta
        deltaPct={kpi.deltaPct}
        prev={kpi.prev}
        fmt={fmt}
        compareLabel={compareLabel}
        invert={invertDelta}
      />
    </div>
  );
}

function Delta({
  deltaPct,
  prev,
  fmt,
  compareLabel,
  invert,
}: {
  deltaPct: number | null;
  prev: number | null;
  fmt: (v: number) => string;
  compareLabel: string;
  invert?: boolean;
}) {
  if (deltaPct == null) {
    return (
      <p className="text-xs text-gray-400 mt-1">
        {prev != null ? `${compareLabel} ${fmt(prev)}` : compareLabel}
      </p>
    );
  }
  const up = deltaPct >= 0;
  // For "bad" metrics (failed amount), an increase is red, a decrease green.
  const good = invert ? !up : up;
  const color = deltaPct === 0 ? 'text-gray-400' : good ? 'text-green-600' : 'text-red-600';
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <div className={cn('flex items-center gap-1 mt-1 text-xs', color)}>
      <Icon className="w-3.5 h-3.5" />
      <span className="font-medium">
        {up ? '+' : ''}
        {deltaPct}%
      </span>
      <span className="text-gray-400">
        {compareLabel}
        {prev != null ? ` (${fmt(prev)})` : ''}
      </span>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">{title}</h3>
      {children}
    </div>
  );
}
