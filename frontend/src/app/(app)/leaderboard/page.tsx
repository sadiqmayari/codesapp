'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Trophy,
  Crown,
  Zap,
  Target as TargetIcon,
  Plus,
  Pencil,
  Trash2,
  Medal,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useAuth } from '@/context/auth-context';
import { cn, zonedTodayRange, zonedWeekRange, zonedMonthRange } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/modal';
import { ContestModal } from '@/components/gamification/contest-modal';
import { TargetModal } from '@/components/gamification/target-modal';
import {
  Contest,
  LeaderboardResult,
  LeaderboardRow,
  TargetProgress,
  METRIC_LABELS,
  PERIOD_LABELS,
  formatMetricValue,
  formatResponse,
  getContests,
  getLeaderboard,
  getTargets,
  deleteContest,
  deleteTarget,
} from '@/lib/gamification';

type Period = 'today' | 'week' | 'month' | 'custom';
const PERIOD_TABS: Array<[Period, string]> = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['custom', 'Custom'],
];

const RANK_STYLES = ['text-amber-500', 'text-gray-400', 'text-orange-600'];

export default function LeaderboardPage() {
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const myId = user?.id ?? -1;

  const [period, setPeriod] = useState<Period>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const [board, setBoard] = useState<LeaderboardResult | null>(null);
  const [contests, setContests] = useState<Contest[]>([]);
  const [targets, setTargets] = useState<TargetProgress[]>([]);
  const [agents, setAgents] = useState<Array<{ id: number; name: string }>>([]);
  const [loading, setLoading] = useState(true);

  const [contestModal, setContestModal] = useState<{ open: boolean; existing?: Contest | null }>(
    { open: false },
  );
  const [targetModalOpen, setTargetModalOpen] = useState(false);
  const [confirmContest, setConfirmContest] = useState<Contest | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<TargetProgress | null>(null);
  const [busy, setBusy] = useState(false);

  const range = useMemo(() => {
    // Calendar-aligned (tenant tz) so "This week" = Monday→now and "This month"
    // = 1st→now — matching their labels AND the server's weekly/monthly target
    // + contest windows. (Rolling zonedPresetRange(7/30) previously pulled in the
    // tail of the prior week/month, inflating the board near a boundary.)
    if (period === 'today') return zonedTodayRange();
    if (period === 'week') return zonedWeekRange();
    if (period === 'month') return zonedMonthRange(0);
    return {
      from: customFrom
        ? new Date(`${customFrom}T00:00:00`).toISOString()
        : zonedWeekRange().from,
      to: customTo
        ? new Date(`${customTo}T23:59:59`).toISOString()
        : new Date().toISOString(),
    };
  }, [period, customFrom, customTo]);

  const loadBoard = useCallback(async () => {
    try {
      const b = await getLeaderboard(range);
      setBoard(b);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load leaderboard');
    }
  }, [range, toast]);

  const loadRest = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([getContests(), getTargets()]);
      setContests(c);
      setTargets(t);
    } catch {
      /* non-fatal — leaderboard still renders */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      await loadBoard();
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [loadBoard]);

  useEffect(() => {
    loadRest();
  }, [loadRest]);

  // Admin needs the agent roster for the target modal.
  useEffect(() => {
    if (!isAdmin) return;
    apiFetch<Array<{ id: number; name: string; status: string; role: string }>>('/team')
      .then((list) =>
        setAgents(
          list
            .filter((m) => m.status !== 'suspended')
            .map((m) => ({ id: m.id, name: m.name })),
        ),
      )
      .catch(() => {});
  }, [isAdmin]);

  const rows = board?.rows ?? [];
  const myRow = rows.find((r) => r.userId === myId);
  const top3 = rows.slice(0, 3);

  const removeContest = async () => {
    if (!confirmContest) return;
    setBusy(true);
    try {
      await deleteContest(confirmContest.id);
      toast.success('Contest deleted');
      setConfirmContest(null);
      loadRest();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to delete');
    } finally {
      setBusy(false);
    }
  };

  const removeTarget = async () => {
    if (!confirmTarget) return;
    setBusy(true);
    try {
      await deleteTarget(confirmTarget.id);
      toast.success('Target removed');
      setConfirmTarget(null);
      loadRest();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to remove');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div className="flex items-center gap-2">
          <Trophy className="text-amber-500" size={26} />
          <h1 className="text-2xl font-bold text-gray-900">Leaderboard</h1>
        </div>
        <div className="flex bg-white border border-gray-200 rounded-lg overflow-hidden">
          {PERIOD_TABS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setPeriod(k)}
              className={cn(
                'px-3.5 py-1.5 text-sm',
                period === k
                  ? 'bg-green-600 text-white'
                  : 'text-gray-600 hover:bg-gray-50',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {period === 'custom' && (
        <div className="flex items-center gap-2 mb-5 text-sm">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5"
          />
          <span className="text-gray-400">to</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5"
          />
        </div>
      )}

      {/* Your standing */}
      {myRow && (
        <div className="mb-5 bg-gradient-to-r from-green-600 to-emerald-500 text-white rounded-xl p-4 flex items-center justify-between">
          <div>
            <p className="text-sm opacity-90">Your standing</p>
            <p className="text-2xl font-bold leading-tight">
              #{myRow.rank}{' '}
              <span className="text-base font-normal opacity-90">
                of {rows.length}
              </span>
            </p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-bold leading-none">{myRow.points}</p>
            <p className="text-sm opacity-90">points</p>
          </div>
        </div>
      )}

      {loading && !board ? (
        <div className="p-10 flex justify-center">
          <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-gray-400">
          No agent activity in this period yet.
        </div>
      ) : (
        <>
          {/* Podium */}
          {top3.length >= 1 && (
            <div className="grid grid-cols-3 gap-3 mb-5">
              {[1, 0, 2].map((slot) => {
                const r = top3[slot];
                if (!r) return <div key={slot} />;
                const isFirst = slot === 0;
                return (
                  <div
                    key={r.userId}
                    className={cn(
                      'rounded-xl border p-4 text-center bg-white',
                      isFirst
                        ? 'border-amber-300 shadow-md sm:-mt-2'
                        : 'border-gray-200',
                    )}
                  >
                    <div className="flex justify-center mb-2">
                      <div
                        className={cn(
                          'w-12 h-12 rounded-full flex items-center justify-center font-bold text-white',
                          slot === 0
                            ? 'bg-amber-500'
                            : slot === 1
                              ? 'bg-gray-400'
                              : 'bg-orange-600',
                        )}
                      >
                        {r.name.slice(0, 2).toUpperCase()}
                      </div>
                    </div>
                    {isFirst && (
                      <Crown className="mx-auto text-amber-500 mb-1" size={18} />
                    )}
                    <p className="font-semibold text-gray-800 text-sm truncate">
                      {r.name}
                    </p>
                    <p className="text-lg font-bold text-gray-900">{r.points}</p>
                    <p className="text-xs text-gray-400">pts · #{r.rank}</p>
                  </div>
                );
              })}
            </div>
          )}

          {/* Full table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mb-8">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200 bg-gray-50">
                    <th className="py-2.5 px-3 w-12">#</th>
                    <th className="py-2.5 px-3">Agent</th>
                    <th className="py-2.5 px-3 text-right">Points</th>
                    <th className="py-2.5 px-3 text-right">Orders</th>
                    <th className="py-2.5 px-3 text-right">Revenue</th>
                    <th className="py-2.5 px-3 text-right">Chats</th>
                    <th className="py-2.5 px-3 text-right">Conv.</th>
                    <th className="py-2.5 px-3 text-right">Carts</th>
                    <th className="py-2.5 px-3 text-right">Response</th>
                    <th className="py-2.5 px-3">Badges</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <BoardRow
                      key={r.userId}
                      r={r}
                      currency={board?.currency ?? null}
                      me={r.userId === myId}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Contests */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Zap size={18} className="text-violet-500" /> Contests
          </h2>
          {isAdmin && (
            <button
              onClick={() => setContestModal({ open: true, existing: null })}
              className="flex items-center gap-1 text-sm bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700"
            >
              <Plus size={16} /> New contest
            </button>
          )}
        </div>
        {contests.length === 0 ? (
          <p className="text-sm text-gray-400 bg-white border border-gray-200 rounded-xl p-6 text-center">
            No contests yet.
            {isAdmin && ' Create one to kick off a challenge.'}
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {contests.map((c) => (
              <ContestCard
                key={c.id}
                c={c}
                currency={board?.currency ?? null}
                isAdmin={isAdmin}
                onEdit={() => setContestModal({ open: true, existing: c })}
                onDelete={() => setConfirmContest(c)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Targets */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <TargetIcon size={18} className="text-blue-500" />{' '}
            {isAdmin ? 'Targets' : 'My targets'}
          </h2>
          {isAdmin && (
            <button
              onClick={() => setTargetModalOpen(true)}
              className="flex items-center gap-1 text-sm bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700"
            >
              <Plus size={16} /> Assign target
            </button>
          )}
        </div>
        {targets.length === 0 ? (
          <p className="text-sm text-gray-400 bg-white border border-gray-200 rounded-xl p-6 text-center">
            No targets set.
          </p>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            {targets.map((t) => (
              <TargetRow
                key={t.id}
                t={t}
                currency={board?.currency ?? null}
                isAdmin={isAdmin}
                onDelete={() => setConfirmTarget(t)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Modals */}
      {contestModal.open && (
        <ContestModal
          open={contestModal.open}
          existing={contestModal.existing}
          onClose={() => setContestModal({ open: false })}
          onSaved={loadRest}
        />
      )}
      {targetModalOpen && (
        <TargetModal
          open={targetModalOpen}
          agents={agents}
          onClose={() => setTargetModalOpen(false)}
          onSaved={loadRest}
        />
      )}
      <ConfirmDialog
        open={!!confirmContest}
        title="Delete contest"
        message={`Delete "${confirmContest?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={removeContest}
        onCancel={() => setConfirmContest(null)}
      />
      <ConfirmDialog
        open={!!confirmTarget}
        title="Remove target"
        message={`Remove the ${confirmTarget ? METRIC_LABELS[confirmTarget.metric] : ''} target for ${confirmTarget?.userName ?? 'this agent'}?`}
        confirmLabel="Remove"
        danger
        busy={busy}
        onConfirm={removeTarget}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}

function BoardRow({
  r,
  currency,
  me,
}: {
  r: LeaderboardRow;
  currency: string | null;
  me: boolean;
}) {
  return (
    <tr
      className={cn(
        'border-b border-gray-100 last:border-0',
        me && 'bg-green-50',
      )}
    >
      <td className="py-2.5 px-3">
        <span
          className={cn(
            'font-bold',
            r.rank <= 3 ? RANK_STYLES[r.rank - 1] : 'text-gray-400',
          )}
        >
          {r.rank}
        </span>
      </td>
      <td className="py-2.5 px-3 font-medium text-gray-800">
        {r.name}
        {me && <span className="ml-1.5 text-xs text-green-600">(you)</span>}
      </td>
      <td className="py-2.5 px-3 text-right font-semibold text-gray-900">
        {r.points}
      </td>
      <td className="py-2.5 px-3 text-right">{r.orders.toLocaleString()}</td>
      <td className="py-2.5 px-3 text-right text-gray-700">
        {r.orderValue > 0
          ? formatMetricValue('revenue', r.orderValue, r.currency ?? currency)
          : '—'}
      </td>
      <td className="py-2.5 px-3 text-right">{r.chats.toLocaleString()}</td>
      <td className="py-2.5 px-3 text-right">
        {Math.round(r.conversionRate * 100)}%
      </td>
      <td className="py-2.5 px-3 text-right">
        {r.cartsRecovered.toLocaleString()}
      </td>
      <td className="py-2.5 px-3 text-right">{formatResponse(r.medianRespSec)}</td>
      <td className="py-2.5 px-3">
        <div className="flex flex-wrap gap-1">
          {r.badges.map((b) => (
            <span
              key={b.id}
              className="inline-flex items-center gap-0.5 text-[11px] bg-amber-100 text-amber-700 rounded-full px-2 py-0.5"
              title={b.label}
            >
              <Medal size={11} /> {b.label}
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}

function ContestCard({
  c,
  currency,
  isAdmin,
  onEdit,
  onDelete,
}: {
  c: Contest;
  currency: string | null;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const statusColor =
    c.status === 'active'
      ? 'bg-green-100 text-green-700'
      : c.status === 'scheduled'
        ? 'bg-blue-100 text-blue-700'
        : 'bg-gray-100 text-gray-500';
  const leaderVal =
    c.leader != null
      ? formatMetricValue(c.metric, c.leader.value, currency)
      : null;
  const denom = c.targetValue ?? c.leader?.value ?? 0;
  const pct =
    denom > 0 ? Math.min(100, Math.round((c.myValue / denom) * 100)) : 0;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-gray-900 truncate">{c.name}</h3>
            <span className={cn('text-[11px] rounded-full px-2 py-0.5', statusColor)}>
              {c.status}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {METRIC_LABELS[c.metric]}
            {c.targetValue != null &&
              ` · goal ${formatMetricValue(c.metric, c.targetValue, currency)}`}
          </p>
        </div>
        {isAdmin && (
          <div className="flex gap-1 shrink-0">
            <button
              onClick={onEdit}
              className="text-gray-400 hover:text-gray-700 p-1"
              aria-label="Edit"
            >
              <Pencil size={15} />
            </button>
            <button
              onClick={onDelete}
              className="text-gray-400 hover:text-red-600 p-1"
              aria-label="Delete"
            >
              <Trash2 size={15} />
            </button>
          </div>
        )}
      </div>

      {c.description && (
        <p className="text-sm text-gray-600 mt-2">{c.description}</p>
      )}
      {c.prize && (
        <p className="text-sm mt-2">
          <span className="text-gray-400">Prize:</span>{' '}
          <span className="font-medium text-gray-800">{c.prize}</span>
        </p>
      )}

      {c.status !== 'scheduled' && (
        <>
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-gray-500">
              Leader:{' '}
              <span className="font-medium text-gray-800">
                {c.leader ? `${c.leader.name} (${leaderVal})` : '—'}
              </span>
            </span>
            <span className="text-gray-500">
              You: <span className="font-medium text-gray-800">
                {formatMetricValue(c.metric, c.myValue, currency)}
              </span>
              {c.myRank && ` · #${c.myRank}`}
            </span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden mt-2">
            <div
              className="h-full bg-violet-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function TargetRow({
  t,
  currency,
  isAdmin,
  onDelete,
}: {
  t: TargetProgress;
  currency: string | null;
  isAdmin: boolean;
  onDelete: () => void;
}) {
  const color =
    t.pct >= 100 ? 'bg-green-500' : t.pct >= 60 ? 'bg-blue-500' : 'bg-amber-500';
  return (
    <div className="p-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between text-sm mb-1">
          <span className="font-medium text-gray-800 truncate">
            {isAdmin && t.userName ? `${t.userName} · ` : ''}
            {METRIC_LABELS[t.metric]}{' '}
            <span className="text-gray-400 font-normal">
              ({PERIOD_LABELS[t.periodType]})
            </span>
          </span>
          <span className="text-gray-500 shrink-0 ml-2">
            {formatMetricValue(t.metric, t.current, currency)} /{' '}
            {formatMetricValue(t.metric, t.targetValue, currency)}
          </span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={cn('h-full transition-all', color)}
            style={{ width: `${t.pct}%` }}
          />
        </div>
      </div>
      {isAdmin && (
        <button
          onClick={onDelete}
          className="text-gray-400 hover:text-red-600 p-1 shrink-0"
          aria-label="Remove target"
        >
          <Trash2 size={15} />
        </button>
      )}
    </div>
  );
}
