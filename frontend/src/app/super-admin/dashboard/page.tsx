'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import type { LucideIcon } from 'lucide-react';
import {
  Users,
  CheckCircle2,
  Clock,
  Ban,
  DollarSign,
  Receipt,
  CircleDollarSign,
  AlertCircle,
  UserPlus,
  MessageSquare,
  ChevronRight,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { fmtDate } from '@/lib/utils';

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
  };
  signups90d: Array<{ date: string; count: number }>;
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

export default function SuperAdminDashboard() {
  const router = useRouter();
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<Dashboard>('/super-admin/dashboard', {
      noOnboardingRedirect: true,
    })
      .then(setData)
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          router.replace('/super-admin/login');
        }
      })
      .finally(() => setLoading(false));
  }, [router]);

  // Build a zero-filled 90-day series for the area chart so gaps don't make
  // the line jump unnaturally.
  const trend = useMemo(() => {
    if (!data) return [];
    const m = new Map(data.signups90d.map((r) => [r.date.slice(0, 10), r.count]));
    const out: Array<{ date: string; count: number }> = [];
    const today = new Date();
    for (let i = 89; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      out.push({ date: key, count: m.get(key) ?? 0 });
    }
    return out;
  }, [data]);

  if (loading && !data) {
    return (
      <div className="p-10 flex justify-center">
        <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!data) return null;
  const k = data.kpis;

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Overview</h1>
        <p className="text-sm text-gray-500 mt-0.5">Platform health at a glance</p>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Tile
          label="Total clients"
          value={k.totalClients.toLocaleString()}
          icon={Users}
          tone="slate"
        />
        <Tile
          label="Active"
          value={k.activeClients.toLocaleString()}
          icon={CheckCircle2}
          tone="green"
        />
        <Tile
          label="Pending"
          value={k.pendingClients.toLocaleString()}
          icon={Clock}
          tone="amber"
          href="/super-admin/clients?status=pending"
        />
        <Tile
          label="Suspended"
          value={k.suspendedClients.toLocaleString()}
          icon={Ban}
          tone="red"
          href="/super-admin/clients?status=suspended"
        />
        <Tile
          label="Total users"
          value={k.totalUsers.toLocaleString()}
          icon={Users}
          tone="slate"
        />
        <Tile
          label="MRR"
          value={`$${k.mrrUsd.toLocaleString()}`}
          icon={DollarSign}
          tone="green"
        />
        <Tile
          label="Invoiced this month"
          value={`$${k.invoicedThisMonthUsd.toLocaleString()}`}
          icon={Receipt}
          tone="blue"
          href="/super-admin/billing"
        />
        <Tile
          label="Paid this month"
          value={`$${k.paidThisMonthUsd.toLocaleString()}`}
          icon={CircleDollarSign}
          tone="green"
          href="/super-admin/billing"
        />
        <Tile
          label="Outstanding"
          value={`$${k.outstandingUsd.toLocaleString()}`}
          icon={AlertCircle}
          tone={k.outstandingUsd > 0 ? 'red' : 'slate'}
          href="/super-admin/billing"
        />
        <Tile
          label="New signups (month)"
          value={k.newSignupsThisMonth.toLocaleString()}
          icon={UserPlus}
          tone="purple"
        />
      </div>

      {/* Signups trend */}
      <Card title="Signups · last 90 days">
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={trend}>
            <defs>
              <linearGradient id="signupGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#16a34a" stopOpacity={0.4} />
                <stop offset="100%" stopColor="#16a34a" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11 }}
              tickFormatter={(v: string) => v.slice(5)}
              minTickGap={20}
            />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
            <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
            <Area
              type="monotone"
              dataKey="count"
              stroke="#16a34a"
              fill="url(#signupGrad)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      {/* Widgets row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Pending approvals */}
        <Card title="Pending approvals" right={`${k.pendingClients} total`}>
          {data.pendingApprovals.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">
              No pending clients.
            </p>
          ) : (
            <ul className="space-y-2">
              {data.pendingApprovals.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <span className="w-8 h-8 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-xs font-semibold shrink-0">
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {p.name}
                    </p>
                    <p className="text-xs text-gray-500 truncate">
                      {p.ownerEmail ?? 'No owner email'} ·{' '}
                      {fmtDate(p.createdAt)}
                    </p>
                  </div>
                  <Link
                    href={`/super-admin/clients?status=pending`}
                    className="shrink-0 text-xs font-medium text-green-700 hover:text-green-800 flex items-center gap-0.5"
                  >
                    Review <ChevronRight size={13} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Overdue invoices */}
        <Card
          title="Overdue invoices"
          right={`$${k.outstandingUsd.toLocaleString()} outstanding`}
        >
          {data.overdueInvoices.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">
              Nothing overdue. Nice.
            </p>
          ) : (
            <ul className="space-y-2">
              {data.overdueInvoices.map((i) => (
                <li
                  key={i.id}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <span className="w-8 h-8 rounded-full bg-red-100 text-red-700 flex items-center justify-center text-[10px] font-semibold shrink-0">
                    {i.daysOverdue}d
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {i.companyName}
                    </p>
                    <p className="text-xs text-gray-500 truncate">
                      {i.invoiceNumber ?? `#${i.id}`} · due{' '}
                      {fmtDate(i.dueDate)}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-red-600">
                    ${i.amount.toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Recent activity */}
        <Card title="Recent activity" right="Last 10">
          {data.recentActivity.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">
              Nothing yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {data.recentActivity.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-2 text-xs py-1"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 mt-1.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-700 truncate">
                      <span className="font-medium text-gray-900">
                        {a.userName ?? 'system'}
                      </span>{' '}
                      · {a.action.replace(/_/g, ' ')}
                      {a.entity && (
                        <span className="text-gray-500"> ({a.entity})</span>
                      )}
                    </p>
                    <p className="text-[10px] text-gray-400">
                      {new Date(a.createdAt).toLocaleString()}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Live activity strip */}
      <Card title="Today">
        <div className="flex items-center gap-3 text-sm text-gray-700">
          <span className="w-9 h-9 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center">
            <MessageSquare size={16} />
          </span>
          <p>
            <span className="font-semibold text-gray-900">
              {k.activeConversationsToday.toLocaleString()}
            </span>{' '}
            active conversations across the platform.
          </p>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

const TILE_TONE: Record<string, { bg: string; ic: string; text: string }> = {
  slate: { bg: 'from-slate-50 to-slate-50/20 border-slate-200', ic: 'bg-slate-100 text-slate-600', text: 'text-slate-800' },
  green: { bg: 'from-green-50 to-green-50/20 border-green-100', ic: 'bg-green-100 text-green-700', text: 'text-green-800' },
  amber: { bg: 'from-amber-50 to-amber-50/20 border-amber-100', ic: 'bg-amber-100 text-amber-700', text: 'text-amber-800' },
  red:   { bg: 'from-red-50 to-red-50/20 border-red-100', ic: 'bg-red-100 text-red-700', text: 'text-red-800' },
  blue:  { bg: 'from-blue-50 to-blue-50/20 border-blue-100', ic: 'bg-blue-100 text-blue-700', text: 'text-blue-800' },
  purple:{ bg: 'from-purple-50 to-purple-50/20 border-purple-100', ic: 'bg-purple-100 text-purple-700', text: 'text-purple-800' },
};

function Tile({
  label,
  value,
  icon: Icon,
  tone,
  href,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone: keyof typeof TILE_TONE;
  href?: string;
}) {
  const t = TILE_TONE[tone];
  const inner = (
    <div
      className={cn(
        'rounded-xl border bg-gradient-to-br p-4 transition-transform hover:-translate-y-0.5',
        t.bg,
      )}
    >
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          {label}
        </p>
        <span
          className={cn(
            'w-7 h-7 rounded-lg flex items-center justify-center',
            t.ic,
          )}
        >
          <Icon size={14} />
        </span>
      </div>
      <p className={cn('text-2xl font-bold mt-2', t.text)}>{value}</p>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

function Card({
  title,
  right,
  children,
}: {
  title: string;
  right?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
        {right && <span className="text-xs text-gray-400">{right}</span>}
      </div>
      {children}
    </div>
  );
}
