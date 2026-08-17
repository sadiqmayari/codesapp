'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  ExternalLink,
  RefreshCw,
  Search,
  Download,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ImageIcon,
  MessageCircle,
  Truck,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { fmtDate, zonedPresetRange, zonedStartOfDay, cn } from '@/lib/utils';
import {
  getOrderDetail,
  listCreatedOrders,
  type CreatedOrderRow,
  type OrderKey,
  type OrderLineItem,
  type OrdersResult,
  type OrdersScope,
} from '@/lib/orders';
import { OrderDetailDrawer } from '@/components/orders/order-detail-view';

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

/**
 * Shopify-style Items cell: a "N items ▾" chip that opens a popover with the
 * fulfillment badge and each line item (thumbnail, linked title, variant/"part
 * of" subtitle, × qty). Fixed-positioned so the table's horizontal scroll can't
 * clip it.
 */
function ItemsCell({
  items,
  fulfillmentStatus,
  adminUrl,
}: {
  items: OrderLineItem[];
  fulfillmentStatus: string | null;
  adminUrl: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (
        popRef.current?.contains(e.target as Node) ||
        btnRef.current?.contains(e.target as Node)
      )
        return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  if (!items.length) return <span className="text-gray-400">—</span>;
  const count = items.reduce((n, it) => n + (it.quantity || 0), 0);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 320;
      setPos({
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      });
    }
    setOpen(true);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
      >
        {count} item{count === 1 ? '' : 's'}
        <ChevronDown
          size={13}
          className={cn('transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && pos && (
        <div
          ref={popRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 320 }}
          className="z-50 rounded-xl border border-gray-200 bg-white p-3 shadow-xl"
        >
          {fulfillmentStatus && (
            <div className="mb-2">
              <StatusBadge value={fulfillmentStatus} kind="fulfillment" />
            </div>
          )}
          <div className="space-y-3 max-h-72 overflow-y-auto">
            {items.map((it, i) => {
              const subtitle = it.variantTitle
                ? it.variantTitle
                : it.productTitle && it.productTitle !== it.title
                  ? `Part of: ${it.productTitle}`
                  : null;
              return (
                <div key={i} className="flex items-start gap-3">
                  <div className="h-10 w-10 shrink-0 rounded-md border border-gray-200 bg-gray-50 flex items-center justify-center overflow-hidden">
                    {it.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={it.image}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <ImageIcon size={16} className="text-gray-300" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    {adminUrl ? (
                      <a
                        href={adminUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-green-700 hover:underline break-words"
                      >
                        {it.title}
                      </a>
                    ) : (
                      <span className="text-sm font-medium text-gray-800 break-words">
                        {it.title}
                      </span>
                    )}
                    {subtitle && (
                      <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
                    )}
                  </div>
                  <span className="text-sm text-gray-500 shrink-0">
                    × {it.quantity}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
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
    'Cancelled',
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
      r.cancelledAt ? r.cancelReason || 'cancelled' : '',
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
  const [drawerKey, setDrawerKey] = useState<OrderKey | null>(null);
  const [chatGid, setChatGid] = useState<string | null>(null);
  const router = useRouter();
  const toast = useToast();

  // Resolve the order's linked WhatsApp conversation and jump to it (one fetch
  // on click). Toasts when the order has no conversation yet.
  const openChat = async (gid: string) => {
    if (chatGid) return;
    setChatGid(gid);
    try {
      const detail = await getOrderDetail({ gid });
      if (detail.conversationId) {
        router.push(`/inbox/${detail.conversationId}`);
      } else {
        toast.info('No WhatsApp conversation is linked to this order yet.');
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not open the conversation');
    } finally {
      setChatGid(null);
    }
  };

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
                      <span className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDrawerKey({ gid: r.orderGid })}
                          className="font-semibold text-indigo-600 hover:underline"
                          title="Open order in CodesApp"
                        >
                          {r.orderNo || '—'}
                        </button>
                        <button
                          type="button"
                          onClick={() => openChat(r.orderGid)}
                          disabled={chatGid === r.orderGid}
                          className="text-gray-300 hover:text-[#22c35e] disabled:opacity-50"
                          title="Open WhatsApp conversation"
                        >
                          {chatGid === r.orderGid ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <MessageCircle size={13} />
                          )}
                        </button>
                        {r.adminUrl && (
                          <a
                            href={r.adminUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-gray-300 hover:text-green-700"
                            title="View in Shopify"
                          >
                            <ExternalLink size={13} />
                          </a>
                        )}
                      </span>
                      {r.cancelledAt && (
                        <span
                          className="ml-2 inline-block rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700 align-middle"
                          title={`${
                            r.cancelReason === 'voided' ? 'Voided' : 'Cancelled'
                          } on Shopify — kept as a record, not counted in totals`}
                        >
                          {r.cancelReason === 'voided' ? 'Voided' : 'Cancelled'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                      {r.dateCreated ? fmtDate(r.dateCreated) : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      <ItemsCell
                        items={r.items}
                        fulfillmentStatus={r.fulfillmentStatus}
                        adminUrl={r.adminUrl}
                      />
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {r.customerName || r.contactEmail || '—'}
                      {r.city && (
                        <span className="block text-xs text-gray-400">
                          {r.city}
                        </span>
                      )}
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-medium whitespace-nowrap ${
                        r.cancelledAt
                          ? 'text-gray-400 line-through'
                          : 'text-gray-900'
                      }`}
                    >
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

      {drawerKey && <OrderDetailDrawer orderKey={drawerKey} onClose={() => setDrawerKey(null)} />}
    </div>
  );
}
