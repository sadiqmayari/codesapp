'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import AdAttribution from '@/components/analytics/ad-attribution';

// ---------------------------------------------------------------------------
// Types — the dashboard endpoint returns everything in one payload.
// ---------------------------------------------------------------------------

interface Kpi {
  value: number;
  prev: number | null;
  deltaPct: number | null;
}
interface TrendPoint {
  bucket: string;
  sent: number;
  received: number;
  delivered: number;
  read: number;
}
interface HeatPoint {
  dow: number;
  hour: number;
  count: number;
}
interface AgentRow {
  userId: number;
  name: string;
  sent: number;
  conversations: number;
  avgResponseSec: number | null;
}
interface TopContact {
  contactId: number;
  name: string;
  phone: string;
  messages: number;
  lastSeenAt: string | null;
}
interface Dashboard {
  range: {
    from: string;
    to: string;
    prevFrom: string | null;
    prevTo: string | null;
    granularity: 'hour' | 'day';
    spanDays: number;
  };
  kpis: {
    messagesSent: Kpi;
    messagesReceived: Kpi;
    activeConversations: Kpi;
    uniqueContactsEngaged: Kpi;
    newContacts: Kpi;
    deliveryRate: Kpi;
    readRate: Kpi;
    replyRate: Kpi;
    avgFirstResponseSec: Kpi;
    botHandledPct: Kpi;
  };
  trend: TrendPoint[];
  funnel: { sent: number; delivered: number; read: number; replied: number };
  statusBreakdown: { open: number; pending: number; resolved: number };
  hourlyHeatmap: HeatPoint[];
  agents: AgentRow[];
  topContacts: TopContact[];
  cost: {
    totalConversations: number;
    estimatedCostUSD: number;
    rateUsed: number;
    note: string;
  };
  usage: {
    period: string;
    usage: {
      messagesSent: number;
      contactsStored: number;
      templatesUsed: number;
      webhookCalls: number;
      conversationsOpened: number;
    };
    limits: {
      contactLimit: number;
      templateLimit: number;
      userLimit: number;
    } | null;
  };
}

// ---------------------------------------------------------------------------
// Range presets + helpers
// ---------------------------------------------------------------------------

const PRESETS = [
  { key: '1d', label: 'Today', days: 1 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
] as const;
type PresetKey = (typeof PRESETS)[number]['key'] | 'custom';

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function fmtNumber(n: number) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString();
  return String(n);
}

function fmtPct(n: number) {
  return `${n.toFixed(n < 10 ? 1 : 0)}%`;
}

