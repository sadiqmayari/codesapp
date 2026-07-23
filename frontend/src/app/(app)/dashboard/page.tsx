'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  LineChart,
  Line,
  CartesianGrid,
} from 'recharts';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn, zonedPresetRange } from '@/lib/utils';

interface Overview {
  totalContacts: number;
  activeConversations: number;
  openChats: number;
  messagesThisMonth: number;
  deliveryRate: number;
  readRate: number;
  replyRate: number;
  botHandledPct: number;
}
interface FunnelRow {
  date: string;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
}
interface Usage {
  period: string;
  usage: {
    messagesSent: number;
    contactsStored: number;
    templatesUsed: number;
    usersActive: number;
    webhookCalls: number;
    conversationsOpened: number;
  };
  limits: {
    contactLimit: number;
    templateLimit: number;
    userLimit: number;
  } | null;
}
interface CostInfo {
  totalConversations: number;
  estimatedCostUSD: number;
  rateUsed: number;
}
interface AgentOrderRow {
  userId: number;
  name: string;
  orders: number;
  amount: number;
  currency: string | null;
}
interface AgentOrders {
  agents: AgentOrderRow[];
  totalOrders: number;
  totalAmount: number;
  currency: string | null;
}

const RANGES = [
  { key: '7d', days: 7, label: 'last 7 days' },
  { key: '30d', days: 30, label: 'last 30 days' },
  { key: '90d', days: 90, label: 'last 90 days' },
] as const;

