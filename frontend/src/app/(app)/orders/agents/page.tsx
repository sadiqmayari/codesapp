'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Users,
  Download,
  Loader2,
  CheckCircle2,
  MapPin,
  Ban,
  Phone,
  X,
} from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import {
  fmtDateTime,
  zonedTodayRange,
  zonedYesterdayRange,
  zonedMonthRange,
} from '@/lib/utils';
import {
  getAgentsReport,
  getAgentActivity,
  downloadAgentsReportCsv,
  type AgentsReport,
  type AgentReportRow,
  type AgentActivityItem,
} from '@/lib/agents-report';

type PresetKey = 'today' | 'yesterday' | 'month' | 'lastmonth' | 'custom';
const PRESETS: Array<[PresetKey, string]> = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['month', 'This month'],
  ['lastmonth', 'Last month'],
  ['custom', 'Custom'],
];

const ACTION_META: Record<string, { label: string; color: string; verb: string }> = {
  order_confirmed: { label: 'Confirmed', color: '#147a58', verb: 'Confirmed order' },
  address_corrected: { label: 'Address fixed', color: '#2f6bd6', verb: 'Corrected address on' },
  order_cancelled: { label: 'Cancelled', color: '#c0483c', verb: 'Cancelled order' },
  contact_logged: { label: 'Logged contact', color: '#8a5cd0', verb: 'Logged contact for' },
};

const AV_COLORS = ['#147a58', '#2f6bd6', '#c0483c', '#8a5cd0', '#b8860b', '#0d7d7d'];

function money(v: number | null | undefined, cur?: string | null) {
  return v == null ? '—' : `${cur ?? 'PKR'} ${Math.round(v).toLocaleString()}`;
}

