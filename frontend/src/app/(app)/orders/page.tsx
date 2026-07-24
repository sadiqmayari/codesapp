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
  type AbandonedCheckout,
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

/** Items chip → popover listing each line (title × qty). */
function ItemsCell({ summary }: { summary: string | null }) {
  const items = parseItems(summary);
  if (!items.length) return <span className="text-gray-400">—</span>;
  const count = items.reduce((n, it) => n + it.qty, 0);
  return (
    <PopoverChip
      width={280}
      label={
        <span className="inline-flex items-center gap-1 text-sm text-gray-700">
          <Package size={14} className="text-gray-400" />
          {count} item{count === 1 ? '' : 's'}
        </span>
      }
    >
      <div className="space-y-2 max-h-72 overflow-y-auto">
        {items.map((it, i) => (
          <div key={i} className="flex items-start justify-between gap-3">
            <span className="text-sm text-gray-800 break-words">{it.title}</span>
            <span className="text-sm text-gray-500 shrink-0">× {it.qty}</span>
          </div>
        ))}
      </div>
    </PopoverChip>
  );
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

  /** Manually send the configured abandoned-cart template to this cart. */
  const sendMessage = async (id: number) => {
    setSending((s) => ({ ...s, [id]: true }));
    try {
      await sendAbandonedMessage(id);
      toast.success('Message sent');
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to send message',
      );
    } finally {
      setSending((s) => ({ ...s, [id]: false }));
    }
  };

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
    } catch (e) {
      setError(
        e instanceof ApiError ? e.userMessage : 'Failed to load checkouts',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onCreated = async () => {
    if (!active) return;
    const id = active.id;
    try {
      await dismissAbandonedCheckout(id);
    } catch {
      // best-effort — the webhook backstop will also convert it
    }
    setRows((r) => r.filter((x) => x.id !== id));
  };

  const cur = stats?.currency ?? null;

  return (
    <div className="space-y-4">
      {/* KPI tiles */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Pending carts" value={stats.pending.toLocaleString()} />
          <Stat
            label="Value at risk"
            value={money(stats.valueAtRisk, cur)}
            accent="amber"
          />
          <Stat
            label="Recovered (30d)"
            value={`${stats.recovered.toLocaleString()} / ${stats.recordedRecent.toLocaleString()}`}
            hint={`${stats.recoveryRate}% recovered via CodesApp`}
            accent="green"
          />
          <Stat
            label="Recovered revenue (30d)"
            value={money(stats.recoveredRevenue, cur)}
            hint="orders created in CodesApp"
            accent="green"
          />
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Carts left without checking out. Customers who already ordered today
          are hidden automatically.
        </p>
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

      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState stats={stats} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Items</th>
                <th className="px-4 py-3 font-medium text-right">Cart value</th>
                <th className="px-4 py-3 font-medium">Abandoned</th>
                <th className="px-4 py-3 font-medium">Assignee</th>
                <th className="px-4 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <CustomerCell row={r} />
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    <ItemsCell summary={r.itemsSummary} />
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-gray-800">
                    {money(r.totalPrice, r.currency ?? cur)}
                  </td>
                  <td
                    className="px-4 py-3 text-gray-500 whitespace-nowrap"
                    title={fmtDateTime(r.createdAt)}
                  >
                    {timeAgo(r.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    {isAdmin ? (
                      <select
                        value={r.assignedUserId ?? ''}
                        onChange={(e) =>
                          assign(
                            r.id,
                            e.target.value ? Number(e.target.value) : null,
                          )
                        }
                        className="border border-gray-300 rounded-lg px-2 py-1 text-xs max-w-[140px]"
                      >
                        <option value="">Unassigned</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-gray-600">
                        {r.assignedName || '—'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
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
                        title="Send the configured abandoned-cart WhatsApp template"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {sending[r.id] ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Send size={14} />
                        )}
                        Send message
                      </button>
                      <button
                        type="button"
                        onClick={() => setActive(r)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                      >
                        <ShoppingCart size={14} />
                        Create order
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {active && (
        <CreateOrderModal
          contactName={active.contactName}
          contactPhone={active.phone}
          contactEmail={active.email}
          assignedAgentName={user?.name ?? null}
          extraTags={['Abandoned Checkout']}
          orderSource="abandoned_cart"
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
