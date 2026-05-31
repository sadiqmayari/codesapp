'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Plus,
  Send,
  CalendarClock,
  Ban,
  BarChart3,
  Pencil,
  Copy,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useSocket } from '@/context/socket-context';
import { cn, fmtDateTime } from '@/lib/utils';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import type {
  Broadcast,
  BroadcastAnalytics,
  BroadcastProgress,
  BroadcastStatus,
} from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

const FILTERS: Array<{ key: BroadcastStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'sending', label: 'Sending' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
  { key: 'cancelled', label: 'Cancelled' },
];

const LIMIT = 20;

function StatusPill({ status }: { status: BroadcastStatus }) {
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize',
        status === 'completed' && 'bg-green-100 text-green-800',
        status === 'sending' && 'bg-blue-100 text-blue-800',
        status === 'scheduled' && 'bg-yellow-100 text-yellow-800',
        status === 'draft' && 'bg-gray-200 text-gray-700',
        status === 'failed' && 'bg-red-100 text-red-800',
        status === 'cancelled' && 'bg-gray-200 text-gray-500',
      )}
    >
      {status}
    </span>
  );
}

export default function BroadcastsPage() {
  const router = useRouter();
  const toast = useToast();
  const { on } = useSocket();

  const [rows, setRows] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<BroadcastStatus | 'all'>('all');
  const [page, setPage] = useState(1);

  const [analytics, setAnalytics] = useState<BroadcastAnalytics | null>(null);
  const [scheduleFor, setScheduleFor] = useState<Broadcast | null>(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const [confirmAction, setConfirmAction] = useState<{
    b: Broadcast;
    kind: 'send' | 'cancel';
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<Broadcast[]>('/broadcasts', {
        params: {
          status: filter === 'all' ? undefined : filter,
          page,
          limit: LIMIT,
        },
      });
      setRows(res);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load broadcasts',
      );
    } finally {
      setLoading(false);
    }
  }, [filter, page, toast]);

  useEffect(() => {
    setPage(1);
  }, [filter]);
  useEffect(() => {
    load();
  }, [load]);

  // Live progress: backend emits broadcast.progress to the company room
  // every 25 jobs + on completion.
  const rowsRef = useRef<Broadcast[]>([]);
  rowsRef.current = rows;
  useEffect(() => {
    const off = on('broadcast.progress', (p: BroadcastProgress) => {
      if (!rowsRef.current.some((r) => r.id === p.broadcastId)) return;
      setRows((cur) =>
        cur.map((r) =>
          r.id === p.broadcastId
            ? {
                ...r,
                sent_count: p.sent,
                failed_count: p.failed,
                status: p.status ?? r.status,
              }
            : r,
        ),
      );
    });
    return off;
  }, [on]);

  const openAnalytics = async (b: Broadcast) => {
    try {
      const a = await apiFetch<BroadcastAnalytics>(
        `/broadcasts/${b.id}/analytics`,
      );
      setAnalytics(a);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load analytics',
      );
    }
  };

  const doConfirm = async () => {
    if (!confirmAction) return;
    const { b, kind } = confirmAction;
    setBusy(true);
    try {
      await apiFetch(`/broadcasts/${b.id}/${kind}`, { method: 'POST' });
      toast.success(kind === 'send' ? 'Broadcast sending' : 'Broadcast cancelled');
      setConfirmAction(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const clone = async (b: Broadcast) => {
    try {
      const copy = await apiFetch<Broadcast>(`/broadcasts/${b.id}/duplicate`, {
        method: 'POST',
      });
      toast.success('Campaign duplicated');
      router.push(`/broadcasts/new?id=${copy.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Duplicate failed');
    }
  };

  const submitSchedule = async () => {
    if (!scheduleFor || !scheduleAt) return;
    const iso = new Date(scheduleAt).toISOString();
    if (new Date(iso).getTime() <= Date.now()) {
      toast.error('Pick a future date/time');
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/broadcasts/${scheduleFor.id}/schedule`, {
        method: 'POST',
        body: { runAt: iso },
      });
      toast.success('Broadcast scheduled');
      setScheduleFor(null);
      setScheduleAt('');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Schedule failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <h1 className="text-2xl font-bold text-gray-900 mr-auto">Broadcasts</h1>
        <Link
          href="/broadcasts/new"
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 hover:bg-green-700 px-4 py-2 text-sm text-white font-medium"
        >
          <Plus size={16} /> New broadcast
        </Link>
      </div>

      <div className="flex flex-wrap gap-2 mb-5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium',
              filter === f.key
                ? 'bg-green-600 text-white'
                : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-100',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-center text-gray-400 py-10">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-center text-gray-400 py-16">No broadcasts.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((b) => (
            <div
              key={b.id}
              className="bg-white border border-gray-200 rounded-xl p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 truncate">
                    {b.name}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Created {fmtDateTime(b.created_at)}
                    {b.scheduled_at &&
                      ` · Scheduled ${fmtDateTime(b.scheduled_at)}`}
                  </p>
                </div>
                <StatusPill status={b.status} />
              </div>

              <div className="flex flex-wrap gap-4 mt-3 text-xs text-gray-500">
                <span>Sent {b.sent_count}</span>
                <span>Delivered {b.delivered_count}</span>
                <span>Read {b.read_count}</span>
                <span>Failed {b.failed_count}</span>
              </div>

              <div className="flex flex-wrap gap-2 mt-4">
                {b.status === 'draft' && (
                  <>
                    <button
                      onClick={() =>
                        setConfirmAction({ b, kind: 'send' })
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 hover:bg-green-700 px-3 py-1.5 text-xs text-white font-medium"
                    >
                      <Send size={14} /> Send now
                    </button>
                    <button
                      onClick={() => {
                        setScheduleFor(b);
                        setScheduleAt('');
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                    >
                      <CalendarClock size={14} /> Schedule
                    </button>
                    <button
                      onClick={() =>
                        router.push(`/broadcasts/new?id=${b.id}`)
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                    >
                      <Pencil size={14} /> Edit
                    </button>
                  </>
                )}
                {['draft', 'scheduled', 'sending'].includes(b.status) && (
                  <button
                    onClick={() => setConfirmAction({ b, kind: 'cancel' })}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                  >
                    <Ban size={14} /> Cancel
                  </button>
                )}
                <button
                  onClick={() => openAnalytics(b)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                  <BarChart3 size={14} /> Analytics
                </button>
                <button
                  onClick={() => clone(b)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                  <Copy size={14} /> Clone
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
        <span>Page {page}</span>
        <div className="flex gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-100"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <button
            disabled={rows.length < LIMIT}
            onClick={() => setPage((p) => p + 1)}
            className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 disabled:opacity-40 hover:bg-gray-100"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <Modal
        open={!!analytics}
        onClose={() => setAnalytics(null)}
        title={analytics?.name ?? 'Analytics'}
      >
        {analytics && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <StatusPill status={analytics.status} />
              {analytics.scheduledAt && (
                <span className="text-sm text-gray-500">
                  Scheduled {fmtDateTime(analytics.scheduledAt)}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {[
                ['Audience', analytics.total],
                ['Sent', analytics.sent],
                ['Delivered', analytics.delivered],
                ['Read', analytics.read],
                ['Failed', analytics.failed],
              ].map(([label, v]) => (
                <div
                  key={label as string}
                  className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-center"
                >
                  <p className="text-xl font-bold text-gray-900">
                    {v as number}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">{label}</p>
                </div>
              ))}
            </div>
            {analytics.total > 0 && (
              <div>
                <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                  <div
                    className="h-full bg-green-600"
                    style={{
                      width: `${Math.min(
                        100,
                        ((analytics.sent + analytics.failed) /
                          analytics.total) *
                          100,
                      )}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {analytics.sent + analytics.failed}/{analytics.total}{' '}
                  processed
                </p>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={!!scheduleFor}
        onClose={() => !busy && setScheduleFor(null)}
        title="Schedule broadcast"
        footer={
          <>
            <button
              onClick={() => setScheduleFor(null)}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={submitSchedule}
              disabled={busy || !scheduleAt}
              className="px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50"
            >
              {busy ? 'Scheduling…' : 'Schedule'}
            </button>
          </>
        }
      >
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Send at
        </label>
        <input
          type="datetime-local"
          value={scheduleAt}
          onChange={(e) => setScheduleAt(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
        />
        <p className="text-xs text-gray-400 mt-1">
          Must be in the future. Uses your local timezone.
        </p>
      </Modal>

      <ConfirmDialog
        open={!!confirmAction}
        title={
          confirmAction?.kind === 'send'
            ? 'Send broadcast now'
            : 'Cancel broadcast'
        }
        message={
          confirmAction?.kind === 'send'
            ? `Send "${confirmAction?.b.name}" to its full audience now? This cannot be undone.`
            : `Cancel "${confirmAction?.b.name}"? Pending messages will not be sent.`
        }
        confirmLabel={confirmAction?.kind === 'send' ? 'Send now' : 'Cancel broadcast'}
        danger={confirmAction?.kind === 'cancel'}
        busy={busy}
        onConfirm={doConfirm}
        onCancel={() => !busy && setConfirmAction(null)}
      />
    </div>
  );
}