export default function DashboardPage() {
  const toast = useToast();
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('30d');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [funnel, setFunnel] = useState<FunnelRow[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [cost, setCost] = useState<CostInfo | null>(null);
  const [agentOrders, setAgentOrders] = useState<AgentOrders | null>(null);
  const [loading, setLoading] = useState(true);

  const params = useMemo(() => {
    // tenant-timezone-aware boundaries as full ISO instants. Passing date-only
    // strings (YYYY-MM-DD) made the backend parse them as UTC midnight, so a
    // Pakistan (UTC+5) tenant's counts were shifted by ~5h at each edge.
    const days = RANGES.find((r) => r.key === range)!.days;
    return zonedPresetRange(days);
  }, [range]);

  const rangeLabel =
    RANGES.find((r) => r.key === range)?.label ?? 'selected range';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, f, u, c, ao] = await Promise.all([
        apiFetch<Overview>('/analytics/overview', { params }),
        apiFetch<FunnelRow[]>('/analytics/funnel', { params }),
        apiFetch<Usage>('/analytics/usage'),
        apiFetch<CostInfo>('/analytics/conversation-cost', { params }),
        apiFetch<AgentOrders>('/analytics/agent-orders', { params }),
      ]);
      setOverview(o);
      setFunnel(f);
      setUsage(u);
      setCost(c);
      setAgentOrders(ao);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load analytics',
      );
    } finally {
      setLoading(false);
    }
  }, [params, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const funnelTotals = useMemo(() => {
    return funnel.reduce(
      (acc, r) => ({
        sent: acc.sent + r.sent,
        delivered: acc.delivered + r.delivered,
        read: acc.read + r.read,
        replied: acc.replied + r.replied,
      }),
      { sent: 0, delivered: 0, read: 0, replied: 0 },
    );
  }, [funnel]);

  const isEmpty =
    overview &&
    overview.totalContacts === 0 &&
    overview.activeConversations === 0;

  if (loading && !overview) {
    return (
      <div className="p-10 flex justify-center">
        <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <div className="flex bg-white border border-gray-200 rounded-lg overflow-hidden">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={cn(
                'px-4 py-1.5 text-sm',
                range === r.key
                  ? 'bg-green-600 text-white'
                  : 'text-gray-600 hover:bg-gray-50',
              )}
            >
              {r.key}
            </button>
          ))}
        </div>
      </div>

      {isEmpty ? (
        <GetStarted />
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <Kpi
              label="Total contacts"
              value={overview?.totalContacts ?? 0}
              hint="all-time"
            />
            <Kpi
              label="Active conversations"
              value={overview?.activeConversations ?? 0}
              hint="all-time"
            />
            <Kpi label="Open chats" value={overview?.openChats ?? 0} hint="now" />
            <Kpi
              label="Conversations"
              value={overview?.messagesThisMonth ?? 0}
              hint={rangeLabel}
            />
          </div>

          {/* Percentage row — scoped to the selected range */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <Pct label="Delivered" value={overview?.deliveryRate ?? 0} hint={rangeLabel} />
            <Pct label="Read" value={overview?.readRate ?? 0} hint={rangeLabel} />
            <Pct label="Reply rate" value={overview?.replyRate ?? 0} hint={rangeLabel} />
            <Pct label="Bot-handled" value={overview?.botHandledPct ?? 0} hint={rangeLabel} />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <Card title="Message funnel">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart
                  layout="vertical"
                  data={[
                    { stage: 'Sent', value: funnelTotals.sent },
                    { stage: 'Delivered', value: funnelTotals.delivered },
                    { stage: 'Read', value: funnelTotals.read },
                    { stage: 'Replied', value: funnelTotals.replied },
                  ]}
                  margin={{ left: 20 }}
                >
                  <XAxis type="number" allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="stage"
                    width={70}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip />
                  <Bar dataKey="value" fill="#16a34a" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card
              title={`Daily messages${
                cost
                  ? ` · est. cost $${cost.estimatedCostUSD} (${cost.totalConversations} conv)`
                  : ''
              }`}
            >
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={funnel}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="sent"
                    stroke="#16a34a"
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="delivered"
                    stroke="#3b82f6"
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="read"
                    stroke="#a855f7"
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          </div>

          {/* Orders created by agents */}
          <div className="mb-4">
            <AgentOrdersCard data={agentOrders} />
          </div>

          {/* Usage vs plan */}
          <Card title={`Usage vs plan limits${usage ? ` · ${usage.period}` : ''}`}>
            {usage?.limits ? (
              <div className="space-y-4">
                <UsageBar
                  label="Contacts"
                  value={usage.usage.contactsStored}
                  limit={usage.limits.contactLimit}
                />
                <UsageBar
                  label="Templates"
                  value={usage.usage.templatesUsed}
                  limit={usage.limits.templateLimit}
                />
                <UsageBar
                  label="Users"
                  value={usage.usage.usersActive}
                  limit={usage.limits.userLimit}
                />
              </div>
            ) : (
              <p className="text-sm text-gray-500">
                No subscription plan configured.
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function AgentOrdersCard({ data }: { data: AgentOrders | null }) {
  const fmtMoney = (amt: number, cur: string | null) =>
    `${cur ? cur + ' ' : ''}${amt.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })}`;
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700">
          Orders created by agents
        </h3>
        {data && (
          <div className="text-right">
            <p className="text-2xl font-bold text-gray-900 leading-none">
              {data.totalOrders.toLocaleString()}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {fmtMoney(data.totalAmount, data.currency)} total
            </p>
          </div>
        )}
      </div>
      {!data || data.agents.length === 0 ? (
        <p className="text-sm text-gray-400 py-6 text-center">
          No agent-created orders in this range.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-2">Agent</th>
                <th className="py-2 px-2 text-right">Orders</th>
                <th className="py-2 pl-2 text-right">Order value</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => (
                <tr
                  key={a.userId}
                  className="border-b border-gray-100 last:border-0"
                >
                  <td className="py-2 pr-2 font-medium text-gray-800">
                    {a.name}
                  </td>
                  <td className="py-2 px-2 text-right">
                    {a.orders.toLocaleString()}
                  </td>
                  <td className="py-2 pl-2 text-right text-gray-700">
                    {a.amount > 0 ? fmtMoney(a.amount, a.currency) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-gray-400 mt-3">
            Order value is captured for orders created after this feature
            shipped; older orders count but show no value.
          </p>
        </div>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-3xl font-bold text-gray-900 mt-2">
        {value.toLocaleString()}
      </p>
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

function Pct({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-3xl font-bold text-green-600 mt-2">{value}%</p>
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">{title}</h3>
      {children}
    </div>
  );
}

function UsageBar({
  label,
  value,
  limit,
}: {
  label: string;
  value: number | null;
  limit: number;
}) {
  const pct =
    value == null || limit <= 0
      ? 0
      : Math.min(100, Math.round((value / limit) * 100));
  const color =
    pct > 80 ? 'bg-red-500' : pct >= 60 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-gray-700">{label}</span>
        <span className="text-gray-500">
          {value == null ? '—' : value.toLocaleString()} /{' '}
          {limit.toLocaleString()}
        </span>
      </div>
      <div className="h-2.5 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={cn('h-full transition-all', color)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function GetStarted() {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-8">
      <h2 className="text-xl font-bold text-gray-900 mb-1">
        Get started with CodesApp
      </h2>
      <p className="text-gray-500 mb-6">
        You don&apos;t have any activity yet. Here&apos;s how to begin:
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div
          title="Coming soon"
          className="border border-dashed border-gray-300 rounded-xl p-5 text-center cursor-not-allowed"
        >
          <p className="font-semibold text-gray-700">Import contacts</p>
          <p className="text-xs text-gray-400 mt-1">Coming soon</p>
        </div>
        <div
          title="Coming soon"
          className="border border-dashed border-gray-300 rounded-xl p-5 text-center cursor-not-allowed"
        >
          <p className="font-semibold text-gray-700">
            Create your first template
          </p>
          <p className="text-xs text-gray-400 mt-1">Coming soon</p>
        </div>
        <Link
          href="/inbox"
          className="border border-green-200 bg-green-50 rounded-xl p-5 text-center hover:bg-green-100"
        >
          <p className="font-semibold text-green-700">Open the inbox</p>
          <p className="text-xs text-green-600 mt-1">
            Reply to incoming chats
          </p>
        </Link>
      </div>
    </div>
  );
}
