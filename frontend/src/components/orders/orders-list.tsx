'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  ExternalLink,
  RefreshCw,
  Search,
  Download,
  ChevronLeft,
  ChevronRight,
  Truck,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { fmtDate, zonedPresetRange, zonedStartOfDay, cn } from '@/lib/utils';
import {
  listCreatedOrders,
  type CreatedOrderRow,
  type OrdersResult,
  type OrdersScope,
} from '@/lib/orders';

type Preset = 'today' | '7d' | '30d' | '90d' | 'custom';

const PRESETS: Array<{ key: Preset; label: string; days: number }> = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
];

const PAGE_SIZE = 50;

function rangeFor(
  preset: Preset,
  customFrom: string,
  customTo: string,
): { from: string; to: string } {
  if (preset === 'custom') {
    // Interpret the picked calendar days in the tenant's timezone.
    const from = zonedStartOfDay(new Date(`${customFrom}T12:00:00`));
    const toStart = zonedStartOfDay(new Date(`${customTo}T12:00:00`));
    return {
      from: from.toISOString(),
      to: new Date(toStart.getTime() + 86_400_000).toISOString(),
    };
  }
  return zonedPresetRange(PRESETS.find((p) => p.key === preset)!.days);
}

function money(value: number | null, currency: string | null): string {
  if (value == null) return '—';
  return `${currency ? currency + ' ' : ''}${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`;
}

// Humanize + colour a Shopify financial/fulfillment status.
function StatusBadge({
  value,
  kind,
}: {
  value: string | null;
  kind: 'financial' | 'fulfillment';
}) {
  if (!value) return <span className="text-gray-400">—</span>;
  const v = value.toUpperCase();
  const label = value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  let tone = 'bg-gray-100 text-gray-600';
  if (kind === 'financial') {
    if (v === 'PAID') tone = 'bg-green-100 text-green-700';
    else if (v === 'PENDING' || v === 'AUTHORIZED')
      tone = 'bg-amber-100 text-amber-700';
    else if (v.includes('REFUND')) tone = 'bg-purple-100 text-purple-700';
    else if (v === 'VOIDED') tone = 'bg-gray-200 text-gray-600';
  } else {
    if (v === 'FULFILLED') tone = 'bg-green-100 text-green-700';
    else if (v === 'PARTIALLY_FULFILLED')
      tone = 'bg-blue-100 text-blue-700';
    else if (v === 'UNFULFILLED') tone = 'bg-gray-100 text-gray-600';
    else if (v === 'IN_TRANSIT' || v === 'OUT_FOR_DELIVERY')
      tone = 'bg-blue-100 text-blue-700';
  }
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tone,
      )}
    >
      {label}
    </span>
  );
}

function toCsv(rows: CreatedOrderRow[], scope: OrdersScope): string {
  const head = [
    'Order no.',
    'Date',
    'Items',
    'Customer',
    'Email',
    'City',
    'Value',
    'Currency',
    'Payment',
    'Fulfillment',
    'Tracking',
    scope === 'ad' ? 'Ad source' : 'Agent',
  ];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [
      r.orderNo ?? '',
      r.dateCreated ? fmtDate(r.dateCreated) : '',
      r.items.map((it) => `${it.quantity}x ${it.title}`).join('; '),
      r.customerName ?? '',
      r.contactEmail ?? '',
      r.city ?? '',
      r.orderValue ?? '',
      r.currency ?? '',
      r.financialStatus ?? '',
      r.fulfillmentStatus ?? '',
      r.tracking.map((t) => `${t.company ?? ''} ${t.number ?? ''}`.trim()).join('; '),
      scope === 'ad' ? r.adHeadline || r.adSourceType || 'Ad' : r.agentName || '',
    ]
      .map(esc)
      .join(','),
  );
  return [head.join(','), ...lines].join('\n');
}

