'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';
import { SaCard, SaPageHeader, SaSpinner } from '../_components/sa-ui';

export const dynamic = 'force-dynamic';

interface PlanRequestRow {
  id: number;
  status: string;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
  requestedPlanName: string | null;
  currentPlanName: string | null;
  company: { id: number; company_name: string } | null;
}

const FILTERS = ['pending', 'approved', 'rejected', ''] as const;
const STATUS_CLS: Record<string, string> = { pending: 'warn', approved: 'good', rejected: 'slate' };

export default function SuperAdminPlanRequestsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<PlanRequestRow[]>([]);
  const [status, setStatus] = useState<(typeof FILTERS)[number]>('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch<PlanRequestRow[]>('/super-admin/plan-requests', {
        params: { status: status || undefined },
        noOnboardingRedirect: true,
      });
      setRows(Array.isArray(res) ? res : []);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load requests');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const resolve = async (id: number, action: 'approve' | 'reject') => {
    setBusy(id);
    try {
      await apiFetch(`/super-admin/plan-requests/${id}`, { method: 'PATCH', body: { action }, noOnboardingRedirect: true });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Failed to update request');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="sa-content">
      <SaPageHeader title="Upgrade requests" subtitle="Tenant-initiated plan changes awaiting review." />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button key={f || 'all'} onClick={() => setStatus(f)}
            className={status === f ? 'sa-btn primary' : 'sa-btn'}
            style={{ borderRadius: 999, fontSize: 12.5, padding: '6px 13px', textTransform: 'capitalize' }}>
            {f || 'all'}
          </button>
        ))}
      </div>

      {error && <div className="sa-alert-error">{error}</div>}

      <SaCard bodyClassName="">
        {loading ? (
          <SaSpinner />
        ) : rows.length === 0 ? (
          <div className="sa-faint" style={{ padding: 40, textAlign: 'center' }}>No requests.</div>
        ) : (
          <div className="sa-table-wrap">
            <table className="sa-table" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>Company</th><th>Current → Requested</th><th>Note</th>
                  <th>Requested</th><th>Status</th><th className="n">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.company?.company_name ?? `#${r.id}`}</td>
                    <td className="sa-muted" style={{ textTransform: 'capitalize' }}>
                      {r.currentPlanName ?? '—'} → <b>{r.requestedPlanName ?? '(discuss)'}</b>
                    </td>
                    <td className="sa-faint" style={{ maxWidth: '22ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.note || '—'}</td>
                    <td className="sa-muted">{fmtDateTime(r.created_at)}</td>
                    <td><span className={`sa-pill ${STATUS_CLS[r.status] ?? 'slate'}`} style={{ textTransform: 'capitalize' }}>{r.status}</span></td>
                    <td className="n">
                      {r.status === 'pending' ? (
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          <button className="sa-btn primary" style={{ padding: '5px 10px', fontSize: 12 }}
                            disabled={busy === r.id} onClick={() => resolve(r.id, 'approve')}>
                            <Check size={13} /> Approve
                          </button>
                          <button className="sa-btn" style={{ padding: '5px 10px', fontSize: 12 }}
                            disabled={busy === r.id} onClick={() => resolve(r.id, 'reject')}>
                            <X size={13} /> Reject
                          </button>
                        </div>
                      ) : (
                        <span className="sa-faint" style={{ fontSize: 12 }}>{r.resolved_at ? fmtDateTime(r.resolved_at) : '—'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SaCard>
    </div>
  );
}
