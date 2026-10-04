'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Users,
  CheckCircle2,
  DollarSign,
  AlertCircle,
  MessageSquare,
  Sparkles,
  UserPlus,
  ChevronRight,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/utils';
import {
  SaCard,
  SaTile,
  SaStatusPill,
  SaAvatar,
  SaSpinner,
  SaPageHeader,
} from '../_components/sa-ui';

interface Dashboard {
  kpis: {
    totalClients: number;
    activeClients: number;
    pendingClients: number;
    suspendedClients: number;
    totalUsers: number;
    mrrUsd: number;
    invoicedThisMonthUsd: number;
    paidThisMonthUsd: number;
    outstandingUsd: number;
    newSignupsThisMonth: number;
    activeConversationsToday: number;
    aiSpendThisMonthUsd: number;
    tenantsOnAi: number;
  };
  signups90d: Array<{ date: string; count: number }>;
  convoVolume7d: Array<{ date: string; count: number }>;
  tenants: Array<{
    id: number;
    name: string;
    status: string;
    graceUntil: string | null;
    plan: string | null;
    monthlyPriceUsd: number;
    users: number;
    convosToday: number;
    outstandingUsd: number;
  }>;
  pendingApprovals: Array<{
    id: number;
    name: string;
    createdAt: string;
    ownerName: string | null;
    ownerEmail: string | null;
  }>;
  overdueInvoices: Array<{
    id: number;
    invoiceNumber: string | null;
    companyId: number;
    companyName: string;
    amount: number;
    dueDate: string;
    daysOverdue: number;
  }>;
  recentActivity: Array<{
    id: number;
    action: string;
    entity: string;
    entityId: number | null;
    createdAt: string;
    userName: string | null;
    userEmail: string | null;
  }>;
}

const usd = (v: number) => `$${Math.round(v).toLocaleString()}`;