export default function AgentsReportPage() {
  const router = useRouter();
  const { user } = useAuth();
  const toast = useToast();
  const canManage = user?.role === 'owner' || user?.role === 'admin';

  const [preset, setPreset] = useState<PresetKey>('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState<AgentsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<AgentReportRow | null>(null);
  const [feed, setFeed] = useState<AgentActivityItem[] | null>(null);

  // Agents can't see this report.
  useEffect(() => {
    if (user && !canManage) router.replace('/orders');
  }, [user, canManage, router]);

  const range = useMemo(() => {
    if (preset === 'today') return zonedTodayRange();
    if (preset === 'yesterday') return zonedYesterdayRange();
    if (preset === 'month') return zonedMonthRange(0);
    if (preset === 'lastmonth') return zonedMonthRange(-1);
    if (customFrom && customTo) {
      return {
        from: new Date(`${customFrom}T00:00:00`).toISOString(),
        to: new Date(`${customTo}T23:59:59.999`).toISOString(),
      };
    }
    return zonedMonthRange(0);
  }, [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getAgentsReport(range);
      setData(d);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/orders');
        return;
      }
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load the report');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  useEffect(() => {
    load();
  }, [load]);

  const openAgent = async (r: AgentReportRow) => {
    setSelected(r);
    setFeed(null);
    try {
      setFeed(await getAgentActivity(r.userId, range));
    } catch {
      setFeed([]);
    }
  };

  const doExport = async () => {
    setExporting(true);
    try {
      await downloadAgentsReportCsv(range);
    } catch {
      toast.error('Could not export the CSV.');
    } finally {
      setExporting(false);
    }
  };

  const t = data?.totals;
  const cur = data?.currency;
  const rate = (r: { delivered: number; failed: number }) => {
    const tot = r.delivered + r.failed;
    return tot ? Math.round((r.delivered / tot) * 100) : null;
  };
  const avColor = (i: number) => AV_COLORS[i % AV_COLORS.length];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <Users size={22} className="text-green-600" /> Agent performance
          </h1>
          <p className="text-sm text-gray-500">
            Who did what — confirmations, address fixes, cancellations &amp; customer contact.{' '}
            <span className="text-gray-400">Owner / admin only.</span>
          </p>
        </div>
        <button
          onClick={doExport}
          disabled={exporting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50"
        >
          {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          Export CSV
        </button>
      </div>

      {/* Period */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap rounded-lg border border-gray-200 bg-white">
          {PRESETS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setPreset(k)}
              className={
                'px-3 py-1.5 text-sm ' +
                (preset === k ? 'bg-green-600 text-white' : 'text-gray-600 hover:bg-gray-50')
              }
            >
              {label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
            />
            <span className="text-gray-400">→</span>
            <input
              type="date"
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
            />
          </div>
        )}
      </div>

      {/* Team totals */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi icon={<CheckCircle2 size={15} />} color="#147a58" label="Orders confirmed" value={t?.confirmed} />
        <Kpi icon={<MapPin size={15} />} color="#2f6bd6" label="Addresses corrected" value={t?.addressCorrected} />
        <Kpi icon={<Ban size={15} />} color="#c0483c" label="Orders cancelled" value={t?.cancelled} />
        <Kpi icon={<Phone size={15} />} color="#8a5cd0" label="Customers contacted" value={t?.customersContacted} />
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-[860px] w-full text-sm">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Agent</th>
                <th className="px-3 py-2.5 text-right font-medium">Confirmed</th>
                <th className="px-3 py-2.5 text-right font-medium">Addr fixed</th>
                <th className="px-3 py-2.5 text-right font-medium">Cancelled</th>
                <th className="px-3 py-2.5 text-right font-medium">Contacted</th>
                <th className="px-3 py-2.5 text-right font-medium">Calls</th>
                <th className="px-3 py-2.5 text-right font-medium">Created</th>
                <th className="px-3 py-2.5 text-right font-medium">Value</th>
                <th className="px-3 py-2.5 text-right font-medium">Delivery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 tabular-nums">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-gray-400">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-green-500" />
                  </td>
                </tr>
              ) : (data?.rows.length ?? 0) === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-sm text-gray-400">
                    No agent activity in this period.
                  </td>
                </tr>
              ) : (
                data!.rows.map((r, i) => {
                  const rt = rate(r);
                  return (
                    <tr
                      key={r.userId}
                      onClick={() => openAgent(r)}
                      className={
                        'cursor-pointer transition-colors ' +
                        (selected?.userId === r.userId ? 'bg-green-50' : 'hover:bg-gray-50')
                      }
                    >
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-2.5">
                          <span
                            className="grid h-7 w-7 place-items-center rounded-lg text-[11px] font-bold text-white"
                            style={{ background: avColor(i) }}
                          >
                            {r.name.slice(0, 2).toUpperCase()}
                          </span>
                          <span>
                            <span className="block font-medium text-gray-800">{r.name}</span>
                            <span className="block text-[11px] text-gray-400">{r.role}</span>
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-semibold text-gray-900">{r.confirmed.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-gray-700">{r.addressCorrected.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-gray-700">{r.cancelled.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-gray-700">{r.customersContacted.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-gray-500">{r.loggedContacts.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-gray-700">{r.ordersCreated.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-gray-700">{money(r.orderValue, r.currency ?? cur)}</td>
                      <td className="px-3 py-2.5 text-right">
                        {rt == null ? (
                          <span className="text-gray-300">—</span>
                        ) : (
                          <span className={rt >= 70 ? 'text-green-700' : rt >= 40 ? 'text-amber-600' : 'text-red-600'}>
                            {rt}%<span className="ml-1 text-[11px] text-gray-400">{r.delivered}/{r.delivered + r.failed}</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            {t && (data?.rows.length ?? 0) > 0 && (
              <tfoot>
                <tr className="border-t-2 border-gray-200 font-semibold text-gray-800">
                  <td className="px-4 py-2.5 text-[11px] uppercase tracking-wide text-gray-500">Team total</td>
                  <td className="px-3 py-2.5 text-right">{t.confirmed.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right">{t.addressCorrected.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right">{t.cancelled.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right">{t.customersContacted.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right">{t.loggedContacts.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right">{t.ordersCreated.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right">{money(t.orderValue, cur)}</td>
                  <td className="px-3 py-2.5 text-right text-gray-400">{t.delivered}/{t.delivered + t.failed}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
      <p className="text-xs text-gray-400">
        Confirmed / address-fixed / cancelled / logged contacts are counted from when this report
        went live; contacts, orders created &amp; delivery are historical. Click an agent for their
        activity.
      </p>

      {/* Drill-down */}
      {selected && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg text-xs font-bold text-white" style={{ background: '#147a58' }}>
              {selected.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="font-semibold text-gray-900">{selected.name}</span>
            <span className="text-xs text-gray-400">{selected.role} · recent activity</span>
            <button onClick={() => setSelected(null)} className="ml-auto text-gray-300 hover:text-gray-600">
              <X size={16} />
            </button>
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Mini icon={<CheckCircle2 size={13} />} color="#147a58" label="Confirmed" value={selected.confirmed} />
            <Mini icon={<MapPin size={13} />} color="#2f6bd6" label="Addr fixed" value={selected.addressCorrected} />
            <Mini icon={<Ban size={13} />} color="#c0483c" label="Cancelled" value={selected.cancelled} />
            <Mini icon={<Phone size={13} />} color="#8a5cd0" label={`Contacted · ${selected.loggedContacts} calls`} value={selected.customersContacted} />
          </div>
          {feed == null ? (
            <div className="py-6 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-green-500" /></div>
          ) : feed.length === 0 ? (
            <p className="py-4 text-center text-sm text-gray-400">
              No logged actions in this period (confirmed / address / cancel / logged-contact are recorded from go-live).
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {feed.map((e, i) => {
                const m = ACTION_META[e.action] ?? { label: e.action, color: '#888', verb: e.action };
                return (
                  <li key={i} className="flex items-start gap-2.5 py-2 text-sm">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: m.color }} />
                    <span className="flex-1 text-gray-700">
                      {m.verb} {e.orderName && <span className="font-medium text-gray-900">{e.orderName}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-gray-400">{fmtDateTime(e.at)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Kpi({ icon, color, label, value }: { icon: React.ReactNode; color: string; label: string; value: number | undefined }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3.5">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-500">
        <span style={{ color }}>{icon}</span> {label}
      </div>
      <p className="mt-1 text-2xl font-bold text-gray-900 tabular-nums">
        {value == null ? '—' : value.toLocaleString()}
      </p>
    </div>
  );
}

function Mini({ icon, color, label, value }: { icon: React.ReactNode; color: string; label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 p-2.5">
      <p className="text-lg font-bold text-gray-900 tabular-nums" style={{ color }}>{value.toLocaleString()}</p>
      <p className="flex items-center gap-1 text-[10.5px] uppercase tracking-wide text-gray-500">
        <span style={{ color }}>{icon}</span> {label}
      </p>
    </div>
  );
}
