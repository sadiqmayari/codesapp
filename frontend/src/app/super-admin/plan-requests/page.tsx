'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpCircle, Check, X } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';

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

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-gray-200 text-gray-600',
};

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
      await apiFetch(`/super-admin/plan-requests/${id}`, {
        method: 'PATCH',
        body: { action },
        noOnboardingRedirect: true,
      });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Failed to update request');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-5">
        <ArrowUpCircle className="text-green-600" size={22} />
        <h1 className="text-xl font-semibold text-gray-900">Upgrade requests</h1>
      </div>

      <div className="flex gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f || 'all'}
            onClick={() => setStatus(f)}
            className={`px-3 py-1.5 rounded-full text-sm border capitalize transition-colors ${
              status === f
                ? 'bg-green-600 text-white border-green-600'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
            }`}
          >
            {f || 'all'}
          </button>
        ))}
      </div>

      {error && (
        <p className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-gray-400 text-sm">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-gray-400 text-sm">
            No requests.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="px-4 py-3 font-medium">Company</th>
                  <th className="px-4 py-3 font-medium">Current → Requested</th>
                  <th className="px-4 py-3 font-medium">Note</th>
                  <th className="px-4 py-3 font-medium">Requested</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {r.company?.company_name ?? `#${r.id}`}
                    </td>
                    <td className="px-4 py-3 text-gray-700 capitalize">
                      {r.currentPlanName ?? '—'} →{' '}
                      <span className="font-medium">
                        {r.requestedPlanName ?? '(discuss)'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 max-w-[22ch] truncate">
                      {r.note || '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {fmtDateTime(r.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
                          STATUS_STYLE[r.status] ?? 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.status === 'pending' ? (
                        <div className="inline-flex gap-1.5">
                          <button
                            disabled={busy === r.id}
                            onClick={() => resolve(r.id, 'approve')}
                            title="Approve & switch plan"
                            className="inline-flex items-center gap-1 text-xs bg-green-600 text-white rounded-lg px-2.5 py-1 disabled:opacity-50"
                          >
                            <Check size={13} /> Approve
                          </button>
                          <button
                            disabled={busy === r.id}
                            onClick={() => resolve(r.id, 'reject')}
                            className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-700 rounded-lg px-2.5 py-1 disabled:opacity-50"
                          >
                            <X size={13} /> Reject
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">
                          {r.resolved_at ? fmtDateTime(r.resolved_at) : '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