export default function SuperAdminDashboard() {
  const router = useRouter();
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await apiFetch<Dashboard>('/super-admin/dashboard', {
        noOnboardingRedirect: true,
        timeout: 30000,
      });
      setData(d);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(
        e instanceof ApiError
          ? e.userMessage
          : 'Failed to load the dashboard (the request timed out). Please retry.',
      );
    } finally {
      setLoading(false);
    }
    // `router` omitted — unstable identity in Next 14 (see ERRORS.md).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Signups area chart path (zero-filled 90-day series).
  const signupPath = useMemo(() => {
    if (!data) return null;
    const m = new Map(
      data.signups90d.map((r) => [r.date.slice(0, 10), r.count]),
    );
    const today = new Date();
    const pts: number[] = [];
    for (let i = 89; i >= 0; i--) {
      const dt = new Date(today.getTime() - i * 86_400_000);
      pts.push(m.get(dt.toISOString().slice(0, 10)) ?? 0);
    }
    const W = 320;
    const H = 110;
    const max = Math.max(1, ...pts);
    const x = (i: number) => (i / (pts.length - 1)) * W;
    const y = (v: number) => 100 - (v / max) * 82;
    const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = `${line} L${W},${H} L0,${H} Z`;
    return { line, area, last: { x: W, y: y(pts[pts.length - 1]) } };
  }, [data]);

  const volMax = useMemo(
    () => (data ? Math.max(1, ...data.convoVolume7d.map((d) => d.count)) : 1),
    [data],
  );

  if (loading && !data) {
    return (
      <div className="sa-content">
        <SaSpinner />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="sa-content">
        <div className="sa-card" style={{ padding: 24, textAlign: 'center', maxWidth: 420, margin: '40px auto' }}>
          <p style={{ color: 'var(--sa-crit)', fontWeight: 600, fontSize: 14 }}>{error}</p>
          <button className="sa-btn primary" style={{ marginTop: 16 }} onClick={() => load()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!data) return null;
  const k = data.kpis;
  const attention = k.pendingClients + k.suspendedClients + data.overdueInvoices.length;

  return (
    <div className="sa-content">
      <SaPageHeader
        title="Platform overview"
        subtitle={`${k.totalClients} tenants · apps.codentra.pk`}
        actions={
          <div className="sa-seg" role="group" aria-label="Range">
            <button>7d</button>
            <button className="on">30d</button>
            <button>90d</button>
          </div>
        }
      />

      {/* KPI row */}
      <section className="sa-kpis">
        <SaTile
          label="Active tenants"
          value={<>{k.activeClients}<small> / {k.totalClients}</small></>}
          icon={CheckCircle2}
          tone="green"
          foot={<span className="sa-faint">{k.pendingClients} pending · {k.suspendedClients} suspended</span>}
        />
        <SaTile label="MRR" value={usd(k.mrrUsd)} icon={DollarSign} tone="green"
          foot={<span className="sa-faint">{k.totalUsers} users across tenants</span>} />
        <SaTile
          label="Outstanding"
          value={usd(k.outstandingUsd)}
          icon={AlertCircle}
          tone={k.outstandingUsd > 0 ? 'red' : 'slate'}
          href="/super-admin/billing"
          foot={<span className={k.outstandingUsd > 0 ? 'sa-delta-down' : 'sa-faint'}>{data.overdueInvoices.length} overdue</span>}
        />
        <SaTile label="Conversations today" value={k.activeConversationsToday.toLocaleString()} icon={MessageSquare} tone="info"
          foot={<span className="sa-faint">platform-wide</span>} />
        <SaTile label="AI spend (mo)" value={usd(k.aiSpendThisMonthUsd)} icon={Sparkles} tone="green"
          foot={<span className="sa-faint">{k.tenantsOnAi} tenants on AI</span>} href="/super-admin/usage" />
        <SaTile label="New signups (mo)" value={k.newSignupsThisMonth.toLocaleString()} icon={UserPlus} tone="info"
          foot={<span className="sa-faint">{attention} items need attention</span>} />
      </section>

      {/* Cross-tenant table + status / signups */}
      <div className="sa-grid-2">
        <SaCard
          title="Tenants by activity"
          chip={<Link href="/super-admin/clients" className="chip">View all {k.totalClients} →</Link>}
          bodyClassName=""
        >
          <div className="sa-table-wrap">
            <table className="sa-table" style={{ minWidth: 620 }}>
              <thead>
                <tr>
                  <th>Tenant</th><th>Plan</th><th>Status</th>
                  <th className="n">Users</th><th className="n">Convos&nbsp;today</th>
                  <th className="n">MRR</th><th className="n">Owes</th>
                </tr>
              </thead>
              <tbody>
                {data.tenants.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32 }} className="sa-faint">No tenants yet.</td></tr>
                ) : (
                  data.tenants.map((t) => (
                    <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/super-admin/clients/${t.id}`)}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <SaAvatar label={t.name} />
                          <span style={{ fontWeight: 600 }}>{t.name}</span>
                        </div>
                      </td>
                      <td className="sa-muted">{t.plan ?? '—'}</td>
                      <td><SaStatusPill status={t.status} graceUntil={t.graceUntil} /></td>
                      <td className="n">{t.users}</td>
                      <td className="n">{t.convosToday.toLocaleString()}</td>
                      <td className="n">{usd(t.monthlyPriceUsd)}</td>
                      <td className="n" style={{ color: t.outstandingUsd > 0 ? 'var(--sa-crit)' : 'var(--sa-fg-faint)', fontWeight: t.outstandingUsd > 0 ? 600 : 400 }}>
                        {t.outstandingUsd > 0 ? usd(t.outstandingUsd) : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </SaCard>

        <SaCard title="Tenant status" right={`${k.totalClients} total`}>
          <div className="sa-statusbar">
            <Seg v={k.activeClients} total={k.totalClients} color="var(--sa-good)" />
            <Seg v={k.pendingClients} total={k.totalClients} color="var(--sa-warn)" />
            <Seg v={k.suspendedClients} total={k.totalClients} color="var(--sa-crit)" />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 13, fontSize: 12 }} className="sa-muted">
            <Legend color="var(--sa-good)" label="Active" n={k.activeClients} />
            <Legend color="var(--sa-warn)" label="Pending" n={k.pendingClients} />
            <Legend color="var(--sa-crit)" label="Suspended" n={k.suspendedClients} />
          </div>
          <div style={{ height: 1, background: 'var(--sa-border)', margin: '16px 0' }} />
          <h3 style={{ fontSize: 12, color: 'var(--sa-fg-muted)', fontWeight: 600, margin: '0 0 10px' }}>Signups · last 90 days</h3>
          {signupPath && (
            <svg viewBox="0 0 320 110" width="100%" height="110" preserveAspectRatio="none" aria-label="Signups trend">
              <defs>
                <linearGradient id="sa-sg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--sa-accent)" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="var(--sa-accent)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <line className="sa-gridline" x1="0" y1="28" x2="320" y2="28" />
              <line className="sa-gridline" x1="0" y1="56" x2="320" y2="56" />
              <line className="sa-gridline" x1="0" y1="84" x2="320" y2="84" />
              <path d={signupPath.area} fill="url(#sa-sg)" />
              <path d={signupPath.line} fill="none" stroke="var(--sa-accent)" strokeWidth="2.5" strokeLinejoin="round" />
              <circle cx={signupPath.last.x} cy={signupPath.last.y} r="3.5" fill="var(--sa-accent)" />
            </svg>
          )}
        </SaCard>
      </div>

      {/* Volume + attention widgets */}
      <div className="sa-grid-3">
        <SaCard title="Active conversations" right="7 days">
          <div className="sa-vbars">
            {data.convoVolume7d.map((d) => (
              <div className="col" key={d.date}>
                <div className="bar" style={{ height: `${Math.max(4, (d.count / volMax) * 100)}%` }}>
                  <b>{d.count.toLocaleString()}</b>
                </div>
                <span className="cl">{new Date(d.date).toLocaleDateString(undefined, { weekday: 'short' })}</span>
              </div>
            ))}
          </div>
        </SaCard>

        <SaCard title="Pending approvals" right={`${k.pendingClients}`} bodyClassName="">
          {data.pendingApprovals.length === 0 ? (
            <div className="sa-card-body sa-faint" style={{ textAlign: 'center', padding: 24 }}>No pending clients.</div>
          ) : (
            <div className="sa-lw">
              {data.pendingApprovals.map((p) => (
                <div className="sa-lw-row" key={p.id}>
                  <SaAvatar label={p.name} size={32} />
                  <div className="sa-lw-meta">
                    <div className="t">{p.name}</div>
                    <div className="s">{p.ownerEmail ?? 'No owner email'} · {fmtDate(p.createdAt)}</div>
                  </div>
                  <Link href="/super-admin/clients?status=pending" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--sa-accent-ink)', display: 'flex', alignItems: 'center' }}>
                    Review <ChevronRight size={13} />
                  </Link>
                </div>
              ))}
            </div>
          )}
        </SaCard>

        <SaCard title="Overdue invoices" right={usd(k.outstandingUsd)} bodyClassName="">
          {data.overdueInvoices.length === 0 ? (
            <div className="sa-card-body sa-faint" style={{ textAlign: 'center', padding: 24 }}>Nothing overdue.</div>
          ) : (
            <div className="sa-lw">
              {data.overdueInvoices.map((i) => (
                <div className="sa-lw-row" key={i.id}>
                  <span className="sa-avatar" style={{ width: 32, height: 32, background: 'var(--sa-crit-wash)', color: 'var(--sa-crit)', fontSize: 11 }}>{i.daysOverdue}d</span>
                  <div className="sa-lw-meta">
                    <div className="t">{i.companyName}</div>
                    <div className="s">{i.invoiceNumber ?? `#${i.id}`} · due {fmtDate(i.dueDate)}</div>
                  </div>
                  <span style={{ fontWeight: 600, color: 'var(--sa-crit)', fontVariantNumeric: 'tabular-nums' }}>{usd(i.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </SaCard>
      </div>

      {/* Activity feed */}
      <SaCard title="Recent activity" right="Across all tenants · last 10" bodyClassName="">
        {data.recentActivity.length === 0 ? (
          <div className="sa-card-body sa-faint" style={{ textAlign: 'center', padding: 24 }}>Nothing yet.</div>
        ) : (
          <div className="sa-lw">
            {data.recentActivity.map((a) => (
              <div className="sa-lw-row" key={a.id} style={{ alignItems: 'flex-start' }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--sa-accent)', marginTop: 6, flex: 'none' }} />
                <div className="sa-lw-meta">
                  <div style={{ fontSize: 12.5 }}>
                    <b>{a.userName ?? 'system'}</b> · {a.action.replace(/_/g, ' ')}
                    {a.entity && <span className="sa-faint"> ({a.entity})</span>}
                  </div>
                </div>
                <span className="sa-faint" style={{ fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>
                  {new Date(a.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </SaCard>
    </div>
  );
}

function Seg({ v, total, color }: { v: number; total: number; color: string }) {
  const pct = total > 0 ? (v / total) * 100 : 0;
  if (pct <= 0) return null;
  return <span style={{ background: color, width: `${pct}%`, display: 'block' }} />;
}

function Legend({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <span>
      <i style={{ width: 9, height: 9, borderRadius: 3, display: 'inline-block', marginRight: 6, verticalAlign: 'middle', background: color }} />
      {label}
      <b style={{ color: 'var(--sa-fg)', marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>{n}</b>
    </span>
  );
}
