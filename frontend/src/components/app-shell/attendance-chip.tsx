'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Clock, LogIn, LogOut } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { checkIn, checkOut, fmtClock, fmtHours } from '@/lib/attendance';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useMyToday } from '@/components/team/attendance/use-my-today';

/**
 * Navbar attendance chip — the always-there, never-in-the-way control.
 *  - checked in: "● In · 3h 12m" (flexible staff: "/ 8h"); turns green when the
 *    day's hours are done. Click → popover with Check out.
 *  - not checked in: a small "Check in" chip (only while check-in is open).
 * Flexible staff get ONLY this chip (no reminder bar).
 */
export function AttendanceChip() {
  const a = useMyToday();
  const toast = useToast();
  const [openPop, setOpenPop] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openPop) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenPop(false);
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpenPop(false);
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [openPop]);

  if (!a.tracked || !a.loaded || !a.today) return null;
  const t = a.today;
  const closedToday = a.checkedIn && !a.open;
  if (!a.checkedIn && !a.inWindow) return null;
  if (closedToday && t.dayKind !== 'work' && !t.flexible) return null;

  const punch = async (kind: 'in' | 'out') => {
    setBusy(true);
    try {
      await (kind === 'in' ? checkIn() : checkOut());
      toast.success(kind === 'in' ? 'Checked in' : 'Checked out');
      setOpenPop(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const target = a.requiredMin;
  const pct = target ? Math.min(100, Math.round((a.workedMin / target) * 100)) : null;
  const label = !a.checkedIn
    ? 'Check in'
    : a.open
      ? `In · ${fmtHours(a.workedMin).replace(' 0', ' ')}`
      : `Done · ${fmtHours(a.workedMin)}`;

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpenPop((v) => !v)}
        aria-expanded={openPop}
        aria-label={a.checkedIn ? `Attendance: ${label}` : 'Check in'}
        className={cn(
          'inline-flex items-center gap-2 h-9 rounded-full border px-3 text-xs font-semibold tabular-nums transition-colors',
          !a.checkedIn && 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100',
          a.open && !a.doneForToday && 'border-line bg-surface text-ink hover:bg-sunken',
          a.open && a.doneForToday && 'border-brand-500 bg-brand-50 text-brand-700 hover:bg-brand-100',
          closedToday && 'border-line bg-sunken text-muted',
        )}
      >
        {a.open ? (
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className="absolute inline-flex h-full w-full rounded-full bg-brand-500 opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" />
          </span>
        ) : !a.checkedIn ? (
          <LogIn size={14} aria-hidden />
        ) : (
          <Clock size={14} aria-hidden />
        )}
        <span className="hidden sm:inline">{label}</span>
        {a.open && target && <span className="hidden sm:inline font-medium text-muted">/ {Math.round(target / 60)}h</span>}
      </button>

      {openPop && (
        <div className="absolute right-0 top-11 z-50 w-72 rounded-xl border border-line bg-surface p-4 shadow-xl space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-ink">
              {t.dayKind === 'holiday' ? t.holidayName ?? 'Holiday' : t.dayKind === 'weekly_off' ? 'Day off' : 'Today'}
            </p>
            <span className="flex-1" />
            {t.flexible ? <Badge tone="violet">Flexible</Badge> : <Badge>{t.workStart}–{t.effectiveEnd}</Badge>}
          </div>
          {a.checkedIn ? (
            <>
              <div className="flex text-xs text-muted tabular-nums">
                <span>In {fmtClock(a.rec?.checkInAt ?? null)}</span>
                <span className="flex-1" />
                {a.rec?.checkOutAt ? <span>Out {fmtClock(a.rec.checkOutAt)}</span> : null}
                <b className="ml-2 text-ink">{fmtHours(a.workedMin)}{target ? ` of ${fmtHours(target)}` : ''}</b>
              </div>
              {pct != null && (
                <div className="h-2 rounded-full bg-sunken overflow-hidden" aria-hidden>
                  <div className="h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
                </div>
              )}
              {a.open && (
                <p className="text-xs text-muted">
                  {t.flexible
                    ? `Check out any time. We remind you after ${fmtHours(target)}. If you forget, the day closes itself after ${t.autoCheckout.maxHours}h, credited ${fmtHours(target)}.`
                    : t.autoCheckout.mode === 'off'
                      ? `Shift ends at ${t.effectiveEnd}.`
                      : `Shift ends at ${t.effectiveEnd}. If you forget, the day closes itself at ${t.effectiveEnd}.`}
                </p>
              )}
              {a.rec?.checkoutSource === 'auto' && (
                <p className="text-xs text-amber-700">Closed automatically. Wrong time? Ask for a fix under My attendance.</p>
              )}
            </>
          ) : (
            <p className="text-xs text-muted">
              {t.flexible
                ? 'Flexible schedule: check in whenever you start.'
                : `Shift starts ${t.workStart}${t.graceMinutes ? ` (+${t.graceMinutes} min grace)` : ''}. Check-in open until ${t.checkinCutoff}.`}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Link href="/team-chat?view=attendance&tab=my" className="text-xs font-semibold text-brand-700 hover:underline" onClick={() => setOpenPop(false)}>
              My month
            </Link>
            <span className="flex-1" />
            {!a.checkedIn && (
              <Button size="sm" loading={busy} onClick={() => punch('in')}>
                <LogIn size={14} /> Check in
              </Button>
            )}
            {a.open && (
              <Button size="sm" variant={a.doneForToday ? 'primary' : 'secondary'} loading={busy} onClick={() => punch('out')}>
                <LogOut size={14} /> {a.doneForToday || t.flexible ? 'Check out' : 'Leave early'}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
