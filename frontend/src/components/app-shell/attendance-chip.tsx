'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { Clock, LogIn, LogOut } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { checkIn, checkOut, fmtClock, fmtHours } from '@/lib/attendance';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useMyToday } from '@/components/team/attendance/use-my-today';
import { AnchoredPopover } from '@/components/ui/popover';

type Nudge = 'checkin' | 'checkout' | 'lock' | null;

const seenKey = (date: string, n: Nudge) => `ca_att_seen:${date}:${n}`;
const wasSeen = (date: string, n: Nudge) => {
  try {
    return localStorage.getItem(seenKey(date, n)) === '1';
  } catch {
    return false;
  }
};

/**
 * Navbar attendance chip — the ONE attendance control (the old reminder bar
 * above the navbar duplicated it and was removed, Nov-2026).
 *  - checked in: "● In · 3h 12m" (flexible staff: "/ 8h"); turns green when the
 *    day's hours are done. Click → popover with Check out.
 *  - not checked in: a "Check in" chip (only while check-in is open).
 *  - NUDGES (same rules the bar had): check-in window open and not checked in,
 *    fixed shift over while still checked in, or the app locks within 15 min →
 *    amber chip with a pulsing dot + a short label. Opening the popover once
 *    stops the pulse for that nudge for the rest of the tenant day.
 */
export function AttendanceChip() {
  const a = useMyToday();
  const toast = useToast();
  const [openPop, setOpenPop] = useState(false);
  const [busy, setBusy] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const [, force] = useState(0);

  if (!a.tracked || !a.loaded || !a.today) return null;
  const t = a.today;
  const closedToday = a.checkedIn && !a.open;
  let nudge: Nudge = null;
  if (!t.flexible && t.dayKind === 'work') {
    if (!a.checkedIn && a.inWindow) nudge = 'checkin';
    else if (a.open && a.shiftOver) nudge = 'checkout';
  }
  if (a.locksInMin != null && a.locksInMin <= 15) nudge = 'lock';
  if (!nudge && !a.checkedIn && !a.inWindow) return null;
  if (!nudge && closedToday && t.dayKind !== 'work' && !t.flexible) return null;
  const pulse = !!nudge && !wasSeen(t.date, nudge);

  const toggle = () => {
    if (!openPop && nudge) {
      try {
        localStorage.setItem(seenKey(t.date, nudge), '1');
      } catch {
        /* private mode */
      }
      force((n) => n + 1);
    }
    setOpenPop((v) => !v);
  };

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
  const label = nudge === 'lock'
    ? `Locks in ${a.locksInMin}m`
    : nudge === 'checkout'
      ? 'Shift over · Check out'
      : !a.checkedIn
    ? 'Check in'
    : a.open
      ? `In · ${fmtHours(a.workedMin).replace(' 0', ' ')}`
      : `Done · ${fmtHours(a.workedMin)}`;

  return (
    <div className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-expanded={openPop}
        aria-label={`Attendance: ${label}`}
        className={cn(
          'relative inline-flex items-center gap-2 h-9 rounded-full border px-3 text-xs font-semibold tabular-nums transition-colors',
          nudge || !a.checkedIn
            ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
            : a.open && !a.doneForToday
              ? 'border-line bg-surface text-ink hover:bg-sunken'
              : a.open && a.doneForToday
                ? 'border-brand-500 bg-brand-50 text-brand-700 hover:bg-brand-100'
                : 'border-line bg-sunken text-muted',
        )}
      >
        {pulse && (
          <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5" aria-hidden>
            <span className="absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-75 motion-safe:animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
          </span>
        )}
        {nudge === 'lock' ? (
          <Clock size={14} aria-hidden />
        ) : nudge === 'checkout' ? (
          <LogOut size={14} aria-hidden />
        ) : a.open ? (
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
        {a.open && target && !nudge && <span className="hidden sm:inline font-medium text-muted">/ {Math.round(target / 60)}h</span>}
      </button>

      <AnchoredPopover
        open={openPop}
        onClose={() => setOpenPop(false)}
        anchorRef={btnRef}
        align="end"
        className="w-72 rounded-xl border border-line bg-surface p-4 shadow-xl space-y-3"
      >
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-ink">
              {t.dayKind === 'holiday' ? t.holidayName ?? 'Holiday' : t.dayKind === 'weekly_off' ? 'Day off' : 'Today'}
            </p>
            <span className="flex-1" />
            {t.flexible ? (
              <Badge tone="violet">Flexible</Badge>
            ) : (
              <Badge>
                {t.workStart}–{t.effectiveEnd}
                {t.neverLate ? ' · Relaxed' : ''}
              </Badge>
            )}
          </div>
          {t.requireOfficeNetwork && (
            <p className={cn('rounded-lg px-2.5 py-1.5 text-xs', t.onOfficeNetwork ? 'bg-brand-50 text-brand-700' : 'bg-red-50 text-red-700')}>
              {t.onOfficeNetwork ? `On ${t.onOfficeNetwork}` : 'Not on office WiFi. Connect to an office network to check in or out.'}
            </p>
          )}
          {a.locksInMin != null && a.locksInMin <= 60 && (
            <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
              App locks at {fmtClock(t.appLocksAt ?? null)}{a.locksInMin <= 15 ? ` (in ${a.locksInMin} min)` : ''}.
            </p>
          )}
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
                  {(t.flexible ? `Check out any time. We remind you after ${fmtHours(target)}. ` : `Shift ${a.shiftOver ? 'ended' : 'ends'} at ${t.effectiveEnd}. `) +
                    (t.autoCheckout.mode === 'off'
                      ? 'Remember to check out, a forgotten day needs a fix request.'
                      : t.autoCheckout.creditAt === 'activity'
                        ? 'If you forget, the day closes itself at your last activity in the app.'
                        : t.flexible
                          ? `If you forget, the day closes itself after ${t.autoCheckout.maxHours}h, credited ${fmtHours(target)} or your last activity, whichever is later.`
                          : 'If you forget, the day closes itself at shift end, or your last activity if later.')}
                </p>
              )}
              {(a.rec?.checkoutSource === 'auto' || a.rec?.checkoutSource === 'auto_activity') && (
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
      </AnchoredPopover>
    </div>
  );
}