function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AnalyticsPage() {
  const toast = useToast();
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState<PresetKey>('30d');
  const [customFrom, setCustomFrom] = useState(() =>
    isoDate(new Date(Date.now() - 30 * 86_400_000)),
  );
  const [customTo, setCustomTo] = useState(() => isoDate(new Date()));
  const [compare, setCompare] = useState(true);

  // Resolve the active range from preset OR custom inputs.
  const range = useMemo(() => {
    if (preset === 'custom') {
      return { from: `${customFrom}T00:00:00Z`, to: `${customTo}T23:59:59Z` };
    }
    const days = PRESETS.find((p) => p.key === preset)!.days;
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiFetch<Dashboard>('/analytics/dashboard', {
        params: {
          from: range.from,
          to: range.to,
          compare: compare ? 'true' : 'false',
        },
      });
      setData(d);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load analytics',
      );
    } finally {
      setLoading(false);
    }
  }, [range, compare, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="p-10 flex justify-center">
        <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!data) return null;

  const k = data.kpis;
  const maxHeat = data.hourlyHeatmap.reduce((m, c) => Math.max(m, c.count), 0);

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4">
      {/* Header + sticky filter bar */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {data.range.spanDays} day{data.range.spanDays !== 1 && 's'} ·{' '}
            {data.range.granularity}-buckets
            {compare && data.range.prevFrom && ' · vs previous period'}
          </p>
        </div>
        <FilterBar
          preset={preset}
          setPreset={setPreset}
          customFrom={customFrom}
          customTo={customTo}
          setCustomFrom={setCustomFrom}
          setCustomTo={setCustomTo}
          compare={compare}
          setCompare={setCompare}
          loading={loading}
        />
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiTile
          label="Sent"
          value={fmtNumber(k.messagesSent.value)}
          kpi={k.messagesSent}
          goodWhen="up"
          tone="green"
        />
        <KpiTile
          label="Received"
          value={fmtNumber(k.messagesReceived.value)}
          kpi={k.messagesReceived}
          goodWhen="up"
          tone="blue"
        />
        <KpiTile
          label="Active conversations"
          value={fmtNumber(k.activeConversations.value)}
          kpi={k.activeConversations}
          goodWhen="up"
          tone="amber"
        />
        <KpiTile
          label="Contacts engaged"
          value={fmtNumber(k.uniqueContactsEngaged.value)}
          kpi={k.uniqueContactsEngaged}
          goodWhen="up"
          tone="purple"
        />
        <KpiTile
          label="New contacts"
          value={fmtNumber(k.newContacts.value)}
          kpi={k.newContacts}
          goodWhen="up"
          tone="teal"
        />
        <KpiTile
          label="Delivered"
          value={fmtPct(k.deliveryRate.value)}
          kpi={k.deliveryRate}
          goodWhen="up"
          tone="green"
        />
        <KpiTile
          label="Read"
          value={fmtPct(k.readRate.value)}
          kpi={k.readRate}
          goodWhen="up"
          tone="blue"
        />
        <KpiTile
          label="Reply rate"
          value={fmtPct(k.replyRate.value)}
          kpi={k.replyRate}
          goodWhen="up"
          tone="amber"
        />
        <KpiTile
          label="Avg first response"
          value={fmtDuration(k.avgFirstResponseSec.value)}
          kpi={k.avgFirstResponseSec}
          goodWhen="down"
          tone="purple"
          deltaFormatter={(d) =>
            d == null ? null : `${d > 0 ? '+' : ''}${d.toFixed(1)}%`
          }
        />
        <KpiTile
          label="Bot-handled"
          value={fmtPct(k.botHandledPct.value)}
          kpi={k.botHandledPct}
          goodWhen="up"
          tone="teal"
        />
      </div>

      {/* Trend area chart */}
      <Card title="Message trend">
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={data.trend}>
            <defs>
              <linearGradient id="sentGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#16a34a" stopOpacity={0.4} />
                <stop offset="100%" stopColor="#16a34a" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="rcvGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis
              dataKey="bucket"
              tick={{ fontSize: 11 }}
              tickFormatter={(v: string) =>
                data.range.granularity === 'hour'
                  ? v.slice(11, 16)
                  : v.slice(5)
              }
            />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip
              contentStyle={{ borderRadius: 8, fontSize: 12 }}
              labelFormatter={(v: string) => v.replace('T', ' ').replace('Z', '')}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area
              type="monotone"
              dataKey="sent"
              stroke="#16a34a"
              fill="url(#sentGrad)"
              strokeWidth={2}
            />
            <Area
              type="monotone"
              dataKey="received"
              stroke="#3b82f6"
              fill="url(#rcvGrad)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      {/* Funnel + status donut row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Delivery funnel">
          <FunnelChart funnel={data.funnel} />
        </Card>
        <Card title="Conversation status (in period)">
          <StatusDonut breakdown={data.statusBreakdown} />
        </Card>
      </div>

      {/* Heatmap */}
      <Card title="When customers message you (inbound, by day & hour)">
        <Heatmap data={data.hourlyHeatmap} max={maxHeat} />
      </Card>

      {/* Agent leaderboard + top contacts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Agent leaderboard">
          {data.agents.length === 0 ? (
            <p className="text-sm text-gray-400 py-8 text-center">
              No agent activity in this range.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-2">Agent</th>
                    <th className="py-2 px-2 text-right">Sent</th>
                    <th className="py-2 px-2 text-right">Convos</th>
                    <th className="py-2 pl-2 text-right">Avg response</th>
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
                        {a.sent.toLocaleString()}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {a.conversations.toLocaleString()}
                      </td>
                      <td className="py-2 pl-2 text-right">
                        {fmtDuration(a.avgResponseSec)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Most-active contacts">
          {data.topContacts.length === 0 ? (
            <p className="text-sm text-gray-400 py-8 text-center">No activity.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-2">Contact</th>
                    <th className="py-2 px-2">Phone</th>
                    <th className="py-2 pl-2 text-right">Messages</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topContacts.map((c) => (
                    <tr
                      key={c.contactId}
                      className="border-b border-gray-100 last:border-0"
                    >
                      <td className="py-2 pr-2 font-medium text-gray-800 truncate max-w-[16ch]">
                        {c.name || '—'}
                      </td>
                      <td className="py-2 px-2 text-gray-500">{c.phone}</td>
                      <td className="py-2 pl-2 text-right">
                        {c.messages.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Cost + usage row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Estimated conversation cost">
          <p className="text-3xl font-bold text-gray-900">
            ${data.cost.estimatedCostUSD}
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {data.cost.totalConversations.toLocaleString()} conversations · rate
            ${data.cost.rateUsed}/conv
          </p>
          <p className="text-xs text-gray-400 mt-2">{data.cost.note}</p>
        </Card>
        <Card title={`Usage vs plan · ${data.usage.period}`}>
          {data.usage.limits ? (
            <div className="space-y-3">
              <UsageBar
                label="Contacts"
                value={data.usage.usage.contactsStored}
                limit={data.usage.limits.contactLimit}
              />
              <UsageBar
                label="Templates"
                value={data.usage.usage.templatesUsed}
                limit={data.usage.limits.templateLimit}
              />
              <div className="flex justify-between text-sm text-gray-600 pt-1">
                <span>Messages sent (month)</span>
                <span>{data.usage.usage.messagesSent.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-sm text-gray-600">
                <span>Webhook calls (month)</span>
                <span>{data.usage.usage.webhookCalls.toLocaleString()}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No subscription plan.</p>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <AdAttribution />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sticky filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  preset,
  setPreset,
  customFrom,
  customTo,
  setCustomFrom,
  setCustomTo,
  compare,
  setCompare,
  loading,
}: {
  preset: PresetKey;
  setPreset: (p: PresetKey) => void;
  customFrom: string;
  customTo: string;
  setCustomFrom: (v: string) => void;
  setCustomTo: (v: string) => void;
  compare: boolean;
  setCompare: (v: boolean) => void;
  loading: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex bg-white border border-gray-200 rounded-lg overflow-hidden">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPreset(p.key)}
            className={cn(
              'px-3 py-1.5 text-sm transition-colors',
              preset === p.key
                ? 'bg-green-600 text-white'
                : 'text-gray-600 hover:bg-gray-50',
            )}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPreset('custom')}
          className={cn(
            'px-3 py-1.5 text-sm border-l border-gray-200',
            preset === 'custom'
              ? 'bg-green-600 text-white'
              : 'text-gray-600 hover:bg-gray-50',
          )}
        >
          Custom
        </button>
      </div>
      {preset === 'custom' && (
        <div className="flex items-center gap-1.5 text-sm">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
          />
          <span className="text-gray-400">→</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
          />
        </div>
      )}
      <label className="flex items-center gap-1.5 text-sm text-gray-600 pl-2">
        <input
          type="checkbox"
          checked={compare}
          onChange={(e) => setCompare(e.target.checked)}
          className="accent-green-600"
        />
        Compare to previous
      </label>
      {loading && (
        <span className="ml-1 w-4 h-4 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI tile
// ---------------------------------------------------------------------------

const TONE: Record<string, string> = {
  green: 'from-green-500/10 to-green-500/0 border-green-100',
  blue: 'from-blue-500/10 to-blue-500/0 border-blue-100',
  amber: 'from-amber-500/10 to-amber-500/0 border-amber-100',
  purple: 'from-purple-500/10 to-purple-500/0 border-purple-100',
  teal: 'from-teal-500/10 to-teal-500/0 border-teal-100',
};
const TONE_TEXT: Record<string, string> = {
  green: 'text-green-700',
  blue: 'text-blue-700',
  amber: 'text-amber-700',
  purple: 'text-purple-700',
  teal: 'text-teal-700',
};

function KpiTile({
  label,
  value,
  kpi,
  goodWhen,
  tone,
  deltaFormatter,
}: {
  label: string;
  value: string;
  kpi: Kpi;
  goodWhen: 'up' | 'down';
  tone: keyof typeof TONE;
  deltaFormatter?: (deltaPct: number | null) => string | null;
}) {
  const d = kpi.deltaPct;
  // For "good when down" metrics (response time), a NEGATIVE delta is good.
  const isPositive = d != null && d > 0;
  const isFlat = d != null && d === 0;
  const good =
    d == null
      ? null
      : (goodWhen === 'up' ? isPositive : !isPositive) && !isFlat;
  const Icon = d == null || isFlat ? Minus : isPositive ? ArrowUp : ArrowDown;
  const deltaText =
    deltaFormatter?.(d) ??
    (d == null ? '—' : `${d > 0 ? '+' : ''}${d.toFixed(1)}%`);

  return (
    <div
      className={cn(
        'relative rounded-xl border bg-gradient-to-br p-4',
        TONE[tone],
      )}
    >
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
        {label}
      </p>
      <p className={cn('text-2xl font-bold mt-1', TONE_TEXT[tone])}>{value}</p>
      <div
        className={cn(
          'mt-1 inline-flex items-center gap-0.5 text-xs',
          d == null || isFlat
            ? 'text-gray-400'
            : good
              ? 'text-green-600'
              : 'text-red-600',
        )}
      >
        <Icon size={12} />
        <span>{deltaText}</span>
        {kpi.prev != null && (
          <span className="text-gray-400 ml-1">
            (prev {typeof kpi.prev === 'number' ? kpi.prev.toLocaleString() : '—'})
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Funnel chart — Sent → Delivered → Read → Replied
// ---------------------------------------------------------------------------

function FunnelChart({
  funnel,
}: {
  funnel: { sent: number; delivered: number; read: number; replied: number };
}) {
  const stages = [
    { label: 'Sent', value: funnel.sent, color: 'bg-green-500' },
    { label: 'Delivered', value: funnel.delivered, color: 'bg-blue-500' },
    { label: 'Read', value: funnel.read, color: 'bg-purple-500' },
    {
      label: 'Replied (convos)',
      value: funnel.replied,
      color: 'bg-amber-500',
    },
  ];
  const max = Math.max(1, funnel.sent);
  return (
    <div className="space-y-2">
      {stages.map((s, i) => {
        const pct = Math.round((s.value / max) * 100);
        const conv =
          i === 0 || stages[i - 1].value === 0
            ? null
            : Math.round((s.value / stages[i - 1].value) * 100);
        return (
          <div key={s.label}>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>{s.label}</span>
              <span>
                {s.value.toLocaleString()}
                {conv != null && (
                  <span className="text-gray-400 ml-2">{conv}% of prev</span>
                )}
              </span>
            </div>
            <div className="h-6 bg-gray-100 rounded-md overflow-hidden">
              <div
                className={cn('h-full transition-all', s.color)}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status donut
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  open: '#16a34a',
  pending: '#f59e0b',
  resolved: '#9ca3af',
};

function StatusDonut({
  breakdown,
}: {
  breakdown: { open: number; pending: number; resolved: number };
}) {
  const data = [
    { name: 'Open', value: breakdown.open, key: 'open' },
    { name: 'Pending', value: breakdown.pending, key: 'pending' },
    { name: 'Resolved', value: breakdown.resolved, key: 'resolved' },
  ];
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) {
    return (
      <p className="text-sm text-gray-400 py-12 text-center">
        No conversation activity in this period.
      </p>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          innerRadius={55}
          outerRadius={90}
          paddingAngle={2}
        >
          {data.map((entry) => (
            <Cell key={entry.key} fill={STATUS_COLORS[entry.key]} />
          ))}
        </Pie>
        <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Heatmap — 7 rows (Sun..Sat) x 24 cols (hours). Green intensity = volume.
// ---------------------------------------------------------------------------

function Heatmap({ data, max }: { data: HeatPoint[]; max: number }) {
  const grid: number[][] = Array.from({ length: 7 }, () =>
    new Array(24).fill(0),
  );
  for (const p of data) {
    if (p.dow >= 0 && p.dow < 7 && p.hour >= 0 && p.hour < 24) {
      grid[p.dow][p.hour] = p.count;
    }
  }
  if (max === 0) {
    return (
      <p className="text-sm text-gray-400 py-8 text-center">
        No inbound traffic in this period.
      </p>
    );
  }
  const intensity = (c: number) => {
    if (c === 0) return 'bg-gray-50';
    const pct = c / max;
    if (pct < 0.15) return 'bg-green-100';
    if (pct < 0.35) return 'bg-green-200';
    if (pct < 0.55) return 'bg-green-300';
    if (pct < 0.75) return 'bg-green-500';
    return 'bg-green-700';
  };
  return (
    <div className="overflow-x-auto">
      <div className="inline-block min-w-full">
        <div className="flex items-center gap-1 text-[10px] text-gray-400 pl-9 mb-1">
          {Array.from({ length: 24 }).map((_, h) => (
            <span key={h} className="w-4 text-center">
              {h % 3 === 0 ? h : ''}
            </span>
          ))}
        </div>
        {DOW_LABELS.map((lbl, dow) => (
          <div key={dow} className="flex items-center gap-1 mb-1">
            <span className="w-8 text-[10px] text-gray-500">{lbl}</span>
            {grid[dow].map((c, h) => (
              <div
                key={h}
                title={`${lbl} ${h}:00 — ${c} messages`}
                className={cn(
                  'w-4 h-4 rounded-sm transition-transform hover:scale-125',
                  intensity(c),
                )}
              />
            ))}
          </div>
        ))}
        <div className="flex items-center gap-1 mt-2 pl-9 text-[10px] text-gray-400">
          <span>Less</span>
          {['bg-gray-50', 'bg-green-100', 'bg-green-200', 'bg-green-300', 'bg-green-500', 'bg-green-700'].map(
            (c) => (
              <span key={c} className={cn('w-4 h-3 rounded-sm', c)} />
            ),
          )}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Misc primitives
// ---------------------------------------------------------------------------

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
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
  const pct = limit <= 0 ? 0 : Math.min(100, Math.round((value / limit) * 100));
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
