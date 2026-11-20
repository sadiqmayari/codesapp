'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, Users } from 'lucide-react';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SkeletonCards } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import {
  downloadAttendanceCsv,
  fmtClock,
  fmtHours,
  getTodayBoard,
  type BoardLane,
  type TodayBoard,
  type TodayPerson,
} from '@/lib/attendance';
import { Avatar, errMsg } from './shared';

const LANES: { key: BoardLane[]; label: string; tone: 'success' | 'warn' | 'info' | 'danger' | 'neutral' }[] = [
  { key: ['in'], label: 'In', tone: 'success' },
  { key: ['late'], label: 'Late', tone: 'warn' },
  { key: ['out'], label: 'Checked out', tone: 'neutral' },
  { key: ['leave', 'off'], label: 'On leave / off', tone: 'info' },
  { key: ['not_in', 'absent'], label: 'Not in', tone: 'danger' },
];

function sinceMin(iso: string | null, end?: string | null) {
  if (!iso) return 0;
  return Math.max(0, Math.round(((end ? new Date(end).getTime() : Date.now()) - new Date(iso).getTime()) / 60000));
}

function PersonCard({ p }: { p: TodayPerson }) {
  let sub = '';
  if (p.lane === 'in' || p.lane === 'late') {
    const w = sinceMin(p.checkInAt);
    sub = `${fmtClock(p.checkInAt)} · ${fmtHours(w)}${p.requiredMinutes ? ` / ${fmtHours(p.requiredMinutes)}` : ''}`;
    if (p.lane === 'late') sub = `${fmtClock(p.checkInAt)} · +${p.lateByMin} min${p.halfDay ? ' · half day' : ''}`;
  } else if (p.lane === 'out') sub = `${fmtClock(p.checkInAt)}–${fmtClock(p.checkOutAt)} · ${fmtHours(sinceMin(p.checkInAt, p.checkOutAt))}`;
  else if (p.lane === 'leave') sub = 'On leave';
  else if (p.lane === 'off') sub = 'Day off';
  else if (p.lane === 'absent') sub = 'Check-in closed';
  else sub = p.flexible ? 'Flexible · not started' : `Shift ${p.start}`;
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface p-2.5">
      <Avatar name={p.name} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink">
          {p.name}
          {p.flexible && <Badge tone="violet" className="ml-1.5 align-middle">Flex</Badge>}
        </p>
        <p className="truncate text-xs text-muted tabular-nums">{sub}</p>
      </div>
      {p.autoClosedYesterday && (
        <span title="Yesterday's day was closed automatically" className="text-xs text-amber-700">
          auto
        </span>
      )}
    </div>
  );
}

export default function TodayBoardTab() {
  const { on } = useSocket();
  const toast = useToast();
  const [board, setBoard] = useState<TodayBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  const load = useCallback(() => {
    getTodayBoard()
      .then((b) => {
        setBoard(b);
        setError(null);
      })
      .catch((e) => setError(errMsg(e, 'Could not load today')));
  }, []);

  useEffect(() => {
    load();
    const off = on('attendance.changed', load);
    const iv = setInterval(() => tick((n) => n + 1), 60_000);
    const refresh = setInterval(load, 5 * 60_000);
    return () => {
      off();
      clearInterval(iv);
      clearInterval(refresh);
    };
  }, [load, on]);

  if (error) return <EmptyState title="Could not load today" description={error} action={<Button onClick={load}>Retry</Button>} />;
  if (!board) return <SkeletonCards count={5} />;
  if (!board.people.length)
    return <EmptyState icon={Users} title="No tracked team members yet" description="Invite your team from Settings → Team." />;

  const count = (keys: BoardLane[]) => board.people.filter((p) => keys.includes(p.lane)).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">
            {new Date(`${board.date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}
          </h2>
          <p className="text-xs text-muted">
            {board.holidayName ? `Holiday: ${board.holidayName} · ` : ''}Updates live as people check in.
          </p>
        </div>
        <span className="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => downloadAttendanceCsv({ from: board.date, to: board.date }).catch((e) => toast.error(errMsg(e)))}
        >
          <Download size={14} /> Export
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {LANES.map((l) => (
          <Card key={l.label} className="p-3">
            <p className="text-xs text-muted">{l.label}</p>
            <p className="text-2xl font-bold tabular-nums text-ink">{count(l.key)}</p>
          </Card>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {LANES.map((l) => {
          const people = board.people.filter((p) => l.key.includes(p.lane));
          return (
            <section key={l.label} className="rounded-xl bg-sunken p-2.5 space-y-2" aria-label={l.label}>
              <h3 className="flex items-center justify-between px-1 text-sm font-semibold text-ink">
                {l.label}
                <Badge tone={l.tone}>{people.length}</Badge>
              </h3>
              {people.length ? people.map((p) => <PersonCard key={p.userId} p={p} />) : <p className="px-1 py-2 text-xs text-muted">Nobody</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
