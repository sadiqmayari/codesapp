'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Loader2,
  ShoppingCart,
  ExternalLink,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import CreateOrderModal from '@/components/inbox/create-order-modal';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';
import {
  listAbandonedCheckouts,
  dismissAbandonedCheckout,
  getAbandonedStats,
  assignAbandonedCheckout,
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

export default function AbandonedCheckoutsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<AbandonedCheckout[]>([]);
  const [stats, setStats] = useState<AbandonedStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<AbandonedCheckout | null>(null);
  const [agents, setAgents] = useState<Array<{ id: number; name: string }>>([]);
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
            value={`${stats.recovered.toLocaleString()} / ${stats.recoverySent.toLocaleString()}`}
            hint={`${stats.recoveryRate}% recovery rate`}
            accent="green"
          />
          <Stat
            label="Recovered revenue (30d)"
            value={money(stats.recoveredRevenue, cur)}
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
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Email</th>
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
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {r.contactName || '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{r.phone || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{r.email || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 max-w-[260px] truncate">
                    {r.itemsSummary || '—'}
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
