'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { ConfirmDialog } from '@/components/ui/modal';
import { cn, fmtDate } from '@/lib/utils';
import type {
  ActivationStatus,
  ClientCompany,
  Paged,
} from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

const FILTERS: Array<{
  key: ActivationStatus | 'all';
  label: string;
  tint: string;
}> = [
  { key: 'all', label: 'All', tint: 'bg-gray-100 text-gray-700' },
  { key: 'pending', label: 'Pending', tint: 'bg-amber-100 text-amber-700' },
  { key: 'active', label: 'Active', tint: 'bg-green-100 text-green-700' },
  { key: 'suspended', label: 'Suspended', tint: 'bg-red-100 text-red-700' },
];

const LIMIT = 20;

function StatusPill({ status }: { status: ActivationStatus }) {
  const tint =
    status === 'active'
      ? 'bg-green-100 text-green-700'
      : status === 'pending'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-red-100 text-red-700';
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize',
        tint,
      )}
    >
      {status}
    </span>
  );
}

export default function SuperAdminClientsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ClientCompany[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<ActivationStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState<{
    id: number;
    action: 'activate' | 'suspend';
    name: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  // Initial filter from ?status=
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('status');
    if (s === 'pending' || s === 'active' || s === 'suspended') setFilter(s);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch<Paged<ClientCompany>>(
        '/super-admin/clients',
        { params: { page, limit: LIMIT }, noOnboardingRedirect: true },
      );
      setRows(res.items);
      setTotal(res.meta.total);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load clients');
    } finally {
      setLoading(false);
    }
  }, [page, router]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== 'all' && r.activation_status !== filter) return false;
      if (q && !r.company_name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, filter, search]);

  const runAction = async () => {
    if (!confirm) return;
    const { id, action } = confirm;
    const nextStatus: ActivationStatus =
      action === 'activate' ? 'active' : 'suspended';
    const prev = rows;
    setBusy(true);
    setRows((cur) =>
      cur.map((r) =>
        r.id === id ? { ...r, activation_status: nextStatus } : r,
      ),
    );
    try {
      await apiFetch(`/super-admin/clients/${id}/${action}`, {
        method: 'PATCH',
        noOnboardingRedirect: true,
      });
      setConfirm(null);
    } catch (e) {
      setRows(prev);
      setError(
        e instanceof ApiError ? e.userMessage : 'Action failed — rolled back',
      );
    } finally {
      setBusy(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const counts = useMemo(() => {
    const c = { all: rows.length, pending: 0, active: 0, suspended: 0 };
    rows.forEach((r) => {
      c[r.activation_status as keyof typeof c]++;
    });
    return c;
  }, [rows]);

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {total.toLocaleString()} total · page {page}/{totalPages}
          </p>
        </div>
        <div className="relative">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company on this page…"
            className="bg-white border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm w-full sm:w-72 focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const c =
            f.key === 'all'
              ? counts.all
              : (counts[f.key as 'pending' | 'active' | 'suspended'] ?? 0);
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'rounded-full px-3 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5',
                filter === f.key
                  ? 'bg-green-600 text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50',
              )}
            >
              {f.label}
              <span
                className={cn(
                  'rounded-full px-1.5 py-0 text-[10px] font-semibold',
                  filter === f.key ? 'bg-white/20' : f.tint,
                )}
              >
                {c}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Company</th>
                <th className="text-left px-4 py-3 font-medium">Plan</th>
                <th className="text-right px-4 py-3 font-medium">MRR</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Created</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-12 text-center text-gray-400"
                  >
                    Loading…
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-12 text-center text-gray-400"
                  >
                    No clients match.
                  </td>
                </tr>
              ) : (
                visible.map((c) => (
                  <tr
                    key={c.id}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-green-100 to-emerald-100 text-green-700 flex items-center justify-center text-xs font-semibold shrink-0">
                          {c.company_name.slice(0, 1).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900 truncate">
                            {c.company_name}
                          </p>
                          <p className="text-[11px] text-gray-400">#{c.id}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-700 capitalize">
                      {c.subscription?.plan_name ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-800">
                      {c.subscription
                        ? `$${Number(c.subscription.monthly_price).toLocaleString()}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={c.activation_status} />
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {fmtDate(c.created_at)}
                    </td>
                    <td className="px-4 py-3 text-right space-x-2">
                      <Link
                        href={`/super-admin/clients/${c.id}`}
                        className="inline-block rounded-lg border border-gray-200 hover:bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700"
                      >
                        View profile
                      </Link>
                      {c.activation_status === 'pending' && (
                        <button
                          onClick={() =>
                            setConfirm({
                              id: c.id,
                              action: 'activate',
                              name: c.company_name,
                            })
                          }
                          className="rounded-lg bg-green-600 hover:bg-green-700 px-3 py-1.5 text-xs font-medium text-white"
                        >
                          Activate
                        </button>
                      )}
                      {c.activation_status === 'active' && (
                        <button
                          onClick={() =>
                            setConfirm({
                              id: c.id,
                              action: 'suspend',
                              name: c.company_name,
                            })
                          }
                          className="rounded-lg bg-red-600 hover:bg-red-700 px-3 py-1.5 text-xs font-medium text-white"
                        >
                          Suspend
                        </button>
                      )}
                      {c.activation_status === 'suspended' && (
                        <button
                          onClick={() =>
                            setConfirm({
                              id: c.id,
                              action: 'activate',
                              name: c.company_name,
                            })
                          }
                          className="rounded-lg bg-green-600 hover:bg-green-700 px-3 py-1.5 text-xs font-medium text-white"
                        >
                          Reactivate
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-sm text-gray-500">
          <span>
            Showing {visible.length} of {total.toLocaleString()}
          </span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-50"
            >
              <ChevronLeft size={14} /> Prev
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-50"
            >
              Next <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirm}
        title={
          confirm?.action === 'suspend' ? 'Suspend client' : 'Activate client'
        }
        message={
          confirm?.action === 'suspend'
            ? `Suspend "${confirm?.name}"? The tenant owner will be unable to sign in until reactivated.`
            : `Activate "${confirm?.name}"? The tenant owner will be able to sign in immediately.`
        }
        confirmLabel={confirm?.action === 'suspend' ? 'Suspend' : 'Activate'}
        danger={confirm?.action === 'suspend'}
        busy={busy}
        onConfirm={runAction}
        onCancel={() => !busy && setConfirm(null)}
      />

      {/* Per-client deep actions (impersonate / delete / grace / usage policy /
          billing & invoices / users / integrations) now live on the dedicated
          profile page at /super-admin/clients/[id] — far more space than a
          modal can give. Only the inline activate/suspend confirm remains here. */}
    </div>
  );
}
