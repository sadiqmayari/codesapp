'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  LogIn,
  Trash2,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { cn } from '@/lib/utils';
import { fmtDate } from '@/lib/utils';
import type {
  ActivationStatus,
  ClientCompany,
  Paged,
  UsageLimitAction,
} from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

const FILTERS: Array<{ key: ActivationStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'active', label: 'Active' },
  { key: 'suspended', label: 'Suspended' },
];

const LIMIT = 20;

function StatusPill({ status }: { status: ActivationStatus }) {
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize',
        status === 'active' && 'bg-green-900/50 text-green-300',
        status === 'pending' && 'bg-yellow-900/50 text-yellow-300',
        status === 'suspended' && 'bg-red-900/50 text-red-300',
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
  const [detail, setDetail] = useState<ClientCompany | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleteId, setDeleteId] = useState<{ id: number; name: string } | null>(
    null,
  );
  const [actionBusy, setActionBusy] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [graceDate, setGraceDate] = useState('');

  const patchDetail = (c: ClientCompany) => {
    setDetail(c);
    setRows((cur) =>
      cur.map((r) =>
        r.id === c.id
          ? { ...r, activation_status: c.activation_status }
          : r,
      ),
    );
  };

  const setUsagePolicy = async (
    id: number,
    action: UsageLimitAction | null,
  ) => {
    setPolicyBusy(true);
    try {
      const c = await apiFetch<ClientCompany>(
        `/super-admin/clients/${id}/usage-limit-action`,
        { method: 'PATCH', body: { action }, noOnboardingRedirect: true },
      );
      patchDetail(c);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.userMessage : 'Failed to update policy',
      );
    } finally {
      setPolicyBusy(false);
    }
  };

  const grantGrace = async (id: number, until: string | null) => {
    setPolicyBusy(true);
    try {
      const c = await apiFetch<ClientCompany>(
        `/super-admin/clients/${id}/grace`,
        { method: 'PATCH', body: { until }, noOnboardingRedirect: true },
      );
      patchDetail(c);
      setGraceDate('');
    } catch (e) {
      setError(
        e instanceof ApiError ? e.userMessage : 'Failed to set grace period',
      );
    } finally {
      setPolicyBusy(false);
    }
  };

  const openDetail = async (id: number) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const c = await apiFetch<ClientCompany>(
        `/super-admin/clients/${id}`,
        { noOnboardingRedirect: true },
      );
      setDetail(c);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(
        e instanceof ApiError ? e.userMessage : 'Failed to load client',
      );
    } finally {
      setDetailLoading(false);
    }
  };

  const impersonate = async (id: number) => {
    setActionBusy(true);
    try {
      const res = await apiFetch<{ impersonationToken: string }>(
        `/super-admin/impersonate/${id}`,
        { method: 'POST', noOnboardingRedirect: true },
      );
      // Hand the one-shot token to a fresh tenant tab. auth-context
      // consumes it on mount and bootstraps via /auth/me, so the
      // super-admin session in THIS tab stays intact.
      window.sessionStorage.setItem(
        'ca_impersonation_token',
        res.impersonationToken,
      );
      window.open('/dashboard', '_blank');
    } catch (e) {
      setError(
        e instanceof ApiError ? e.userMessage : 'Impersonation failed',
      );
    } finally {
      setActionBusy(false);
    }
  };

  const runDelete = async () => {
    if (!deleteId) return;
    setActionBusy(true);
    try {
      await apiFetch(`/super-admin/clients/${deleteId.id}`, {
        method: 'DELETE',
        noOnboardingRedirect: true,
      });
      setRows((cur) => cur.filter((r) => r.id !== deleteId.id));
      setDeleteId(null);
      setDetail(null);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.userMessage : 'Delete failed',
      );
    } finally {
      setActionBusy(false);
    }
  };

  // Initial filter from ?status= (read once, avoids useSearchParams/Suspense)
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
      setError(
        e instanceof ApiError ? e.userMessage : 'Failed to load clients',
      );
    } finally {
      setLoading(false);
    }
  }, [page, router]);

  useEffect(() => {
    load();
  }, [load]);

  // Server gives no search/status filter — filter the current page client-side.
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
    // Optimistic
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
      setRows(prev); // rollback
      setError(
        e instanceof ApiError ? e.userMessage : 'Action failed — rolled back',
      );
    } finally {
      setBusy(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <h2 className="text-xl font-bold mr-auto">Clients</h2>
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company on this page…"
            className="bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm w-full sm:w-64 focus:outline-none focus:ring-2 focus:ring-green-600"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              filter === f.key
                ? 'bg-green-600 text-white'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-900/40 border border-red-800 px-4 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-800 text-gray-400">
            <tr>
              <th className="text-left px-4 py-3 font-medium">ID</th>
              <th className="text-left px-4 py-3 font-medium">Company</th>
              <th className="text-left px-4 py-3 font-medium">Plan</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Created</th>
              <th className="text-right px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                  No clients match.
                </td>
              </tr>
            ) : (
              visible.map((c) => (
                <tr key={c.id} className="hover:bg-gray-800/50">
                  <td className="px-4 py-3 text-gray-500">{c.id}</td>
                  <td className="px-4 py-3 font-medium text-white">
                    {c.company_name}
                  </td>
                  <td className="px-4 py-3 text-gray-300 capitalize">
                    {c.subscription?.plan_name ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill status={c.activation_status} />
                  </td>
                  <td className="px-4 py-3 text-gray-400">
                    {fmtDate(c.created_at)}
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button
                      onClick={() => openDetail(c.id)}
                      className="rounded-lg border border-gray-700 hover:bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-200"
                    >
                      Details
                    </button>
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

      <div className="flex items-center justify-between mt-4 text-sm text-gray-400">
        <span>
          {total} total · page {page}/{totalPages}
        </span>
        <div className="flex gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="flex items-center gap-1 rounded-lg border border-gray-700 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-800"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="flex items-center gap-1 rounded-lg border border-gray-700 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-800"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirm}
        title={
          confirm?.action === 'suspend'
            ? 'Suspend client'
            : 'Activate client'
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

      <Modal
        open={detailLoading || !!detail}
        onClose={() => setDetail(null)}
        title={detail ? detail.company_name : 'Client'}
        size="lg"
        footer={
          detail && (
            <div className="flex justify-between gap-2">
              <button
                onClick={() => setDeleteId({ id: detail.id, name: detail.company_name })}
                disabled={actionBusy}
                className="flex items-center gap-1.5 rounded-lg bg-red-700 hover:bg-red-800 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                <Trash2 size={15} /> Delete client
              </button>
              <button
                onClick={() => impersonate(detail.id)}
                disabled={actionBusy}
                className="flex items-center gap-1.5 rounded-lg bg-green-600 hover:bg-green-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                <LogIn size={15} /> Impersonate owner
              </button>
            </div>
          )
        }
      >
        {detailLoading || !detail ? (
          <p className="text-sm text-gray-500 py-6 text-center">Loading…</p>
        ) : (
          <div className="space-y-5 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-gray-500 text-xs">Status</span>
                <div className="mt-0.5">
                  <StatusPill status={detail.activation_status} />
                </div>
              </div>
              <div>
                <span className="text-gray-500 text-xs">Created</span>
                <div className="mt-0.5 text-gray-700">
                  {fmtDate(detail.created_at)}
                </div>
              </div>
              <div>
                <span className="text-gray-500 text-xs">Plan</span>
                <div className="mt-0.5 text-gray-700 capitalize">
                  {detail.subscription?.plan_name ?? '—'}
                </div>
              </div>
              <div>
                <span className="text-gray-500 text-xs">Monthly price</span>
                <div className="mt-0.5 text-gray-700">
                  {detail.subscription
                    ? `$${detail.subscription.monthly_price}`
                    : '—'}
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 p-4 space-y-4">
              <h4 className="text-xs font-semibold text-gray-500 uppercase">
                Billing &amp; limits
              </h4>

              <div className="grid grid-cols-3 gap-3 text-xs">
                <div>
                  <span className="text-gray-500">Activated</span>
                  <div className="mt-0.5 text-gray-700">
                    {detail.activated_at
                      ? fmtDate(detail.activated_at)
                      : '— (not yet)'}
                  </div>
                </div>
                <div>
                  <span className="text-gray-500">Auto-suspended</span>
                  <div className="mt-0.5 text-gray-700">
                    {detail.suspended_at
                      ? fmtDate(detail.suspended_at)
                      : '—'}
                  </div>
                </div>
                <div>
                  <span className="text-gray-500">Grace until</span>
                  <div className="mt-0.5 text-gray-700">
                    {detail.grace_until
                      ? fmtDate(detail.grace_until)
                      : '—'}
                  </div>
                </div>
              </div>

              <div>
                <span className="text-gray-500 text-xs">
                  Usage-limit action
                </span>
                <div className="mt-1 flex items-center gap-2">
                  <select
                    value={detail.usage_limit_action ?? ''}
                    disabled={policyBusy}
                    onChange={(e) =>
                      setUsagePolicy(
                        detail.id,
                        e.target.value === ''
                          ? null
                          : (e.target.value as UsageLimitAction),
                      )
                    }
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm bg-white text-gray-800"
                  >
                    <option value="">Platform default</option>
                    <option value="block">Block (hard limit)</option>
                    <option value="warn_only">Warn only (soft)</option>
                  </select>
                  <span className="text-xs text-gray-400">
                    Override beats the platform default.
                  </span>
                </div>
              </div>

              <div>
                <span className="text-gray-500 text-xs">
                  Grant extra time (skip auto-suspend until)
                </span>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <input
                    type="date"
                    value={graceDate}
                    disabled={policyBusy}
                    onChange={(e) => setGraceDate(e.target.value)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm bg-white text-gray-800"
                  />
                  <button
                    onClick={() =>
                      graceDate &&
                      grantGrace(
                        detail.id,
                        new Date(graceDate + 'T23:59:59').toISOString(),
                      )
                    }
                    disabled={policyBusy || !graceDate}
                    className="rounded-lg bg-green-600 hover:bg-green-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Grant
                  </button>
                  {detail.grace_until && (
                    <button
                      onClick={() => grantGrace(detail.id, null)}
                      disabled={policyBusy}
                      className="rounded-lg border border-gray-300 hover:bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-50"
                    >
                      Clear grace
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">
                Users ({detail.users?.length ?? 0})
              </h4>
              <div className="rounded-lg border border-gray-200 overflow-hidden">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-xs">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Name</th>
                      <th className="text-left px-3 py-2 font-medium">Email</th>
                      <th className="text-left px-3 py-2 font-medium">Role</th>
                      <th className="text-left px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {(detail.users ?? []).map((u) => (
                      <tr key={u.id}>
                        <td className="px-3 py-2 text-gray-800">{u.name}</td>
                        <td className="px-3 py-2 text-gray-600">{u.email}</td>
                        <td className="px-3 py-2 text-gray-600 capitalize">
                          {u.role}
                        </td>
                        <td className="px-3 py-2 text-gray-600 capitalize">
                          {u.status}
                        </td>
                      </tr>
                    ))}
                    {(detail.users ?? []).length === 0 && (
                      <tr>
                        <td
                          colSpan={4}
                          className="px-3 py-4 text-center text-gray-400"
                        >
                          No users.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteId}
        title="Delete client permanently"
        message={`Permanently delete "${deleteId?.name}" and ALL of its data — contacts, conversations, messages, templates, bots, broadcasts, invoices, users. This cannot be undone.`}
        confirmLabel="Delete everything"
        danger
        busy={actionBusy}
        onConfirm={runDelete}
        onCancel={() => !actionBusy && setDeleteId(null)}
      />
    </div>
  );
}
