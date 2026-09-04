'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2,
  ShoppingCart,
  ExternalLink,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  Phone as PhoneIcon,
  Mail as MailIcon,
  Package,
  Send,
} from 'lucide-react';
import CreateOrderModal from '@/components/inbox/create-order-modal';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { fmtDateTime, cn } from '@/lib/utils';
import {
  listAbandonedCheckouts,
  dismissAbandonedCheckout,
  getAbandonedStats,
  assignAbandonedCheckout,
  sendAbandonedMessage,
  setAbandonedOutcome,
  type AbandonedCheckout,
  type AbandonedOutcome,
  type AbandonedCartItem,
  type AbandonedStats,
} from '@/lib/orders';

function money(v: number | null | undefined, cur: string | null): string {
  if (v == null || v <= 0) return '—';
  return `${cur ? cur + ' ' : ''}${v.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`;
}

/** Compact "time since" — "just now", "3h ago", "2d ago". */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Shopify-style chip that opens a fixed-position popover (so the table's
 * horizontal scroll can't clip it). Closes on outside-click / scroll / resize.
 */
function PopoverChip({
  label,
  width = 260,
  children,
}: {
  label: React.ReactNode;
  width?: number;
  children: React.ReactNode;
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

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
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
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-left hover:bg-gray-100"
      >
        {label}
        <ChevronDown
          size={13}
          className={cn('shrink-0 text-gray-400 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && pos && (
        <div
          ref={popRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width }}
          className="z-50 rounded-xl border border-gray-200 bg-white p-3 shadow-xl"
        >
          {children}
        </div>
      )}
    </>
  );
}

/** Customer name chip → popover with phone + email (saves two columns). */
function CustomerCell({ row }: { row: AbandonedCheckout }) {
  const name = row.contactName || 'Unknown customer';
  return (
    <PopoverChip
      label={<span className="font-medium text-gray-900 truncate">{name}</span>}
    >
      <p className="text-sm font-medium text-gray-900 mb-2">{name}</p>
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center gap-2 text-gray-700">
          <PhoneIcon size={14} className="text-gray-400 shrink-0" />
          {row.phone ? (
            <a href={`tel:${row.phone}`} className="hover:underline break-all">
              {row.phone}
            </a>
          ) : (
            <span className="text-gray-400">No phone</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-gray-700">
          <MailIcon size={14} className="text-gray-400 shrink-0" />
          {row.email ? (
            <a href={`mailto:${row.email}`} className="hover:underline break-all">
              {row.email}
            </a>
          ) : (
            <span className="text-gray-400">No email</span>
          )}
        </div>
      </div>
    </PopoverChip>
  );
}

/** Parse an "1x Title, 2x Title" summary into structured lines. */
function parseItems(summary: string | null): Array<{ qty: number; title: string }> {
  if (!summary) return [];
  return summary
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(\d+)\s*x\s*(.+)$/i);
      return m
        ? { qty: Number(m[1]) || 1, title: m[2].trim() }
        : { qty: 1, title: part };
    });
}

/**
 * Items chip → popover listing each line. Prefers the STRUCTURED cart lines
 * (variant + price, captured from the checkout webhook); falls back to parsing
 * the flat summary for carts recorded before that shipped.
 */
function ItemsCell({
  summary,
  items,
  currency,
}: {
  summary: string | null;
  items?: AbandonedCartItem[];
  currency: string | null;
}) {
  const structured = items ?? [];
  const lines = structured.length
    ? structured.map((it) => ({
        title: it.variantTitle ? `${it.title} — ${it.variantTitle}` : it.title,
        qty: it.quantity,
        price: it.price,
      }))
    : parseItems(summary).map((it) => ({
        title: it.title,
        qty: it.qty,
        price: null as string | null,
      }));
  if (!lines.length) return <span className="text-gray-400">—</span>;
  const count = lines.reduce((n, it) => n + it.qty, 0);
  return (
    <PopoverChip
      width={300}
      label={
        <span className="inline-flex items-center gap-1 text-sm text-gray-700">
          <Package size={14} className="text-gray-400" />
          {count} item{count === 1 ? '' : 's'}
        </span>
      }
    >
      <div className="space-y-2.5 max-h-72 overflow-y-auto">
        {lines.map((it, i) => (
          <div key={i} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-gray-800 break-words">{it.title}</p>
              {it.price && (
                <p className="text-xs text-gray-500 mt-0.5">
                  {money(Number(it.price), currency)}
                </p>
              )}
            </div>
            <span className="text-sm text-gray-500 shrink-0">× {it.qty}</span>
          </div>
        ))}
      </div>
    </PopoverChip>
  );
}

