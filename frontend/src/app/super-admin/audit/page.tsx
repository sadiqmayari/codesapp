'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';
import type { AdminAuditLog, Paged } from '@/lib/crm-types';
import { SaCard, SaPageHeader, SaSpinner } from '../_components/sa-ui';

export const dynamic = 'force-dynamic';

const LIMIT = 50;

export default function SuperAdminAuditPage() {
  const router = useRouter();
  const [rows, setRows] = useState<AdminAuditLog[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch<Paged<AdminAuditLog>>('/super-admin/audit-logs', {
        params: { page, limit: LIMIT },
        noOnboardingRedirect: true,
      });
      setRows(res.items);
      setTotal(res.meta.total);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load audit logs');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(
      (r) =>
        r.action.toLowerCase().includes(s) ||
        r.entity.toLowerCase().includes(s) ||
        (r.user?.email ?? '').toLowerCase().includes(s),
    );
  }, [rows, q]);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="sa-content">
      <SaPageHeader
        title="Audit log"
        subtitle="Mutations recorded across the platform — immutable, append-only."
        actions={
          <div style={{ position: 'relative', minWidth: 260 }}>
            <Search size={16} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--sa-fg-faint)' }} />
            <input className="sa-input" style={{ paddingLeft: 34 }} value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Filter action / entity / user on this page…" />
          </div>
        }
      />

      {error && <div className="sa-alert-error">{error}</div>}

      <SaCard bodyClassName="">
        <div className="sa-table-wrap">
          <table className="sa-table" style={{ minWidth: 820 }}>
            <thead>
              <tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>IP</th><th>Metadata</th></tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6}><SaSpinner /></td></tr>
              ) : visible.length === 0 ? (
                <tr><td colSpan={6} className="sa-faint" style={{ textAlign: 'center', padding: 40 }}>No audit entries match.</td></tr>
              ) : (
                visible.map((r) => (
                  <tr key={r.id} style={{ verticalAlign: 'top' }}>
                    <td className="sa-faint" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDateTime(r.created_at)}</td>
                    <td>
                      {r.user ? (
                        <>
                          <div style={{ fontWeight: 600 }}>{r.user.name}</div>
                          <div className="sub">{r.user.email}</div>
                        </>
                      ) : r.user_id == null ? (
                        <span className="sa-pill info">System / bot</span>
                      ) : (
                        <span className="sa-faint" style={{ fontSize: 12, fontStyle: 'italic' }}>(deleted user #{r.user_id})</span>
                      )}
                    </td>
                    <td>
                      <code className="sa-pill" style={{ background: 'var(--sa-accent-wash)', color: 'var(--sa-accent-ink)', fontFamily: 'var(--num, monospace)', fontSize: 11.5 }}>{r.action}</code>
                    </td>
                    <td className="sa-muted">
                      {r.entity}
                      {r.entity_id != null && <span className="sa-faint"> #{r.entity_id}</span>}
                    </td>
                    <td className="sa-faint sa-mono" style={{ fontSize: 12 }}>{r.ip_address ?? '—'}</td>
                    <td className="sa-faint" style={{ maxWidth: 260 }}>
                      {r.metadata ? (
                        <code style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, background: 'var(--sa-surface-2)', border: '1px solid var(--sa-border)', borderRadius: 5, padding: '1px 7px' }}>
                          {JSON.stringify(r.metadata)}
                        </code>
                      ) : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </SaCard>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }} className="sa-muted">
        <span>{total} total · page {page}/{totalPages}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="sa-btn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            <ChevronLeft size={14} /> Prev
          </button>
          <button className="sa-btn" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