export function OrdersList({ scope }: { scope: OrdersScope }) {
  const [preset, setPreset] = useState<Preset>('30d');
  const [customFrom, setCustomFrom] = useState(() =>
    new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
  );
  const [customTo, setCustomTo] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<OrdersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(
    () => rangeFor(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  // Debounce the search box.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchInput]);

  // Any filter change resets to page 1.
  useEffect(() => {
    setPage(1);
  }, [scope, range.from, range.to, search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await listCreatedOrders(scope, {
          from: range.from,
          to: range.to,
          page,
          pageSize: PAGE_SIZE,
          search,
        }),
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [scope, range.from, range.to, page, search]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstRow = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(page * PAGE_SIZE, total);
  const lastCol = scope === 'ad' ? 'Ad source' : 'Agent';

  const exportCsv = () => {
    const csv = toCsv(rows, scope);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${scope}-orders-${range.from.slice(0, 10)}_${range.to.slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPreset(p.key)}
                className={cn(
                  'px-3 py-1.5 text-sm rounded-md transition-colors',
                  preset === p.key
                    ? 'bg-green-600 text-white'
                    : 'text-gray-600 hover:bg-gray-100',
                )}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPreset('custom')}
              className={cn(
                'px-3 py-1.5 text-sm rounded-md transition-colors',
                preset === 'custom'
                  ? 'bg-green-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100',
              )}
            >
              Custom
            </button>
          </div>
          {preset === 'custom' && (
            <div className="flex items-center gap-1.5 text-sm">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
              />
              <span className="text-gray-400">→</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
              />
            </div>
          )}
          <div className="relative">
            <Search
              size={15}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={
                scope === 'ad'
                  ? 'Search customer / order…'
                  : 'Search customer / order…'
              }
              className="border border-gray-300 rounded-lg pl-8 pr-3 py-1.5 text-sm w-56"
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-40"
          >
            <Download size={15} />
            CSV
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary */}
      {data && (
        <div className="flex flex-wrap items-stretch gap-3">
          <div className="rounded-xl border border-gray-200 bg-white px-5 py-3">
            <p className="text-xs text-gray-500">Total orders</p>
            <p className="text-2xl font-bold text-gray-900">
              {data.summary.totalOrders.toLocaleString()}
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white px-5 py-3">
            <p className="text-xs text-gray-500">Total value</p>
            <p className="text-2xl font-bold text-gray-900">
              {money(data.summary.totalValue, data.summary.currency)}
            </p>
            <p className="text-[11px] text-gray-400">captured orders</p>
          </div>
          {scope === 'agent' && data.summary.byAgent.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white px-5 py-3 flex-1 min-w-[240px]">
              <p className="text-xs text-gray-500 mb-1.5">By agent</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {data.summary.byAgent.map((a) => (
                  <span key={a.name} className="text-sm text-gray-700">
                    <span className="font-medium">{a.name}</span>{' '}
                    <span className="text-gray-500">
                      {a.orders}
                      {a.value > 0 && ` · ${money(a.value, data.summary.currency)}`}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      {loading && !data ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          {scope === 'ad'
            ? 'No orders attributed to an ad in this period.'
            : 'No agent-created orders in this period.'}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Order no.</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Items</th>
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium text-right">Value</th>
                  <th className="px-4 py-3 font-medium">Payment</th>
                  <th className="px-4 py-3 font-medium">Fulfillment</th>
                  <th className="px-4 py-3 font-medium">Tracking</th>
                  <th className="px-4 py-3 font-medium">{lastCol}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.orderGid} className="hover:bg-gray-50 align-top">
                    <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                      {r.adminUrl ? (
                        <a
                          href={r.adminUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-green-700 hover:underline"
                        >
                          {r.orderNo || '—'}
                          <ExternalLink size={13} />
                        </a>
                      ) : (
                        r.orderNo || '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                      {r.dateCreated ? fmtDate(r.dateCreated) : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-600 max-w-[240px]">
                      {r.items.length ? (
                        <span className="line-clamp-2">
                          {r.items
                            .map((it) => `${it.quantity}× ${it.title}`)
                            .join(', ')}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {r.customerName || r.contactEmail || '—'}
                      {r.city && (
                        <span className="block text-xs text-gray-400">
                          {r.city}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900 whitespace-nowrap">
                      {money(r.orderValue, r.currency)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge value={r.financialStatus} kind="financial" />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        value={r.fulfillmentStatus}
                        kind="fulfillment"
                      />
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {r.tracking.length ? (
                        <div className="space-y-0.5">
                          {r.tracking.map((t, i) => (
                            <span key={i} className="block whitespace-nowrap">
                              {t.url ? (
                                <a
                                  href={t.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-green-700 hover:underline"
                                >
                                  <Truck size={12} />
                                  {t.company || t.number || 'Track'}
                                </a>
                              ) : (
                                <span className="inline-flex items-center gap-1">
                                  <Truck size={12} className="text-gray-400" />
                                  {t.company ? `${t.company} ` : ''}
                                  {t.number}
                                </span>
                              )}
                            </span>
                          ))}
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {scope === 'ad'
                        ? r.adHeadline || r.adSourceType || 'Ad'
                        : r.agentName || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-sm text-gray-500">
            <span>
              {firstRow.toLocaleString()}–{lastRow.toLocaleString()} of{' '}
              {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
                className="p-1.5 rounded-md hover:bg-gray-100 disabled:opacity-40"
                aria-label="Previous page"
              >
                <ChevronLeft size={18} />
              </button>
              <span className="px-2">
                Page {page} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || loading}
                className="p-1.5 rounded-md hover:bg-gray-100 disabled:opacity-40"
                aria-label="Next page"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