type Lane = 'new' | 'contacted' | 'not_interested';
type SortKey = 'best' | 'value' | 'new';

/** Hours since a cart was abandoned. */
function ageHours(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms / 3_600_000 : 0;
}
/** Decay tone by age — fresh money is teal, a week-old cart is grey. */
function decay(iso: string): { rail: string; dot: string } {
  const h = ageHours(iso);
  if (h < 24) return { rail: 'bg-teal-500', dot: 'bg-teal-500' };
  if (h < 24 * 7) return { rail: 'bg-amber-500', dot: 'bg-amber-500' };
  return { rail: 'bg-gray-300', dot: 'bg-gray-400' };
}

export default function AbandonedCheckoutsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<AbandonedCheckout[]>([]);
  const [stats, setStats] = useState<AbandonedStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<AbandonedCheckout | null>(null);
  const [agents, setAgents] = useState<Array<{ id: number; name: string }>>([]);
  const [sending, setSending] = useState<Record<number, boolean>>({});
  const [lane, setLane] = useState<Lane>('new');
  const [sort, setSort] = useState<SortKey>('best');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busyOutcome, setBusyOutcome] = useState(false);
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin) return;
    apiFetch<Array<{ id: number; name: string; status: string }>>('/team')
      .then((list) =>
        setAgents(
          list
            .filter((m) => m.status !== 'suspended')
            .map((m) => ({ id: m.id, name: m.name })),
        ),
      )
      .catch(() => {});
  }, [isAdmin]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, s] = await Promise.all([
        listAbandonedCheckouts(),
        getAbandonedStats().catch(() => null),
      ]);
      setRows(list);
      setStats(s);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load checkouts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const assign = async (id: number, userId: number | null) => {
    setRows((r) =>
      r.map((x) =>
        x.id === id
          ? {
              ...x,
              assignedUserId: userId,
              assignedName: agents.find((a) => a.id === userId)?.name ?? null,
            }
          : x,
      ),
    );
    try {
      await assignAbandonedCheckout(id, userId);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to assign');
      load();
    }
  };

  // Set the disposition on one or many carts, optimistically. The row then
  // reflows into its lane (Contacted / Not interested) or back to New (null).
  const markOutcome = async (ids: number[], outcome: AbandonedOutcome | null) => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    setRows((r) =>
      r.map((x) => (idSet.has(x.id) ? { ...x, agentOutcome: outcome } : x)),
    );
    setSelected(new Set());
    setBusyOutcome(true);
    try {
      await setAbandonedOutcome(ids, outcome);
      const verb =
        outcome === 'not_interested'
          ? 'Marked not interested'
          : outcome === 'contacted'
            ? 'Marked contacted'
            : 'Returned to New';
      toast.success(`${verb} · ${ids.length} cart${ids.length === 1 ? '' : 's'}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to update');
      load();
    } finally {
      setBusyOutcome(false);
    }
  };

  /** Manually WhatsApp the configured template — and record it as contacted. */
  const sendMessage = async (id: number) => {
    setSending((s) => ({ ...s, [id]: true }));
    try {
      await sendAbandonedMessage(id);
      toast.success('Message sent');
      markOutcome([id], 'contacted');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to send message');
    } finally {
      setSending((s) => ({ ...s, [id]: false }));
    }
  };

  const onCreated = async () => {
    if (!active) return;
    const id = active.id;
    try {
      await dismissAbandonedCheckout(id);
    } catch {
      /* best-effort — the webhook backstop also converts it */
    }
    setRows((r) => r.filter((x) => x.id !== id));
  };

  const cur = stats?.currency ?? null;

  // Lane membership + counts (client-side over the full pending list).
  const laneOf = (r: AbandonedCheckout): Lane =>
    r.agentOutcome === 'not_interested'
      ? 'not_interested'
      : r.agentOutcome === 'contacted'
        ? 'contacted'
        : 'new';
  const counts = { new: 0, contacted: 0, not_interested: 0 } as Record<Lane, number>;
  for (const r of rows) counts[laneOf(r)] += 1;

  const laneRows = rows.filter((r) => laneOf(r) === lane);
  const sortedRows = laneRows.slice().sort((a, b) => {
    if (sort === 'value') return (b.totalPrice ?? 0) - (a.totalPrice ?? 0);
    if (sort === 'new') return ageHours(a.createdAt) - ageHours(b.createdAt);
    // best = value weighted by freshness (older decays the score)
    const score = (r: AbandonedCheckout) =>
      (r.totalPrice ?? 0) / Math.max(1, Math.sqrt(ageHours(r.createdAt)));
    return score(b) - score(a);
  });

  // KPI figures the New lane cares about — computed from the live list.
  const newRows = rows.filter((r) => laneOf(r) === 'new');
  const valueAtRisk = newRows.reduce((n, r) => n + (r.totalPrice ?? 0), 0);
  const freshRows = newRows.filter((r) => ageHours(r.createdAt) < 24);
  const freshValue = freshRows.reduce((n, r) => n + (r.totalPrice ?? 0), 0);
  const staleRows = newRows.filter((r) => ageHours(r.createdAt) >= 24 * 7);
  const staleValue = staleRows.reduce((n, r) => n + (r.totalPrice ?? 0), 0);

  const allSelectedOnLane =
    sortedRows.length > 0 && sortedRows.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected(
      allSelectedOnLane ? new Set() : new Set(sortedRows.map((r) => r.id)),
    );
  const toggleOne = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectStale = () => setSelected(new Set(staleRows.map((r) => r.id)));

  const LANES: Array<[Lane, string]> = [
    ['new', 'New'],
    ['contacted', 'Contacted'],
    ['not_interested', 'Not interested'],
  ];

  return (
    <div className="space-y-4">
      {/* KPI tiles */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Value at risk"
            value={money(valueAtRisk, cur)}
            hint={`${newRows.length.toLocaleString()} carts to work`}
            accent="amber"
          />
          <Stat
            label="Fresh · under 24h"
            value={money(freshValue, cur)}
            hint={`${freshRows.length.toLocaleString()} carts · call now`}
            accent="green"
          />
          <Stat
            label="Recovered (30d)"
            value={money(stats.recoveredRevenue, cur)}
            hint={`${stats.recovered.toLocaleString()} of ${stats.recordedRecent.toLocaleString()} · ${stats.recoveryRate}%`}
            accent="green"
          />
          <Stat
            label="Going stale · 7d+"
            value={staleRows.length.toLocaleString()}
            hint={money(staleValue, cur)}
          />
        </div>
      )}

      {/* Lanes + sort */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1">
          {LANES.map(([k, label]) => (
            <button
              key={k}
              onClick={() => {
                setLane(k);
                setSelected(new Set());
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors',
                lane === k
                  ? 'bg-white font-semibold text-gray-900 shadow-sm ring-1 ring-gray-200'
                  : 'text-gray-600 hover:bg-white/60 hover:text-gray-900',
              )}
            >
              {label}
              <span
                className={cn(
                  'rounded-full px-1.5 text-[11px] font-mono',
                  lane === k ? 'bg-green-50 text-green-700' : 'bg-gray-200 text-gray-500',
                )}
              >
                {counts[k]}
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {lane === 'new' && staleRows.length > 0 && (
            <button
              onClick={selectStale}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
              title="Select every cart older than 7 days so you can clear them"
            >
              Select {staleRows.length} stale
            </button>
          )}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700"
          >
            <option value="best">Best first (value × freshness)</option>
            <option value="value">Highest value</option>
            <option value="new">Newest</option>
          </select>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* Selection bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm">
          <span className="font-semibold text-green-800">
            {selected.size} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {lane !== 'contacted' && (
              <button
                onClick={() => markOutcome(Array.from(selected), 'contacted')}
                disabled={busyOutcome}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Mark contacted
              </button>
            )}
            {lane !== 'not_interested' ? (
              <button
                onClick={() => markOutcome(Array.from(selected), 'not_interested')}
                disabled={busyOutcome}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                Not interested
              </button>
            ) : (
              <button
                onClick={() => markOutcome(Array.from(selected), null)}
                disabled={busyOutcome}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Restore to New
              </button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      ) : sortedRows.length === 0 ? (
        lane === 'new' ? (
          <EmptyState stats={stats} />
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
            {lane === 'contacted'
              ? 'No carts marked contacted yet.'
              : 'No carts marked not interested.'}
          </div>
        )
      ) : (
        <>
          {/* Phone: cards. */}
          <div className="space-y-2 md:hidden">
            {sortedRows.map((r) => {
              const d = decay(r.createdAt);
              return (
                <div
                  key={r.id}
                  className={cn(
                    'relative overflow-hidden rounded-xl border bg-white p-3 pl-4',
                    selected.has(r.id) ? 'border-green-300 bg-green-50/60' : 'border-gray-200',
                  )}
                >
                  <span className={cn('absolute inset-y-0 left-0 w-1.5', d.rail)} />
                  <div className="flex items-start justify-between gap-2">
                    <label className="flex min-w-0 items-start gap-2">
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggleOne(r.id)}
                        className="mt-0.5 shrink-0 cursor-pointer"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium text-gray-800">
                          {r.contactName || r.phone || '—'}
                        </span>
                        <span className="block truncate text-xs text-gray-500">
                          {r.itemsSummary || '—'}
                        </span>
                      </span>
                    </label>
                    <span className="shrink-0 text-right">
                      <span className="block font-mono text-sm font-semibold text-gray-900">
                        {money(r.totalPrice, r.currency ?? cur)}
                      </span>
                      <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-gray-400">
                        <span className={cn('h-1.5 w-1.5 rounded-full', d.dot)} />
                        {timeAgo(r.createdAt)}
                      </span>
                    </span>
                  </div>
                  <div className="mt-2.5 flex gap-1.5">
                    <button
                      onClick={() => sendMessage(r.id)}
                      disabled={!!sending[r.id]}
                      className="flex-1 rounded-lg bg-[#25D366] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      {sending[r.id] ? 'Sending…' : 'WhatsApp'}
                    </button>
                    {lane === 'not_interested' ? (
                      <button
                        onClick={() => markOutcome([r.id], null)}
                        className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700"
                      >
                        Restore
                      </button>
                    ) : (
                      <>
                        {lane !== 'contacted' && (
                          <button
                            onClick={() => markOutcome([r.id], 'contacted')}
                            className="flex-1 rounded-lg border border-sky-300 px-3 py-2 text-xs font-semibold text-sky-700"
                          >
                            Contacted
                          </button>
                        )}
                        <button
                          onClick={() => markOutcome([r.id], 'not_interested')}
                          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700"
                        >
                          Not interested
                        </button>
                        <button
                          onClick={() => setActive(r)}
                          className="flex-1 rounded-lg bg-green-600 px-3 py-2 text-xs font-semibold text-white"
                        >
                          Order
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Desktop: table. */}
          <div className="hidden overflow-x-auto rounded-lg border border-gray-200 bg-white md:block">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-3 w-8">
                    <input
                      type="checkbox"
                      checked={allSelectedOnLane}
                      onChange={toggleAll}
                      aria-label="Select all"
                    />
                  </th>
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium">Cart</th>
                  <th className="px-4 py-3 text-right font-medium">Value</th>
                  <th className="px-4 py-3 font-medium">Abandoned</th>
                  <th className="px-4 py-3 font-medium">Assignee</th>
                  <th className="px-4 py-3 text-right font-medium">Recover</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortedRows.map((r) => {
                  const d = decay(r.createdAt);
                  return (
                    <tr
                      key={r.id}
                      className={cn('hover:bg-gray-50', selected.has(r.id) && 'bg-green-50/60')}
                    >
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <span className={cn('h-8 w-1 rounded-full', d.rail)} />
                          <input
                            type="checkbox"
                            checked={selected.has(r.id)}
                            onChange={() => toggleOne(r.id)}
                            className="cursor-pointer"
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <CustomerCell row={r} />
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        <ItemsCell
                          summary={r.itemsSummary}
                          items={r.items}
                          currency={r.currency ?? cur}
                        />
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-800">
                        {money(r.totalPrice, r.currency ?? cur)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-gray-500" title={fmtDateTime(r.createdAt)}>
                        <span className="inline-flex items-center gap-1.5">
                          <span className={cn('h-1.5 w-1.5 rounded-full', d.dot)} />
                          {timeAgo(r.createdAt)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {isAdmin ? (
                          <select
                            value={r.assignedUserId ?? ''}
                            onChange={(e) =>
                              assign(r.id, e.target.value ? Number(e.target.value) : null)
                            }
                            className="max-w-[140px] rounded-lg border border-gray-300 px-2 py-1 text-xs"
                          >
                            <option value="">Unassigned</option>
                            {agents.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-gray-600">{r.assignedName || '—'}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {r.recoveryUrl && (
                            <a
                              href={r.recoveryUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-gray-400 hover:text-gray-700"
                              title="Open recovery link"
                            >
                              <ExternalLink size={16} />
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => sendMessage(r.id)}
                            disabled={!!sending[r.id]}
                            title="WhatsApp the recovery template (marks contacted)"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            {sending[r.id] ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Send size={14} />
                            )}
                            Message
                          </button>
                          {lane === 'not_interested' ? (
                            <button
                              type="button"
                              onClick={() => markOutcome([r.id], null)}
                              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            >
                              Restore
                            </button>
                          ) : (
                            <>
                              {lane !== 'contacted' && (
                                <button
                                  type="button"
                                  onClick={() => markOutcome([r.id], 'contacted')}
                                  title="Mark this cart contacted (e.g. after a call)"
                                  className="rounded-lg border border-sky-200 bg-white px-2.5 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-50"
                                >
                                  Contacted
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => markOutcome([r.id], 'not_interested')}
                                title="Customer isn't interested — clear this cart"
                                className="rounded-lg border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
                              >
                                Not interested
                              </button>
                              <button
                                type="button"
                                onClick={() => setActive(r)}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                              >
                                <ShoppingCart size={14} />
                                Create order
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {active && (
        <CreateOrderModal
          contactName={active.contactName}
          contactPhone={active.phone}
          contactEmail={active.email}
          contactAddress1={active.address1}
          contactCity={active.city}
          contactCountry={active.countryCode}
          assignedAgentName={user?.name ?? null}
          extraTags={['Abandoned Checkout']}
          orderSource="abandoned_cart"
          prefillItems={active.items}
          onCreated={onCreated}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: 'amber' | 'green';
}) {
  const color =
    accent === 'amber'
      ? 'text-amber-600'
      : accent === 'green'
        ? 'text-green-600'
        : 'text-gray-900';
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function EmptyState({ stats }: { stats: AbandonedStats | null }) {
  // Never captured a single cart → almost always a missing webhook subscription.
  if (stats && stats.everRecorded === 0 && stats.webhookPath) {
    const url =
      typeof window !== 'undefined'
        ? `${window.location.origin}${stats.webhookPath}`
        : stats.webhookPath;
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800 space-y-2">
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangle size={16} />
          No abandoned carts captured yet
        </div>
        <p>
          To track abandoned carts, add these webhook topics in your Shopify
          admin (Settings → Notifications → Webhooks), both pointing to:
        </p>
        <code className="block bg-white border border-amber-200 rounded px-2 py-1 text-xs break-all text-gray-700">
          {url}
        </code>
        <p className="text-amber-700">
          Topics: <span className="font-mono">Checkout creation</span> and{' '}
          <span className="font-mono">Checkout update</span> (JSON). Carts appear
          here automatically once Shopify starts sending them.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
      No abandoned checkouts to recover right now.
    </div>
  );
}
