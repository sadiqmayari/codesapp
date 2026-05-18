'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import type {
  AnalyticsOverview,
  FunnelRow,
  AgentRow,
  ConversationCost,
  UsageInfo,
} from '@/lib/crm-types';

const RANGES = [
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
  { key: '90d', days: 90 },
] as const;

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function AnalyticsPage() {
  const toast = useToast();
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('30d');
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [funnel, setFunnel] = useState<FunnelRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [cost, setCost] = useState<ConversationCost | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const params = useMemo(() => {
    const days = RANGES.find((r) => r.key === range)!.days;
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    return { from: isoDate(from), to: isoDate(to) };
  }, [range]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, f, a, c, u] = await Promise.all([
        apiFetch<AnalyticsOverview>('/analytics/overview'),
        apiFetch<FunnelRow[]>('/analytics/funnel', { params }),
        apiFetch<AgentRow[]>('/analytics/agents', { params }),
        apiFetch<ConversationCost>('/analytics/conversation-cost', { params }),
        apiFetch<UsageInfo>('/analytics/usage'),
      ]);
      setOverview(o);
      setFunnel(f);
      setAgents(a);
      setCost(c);
      setUsage(u);
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
        <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <Kpi label="Delivered" value={`${overview?.deliveryRate ?? 0}%`} />
        <Kpi label="Read" value={`${overview?.readRate ?? 0}%`} />
        <Kpi label="Reply rate" value={`${overview?.replyRate ?? 0}%`} />
        <Kpi label="Bot-handled" value={`${overview?.botHandledPct ?? 0}%`} />
      </div>

      <Card title="Daily message funnel">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={funnel}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="sent" stroke="#16a34a" dot={false} />
            <Line
              type="monotone"
              dataKey="delivered"
              stroke="#3b82f6"
              dot={false}
            />
            <Line type="monotone" dataKey="read" stroke="#a855f7" dot={false} />
            <Line
              type="monotone"
              dataKey="replied"
              stroke="#f59e0b"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <Card title="Agent performance — messages sent">
          {agents.length === 0 ? (
            <p className="text-sm text-gray-400 py-8 text-center">
              No agent activity in this range.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={agents} layout="vertical" margin={{ left: 20 }}>
                <XAxis type="number" allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={90}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip />
                <Bar
                  dataKey="messagesSent"
                  fill="#16a34a"
                  radius={[0, 4, 4, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Agent leaderboard">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-2">Agent</th>
                  <th className="py-2 px-2">Conversations</th>
                  <th className="py-2 px-2">Msgs</th>
                  <th className="py-2 pl-2">Avg response</th>
                </tr>
              </thead>
              <tbody>
                {agents.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="py-6 text-center text-gray-400"
                    >
                      No data
                    </td>
                  </tr>
                ) : (
                  agents.map((a) => (
                    <tr
                      key={a.userId}
                      className="border-b border-gray-100 last:border-0"
                    >
                      <td className="py-2 pr-2 font-medium text-gray-800">
                        {a.name}
                      </td>
                      <td className="py-2 px-2">{a.conversationsHandled}</td>
                      <td className="py-2 px-2">{a.messagesSent}</td>
                      <td className="py-2 pl-2">
                        {fmtDuration(a.avgResponseTimeMin)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <Card title="Estimated conversation cost">
          {cost ? (
            <div className="space-y-2">
              <p className="text-3xl font-bold text-gray-900">
                ${cost.estimatedCostUSD}
              </p>
              <p className="text-sm text-gray-500">
                {cost.totalConversations.toLocaleString()} conversations · rate
                ${cost.rateUsed}/conv
              </p>
              <p className="text-xs text-gray-400">{cost.note}</p>
            </div>
          ) : (
            <p className="text-sm text-gray-400">No cost data.</p>
          )}
        </Card>

        <Card
          title={`Usage vs plan${usage ? ` · ${usage.period}` : ''}`}
        >
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
              <div className="flex justify-between text-sm text-gray-600">
                <span>Messages sent</span>
                <span>{usage.usage.messagesSent.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-sm text-gray-600">
                <span>Webhook calls</span>
                <span>{usage.usage.webhookCalls.toLocaleString()}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              No subscription plan configured.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

function fmtDuration(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min <= 0) return '—';
  const total = Math.round(min);
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-3xl font-bold text-green-600 mt-2">{value}</p>
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
  value: number;
  limit: number;
}) {
  const pct =
    limit <= 0 ? 0 : Math.min(100, Math.round((value / limit) * 100));
  const color =
    pct > 80 ? 'bg-red-500' : pct >= 60 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-gray-700">{label}</span>
        <span className="text-gray-500">
          {value.toLocaleString()} / {limit.toLocaleString()}
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
