'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useDebouncedValue } from '@/lib/use-list-query';
import { ConfirmDialog } from '@/components/ui/modal';
import { fmtDate } from '@/lib/utils';
import type { ActivationStatus, ClientCompany, Paged } from '@/lib/crm-types';
import { SaCard, SaAvatar, SaPageHeader, SaStatusPill, SaSpinner } from '../_components/sa-ui';

export const dynamic = 'force-dynamic';

const FILTERS: Array<{ key: ActivationStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'active', label: 'Active' },
  { key: 'suspended', label: 'Suspended' },
];

const LIMIT = 20;

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

  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('status');
    if (s === 'pending' || s === 'active' || s === 'suspended') setFilter(s);
  }, []);

  // Server-side status + search (search & filter conventions). It used to
  // filter the current 20 rows client-side, so "Pending 3" meant "3 on this
  // page". Debounced, stale responses dropped, page reset on change.
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const [statusCounts, setStatusCounts] = useState<Record<string, number> | null>(null);
  const seqRef = useRef(0);
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, filter]);
  const load = useCallback(async () => {
    const my = ++seqRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch<
        Paged<ClientCompany> & { meta: { statusCounts?: Record<string, number> } }
      >('/super-admin/clients', {
        params: {
          page,
          limit: LIMIT,
          q: debouncedSearch || undefined,
          status: filter === 'all' ? undefined : filter,
        },
        noOnboardingRedirect: true,
      });
      if (my !== seqRef.current) return;
      setRows(res.items);
      setTotal(res.meta.total);
      setStatusCounts(res.meta.statusCounts ?? null);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load clients');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedSearch, filter]);

  useEffect(() => {
    load();
  }, [load]);

  // Rows are already filtered server-side. After an optimistic activate /
  // suspend, hide a row that no longer matches the active status tab.
  const visible = useMemo(
    () => rows.filter((r) => filter === 'all' || r.activation_status === filter),
    [rows, filter],
  );

  const runAction = async () => {
    if (!confirm) return;
    const { id, action } = confirm;
    const nextStatus: ActivationStatus = action === 'activate' ? 'active' : 'suspended';
    const prev = rows;
    setBusy(true);
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, activation_status: nextStatus } : r)));
    try {
      await apiFetch(`/super-admin/clients/${id}/${action}`, { method: 'PATCH', noOnboardingRedirect: true });
      setConfirm(null);
    } catch (e) {
      setRows(prev);
      setError(e instanceof ApiError ? e.userMessage : 'Action failed — rolled back');
    } finally {
      setBusy(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  // True global totals (server, search applied) — not "on this page".
  const counts = useMemo(
    () => ({
      all: statusCounts?.all ?? total,
      pending: statusCounts?.pending ?? 0,
      active: statusCounts?.active ?? 0,
      suspended: statusCounts?.suspended ?? 0,
    }),
    [statusCounts, total],
  );

  return (
    <div className="sa-content">
      <SaPageHeader
        title="Clients"
        subtitle={`${total.toLocaleString()} total · page ${page}/${totalPages}`}
        actions={
          <div style={{ position: 'relative', minWidth: 240 }}>
            <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--sa-fg-faint)' }} />
            <input
              className="sa-input"
              style={{ paddingLeft: 34 }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search company, #id or owner email…"
            />
          </div>
        }
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {FILTERS.map((f) => {
          const c = f.key === 'all' ? counts.all : counts[f.key as 'pending' | 'active' | 'suspended'] ?? 0;
          const on = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={on ? 'sa-btn primary' : 'sa-btn'}
              style={{ borderRadius: 999, fontSize: 12.5, padding: '6px 13px' }}
            >
              {f.label}
              <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.85 }}>{c}</span>
            </button>
          );
        })}
      </div>

      {error && <div className="sa-alert-error">{error}</div>}

      <SaCard bodyClassName="">
        <div className="sa-table-wrap">
          <table className="sa-table" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Company</th><th>Plan</th><th className="n">MRR</th>
                <th>Status</th><th>Created</th><th className="n">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6}><SaSpinner /></td></tr>
              ) : visible.length === 0 ? (
                <tr><td colSpan={6} className="sa-faint" style={{ textAlign: 'center', padding: 40 }}>{search.trim() ? `No clients match “${search.trim()}”.` : 'No clients match.'}</td></tr>
              ) : (
                visible.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <SaAvatar label={c.company_name} />
                        <span>
                          <span style={{ fontWeight: 600, display: 'block' }}>{c.company_name}</span>
                          <span className="sub">#{c.id}</span>
                        </span>
                      </div>
                    </td>
                    <td className="sa-muted" style={{ textTransform: 'capitalize' }}>{c.subscription?.plan_name ?? '—'}</td>
                    <td className="n">{c.subscription ? `$${Number(c.subscription.monthly_price).toLocaleString()}` : '—'}</td>
                    <td><SaStatusPill status={c.activation_status} /></td>
                    <td className="sa-muted">{fmtDate(c.created_at)}</td>
                    <td className="n">
                      <div style={{ display: 'inline-flex', gap: 8, justifyContent: 'flex-end' }}>
                        <Link href={`/super-admin/clients/${c.id}`} className="sa-btn" style={{ padding: '6px 11px', fontSize: 12 }}>
                          View profile
                        </Link>
                        {c.activation_status === 'pending' && (
                          <button className="sa-btn primary" style={{ padding: '6px 11px', fontSize: 12 }}
                            onClick={() => setConfirm({ id: c.id, action: 'activate', name: c.company_name })}>
                            Activate
                          </button>
                        )}
                        {c.activation_status === 'active' && (
                          <button className="sa-btn" style={{ padding: '6px 11px', fontSize: 12, background: 'var(--sa-crit)', borderColor: 'var(--sa-crit)', color: '#fff' }}
                            onClick={() => setConfirm({ id: c.id, action: 'suspend', name: c.company_name })}>
                            Suspend
                          </button>
                        )}
                        {c.activation_status === 'suspended' && (
                          <button className="sa-btn primary" style={{ padding: '6px 11px', fontSize: 12 }}
                            onClick={() => setConfirm({ id: c.id, action: 'activate', name: c.company_name })}>
                            Reactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--sa-border)', padding: '12px 16px', fontSize: 13 }} className="sa-muted">
          <span>Showing {visible.length} of {total.toLocaleString()}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="sa-btn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <ChevronLeft size={14} /> Prev
            </button>
            <button className="sa-btn" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              Next <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </SaCard>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.action === 'suspend' ? 'Suspend client' : 'Activate client'}
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
    </div>
  );
}
