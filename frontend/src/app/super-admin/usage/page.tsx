'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import type { AdminUsageRow } from '@/lib/crm-types';
import { SaCard, SaPageHeader, SaSpinner } from '../_components/sa-ui';

export const dynamic = 'force-dynamic';

function Cell({ value, limit }: { value: number; limit?: number | null }) {
  const over = typeof limit === 'number' && limit > 0 && value >= limit;
  const near = !over && typeof limit === 'number' && limit > 0 && value >= limit * 0.8;
  const pct = typeof limit === 'number' && limit > 0 ? Math.min(100, Math.round((value / limit) * 100)) : null;
  const color = over ? 'var(--sa-crit)' : near ? 'var(--sa-warn)' : 'var(--sa-good)';
  return (
    <td className="n">
      <div style={{ fontWeight: 600, color: over || near ? color : 'var(--sa-fg)' }}>
        {value.toLocaleString()}
        {typeof limit === 'number' && limit > 0 && (
          <span className="sa-faint" style={{ fontWeight: 400 }}> / {limit.toLocaleString()}</span>
        )}
      </div>
      {pct !== null && (
        <div style={{ marginTop: 4, height: 4, width: '100%', background: 'var(--sa-surface-2)', borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: 999, width: `${pct}%`, background: color }} />
        </div>
      )}
    </td>
  );
}

export default function SuperAdminUsagePage() {
  const router = useRouter();
  const [rows, setRows] = useState<AdminUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const period = rows[0]?.period ?? new Date().toISOString().slice(0, 7);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<AdminUsageRow[]>('/super-admin/usage', { noOnboardingRedirect: true });
      setRows(data);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load usage');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="sa-content">
      <SaPageHeader
        title="Platform usage"
        subtitle="Per-tenant metering for the current calendar month. Amber ≥ 80%, red at/over limit."
        actions={
          <span className="sa-btn" style={{ cursor: 'default' }}>
            Period: <b className="sa-mono" style={{ marginLeft: 4 }}>{period}</b>
          </span>
        }
      />

      {error && <div className="sa-alert-error">{error}</div>}

      <SaCard bodyClassName="">
        <div className="sa-table-wrap">
          <table className="sa-table" style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th>Company</th><th>Plan</th>
                <th className="n">Messages</th><th className="n">Contacts</th>
                <th className="n">Templates</th><th className="n">Webhooks</th>
                <th className="n">Convos</th><th className="n">AI calls</th><th className="n">AI billed</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9}><SaSpinner /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={9} className="sa-faint" style={{ textAlign: 'center', padding: 40 }}>No usage recorded for this period yet.</td></tr>
              ) : (
                rows.map((r) => {
                  const sub = r.company?.subscription ?? null;
                  const aiBilled = r.ai_billed_cents ?? 0;
                  return (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>{r.company?.company_name ?? `Company ${r.company_id}`}</td>
                      <td><span className="sa-pill info" style={{ textTransform: 'capitalize' }}>{sub?.plan_name ?? '—'}</span></td>
                      <td className="n">{r.messages_sent.toLocaleString()}</td>
                      <Cell value={r.contacts_stored} limit={sub?.contact_limit} />
                      <Cell value={r.templates_used} limit={sub?.template_limit} />
                      <td className="n">{r.webhook_calls.toLocaleString()}</td>
                      <td className="n">{r.conversations_opened.toLocaleString()}</td>
                      <td className="n">{(r.ai_requests ?? 0).toLocaleString()}</td>
                      <td
                        className="n"
                        style={{ fontWeight: 600, color: aiBilled > 0 ? 'var(--sa-accent-ink)' : 'var(--sa-fg-faint)' }}
                        title={`Raw provider cost: $${((r.ai_cost_micros ?? 0) / 1_000_000).toFixed(4)}`}
                      >
                        ${(aiBilled / 100).toFixed(2)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </SaCard>
    </div>
  );
}
