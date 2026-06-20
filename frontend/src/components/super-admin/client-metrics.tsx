'use client';

import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Loader2 } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';

/**
 * Super-admin hardening observability snapshot (#increment 11). Renders
 * GET /super-admin/clients/:id/metrics — the same ObservabilityService snapshot
 * the tenant /api/ai/metrics returns, so the flags' impact is visible next to the
 * toggles. Read-only; metrics accumulate from the event log post-enablement.
 */

interface TenantMetrics {
  windowDays: number;
  conversations: number;
  handoffs: number;
  handoffRate: number;
  ordersCreated: number;
  orderConversionRate: number;
  duplicateOrdersPrevented: number;
  ticketsCreated: number;
  frustrationEscalations: number;
  fraudEscalations: number;
  medicalInterventions: number;
  specialistDisabled: number;
  toolFailures: number;
  toolFailureRate: number;
}

const WINDOWS = [7, 30, 90];
const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

export function ClientMetrics({ clientId }: { clientId: number }) {
  const [days, setDays] = useState(30);
  const [m, setM] = useState<TenantMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<TenantMetrics>(
        `/super-admin/clients/${clientId}/metrics`,
        { params: { days } },
      );
      setM(res);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load metrics');
    } finally {
      setLoading(false);
    }
  }, [clientId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-indigo-600" />
          <h3 className="text-sm font-semibold text-gray-900">
            Hardening metrics
          </h3>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
        </div>
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setDays(w)}
              className={
                'px-2.5 py-1 border-l first:border-l-0 border-gray-200 transition-colors ' +
                (days === w
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50')
              }
            >
              {w}d
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        From the append-only event log over the last {m?.windowDays ?? days} days.
        Counts accrue only after the relevant flags are enabled.
      </p>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {m && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <Metric label="Conversations" value={m.conversations} />
          <Metric label="Handoff rate" value={pct(m.handoffRate)} sub={`${m.handoffs} handoffs`} />
          <Metric
            label="Order conversion"
            value={pct(m.orderConversionRate)}
            sub={`${m.ordersCreated} orders`}
          />
          <Metric
            label="Dup. orders prevented"
            value={m.duplicateOrdersPrevented}
            tone={m.duplicateOrdersPrevented > 0 ? 'good' : 'neutral'}
          />
          <Metric label="Tickets created" value={m.ticketsCreated} />
          <Metric
            label="Frustration escalations"
            value={m.frustrationEscalations}
            tone={m.frustrationEscalations > 0 ? 'warn' : 'neutral'}
          />
          <Metric
            label="Fraud escalations"
            value={m.fraudEscalations}
            tone={m.fraudEscalations > 0 ? 'warn' : 'neutral'}
          />
          <Metric
            label="Medical interventions"
            value={m.medicalInterventions}
            tone={m.medicalInterventions > 0 ? 'warn' : 'neutral'}
          />
          <Metric label="Specialist killed" value={m.specialistDisabled} />
          <Metric
            label="Tool failures"
            value={m.toolFailures}
            sub={pct(m.toolFailureRate)}
            tone={m.toolFailures > 0 ? 'warn' : 'neutral'}
          />
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'neutral' | 'good' | 'warn';
}) {
  const color =
    tone === 'good'
      ? 'text-emerald-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : 'text-gray-900';
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2.5">
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
      <div className="text-[11px] text-gray-500 leading-tight">{label}</div>
      {sub && <div className="text-[10px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}
