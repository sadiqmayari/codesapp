'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock, LogIn, LogOut, X, Loader2 } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';
import {
  getMyToday,
  checkIn,
  checkOut,
  fmtClock,
  onAttendanceChanged,
  tenantNowHHMM,
  type MyToday,
} from '@/lib/attendance';

type Mode = 'checkin' | 'checkout' | null;

/**
 * Self-contained attendance action bar, mounted beside the navbar in the app
 * shell (mirrors UsageWarningBanner — does NOT touch the onboarding/billing
 * gate). It runs on TENANT time and only ever shows an ACTIONABLE state:
 *  - not checked in & tenant-time ≤ check-in cutoff → a "Check in" button;
 *  - checked in, not out, & tenant-time ≥ shift end (…until 23:59) → "Check out";
 *  - nothing to do (checked out / past cutoff / excluded) → renders nothing.
 * Buttons punch in place and the bar re-reads `myToday`, so it never lingers
 * after you act. Owners/admins also get a toast when a teammate checks in late.
 */
export default function AttendanceReminderBanner() {
  const { user } = useAuth();
  const { on } = useSocket();
  const toast = useToast();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const isOwner = user?.role === 'owner';

  const [today, setToday] = useState<MyToday | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [, setTick] = useState(0); // 60s re-render so time-gated states flip
  const lastModeRef = useRef<Mode>(null);

  const load = useCallback(() => {
    if (!user || isOwner) return;
    getMyToday()
      .then((t) => setToday(t.excluded ? null : t))
      .catch(() => undefined);
  }, [user, isOwner]);

  // Initial load + refresh whenever a check-in/out happens anywhere (panel/bar).
  useEffect(() => {
    load();
    const off = onAttendanceChanged(load);
    const iv = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => {
      off();
      clearInterval(iv);
    };
  }, [load]);

  // Admin late-arrival toast.
  useEffect(() => {
    if (!isAdmin) return;
    const off = on('attendance.late', (p: { name?: string }) => {
      toast.info(`${p?.name ?? 'A teammate'} checked in late`);
    });
    return () => off();
  }, [isAdmin, on, toast]);

  // Resolve the single actionable mode from tenant-local time.
  const mode: Mode = (() => {
    if (!today) return null;
    const rec = today.record;
    const now = tenantNowHHMM();
    if (!rec?.checkInAt) {
      // Opens 30 min before shift start (not at midnight), closes at the cutoff.
      return now >= today.checkinOpensAt && now <= today.checkinCutoff ? 'checkin' : null;
    }
    if (!rec.checkOutAt) {
      // Check-out opens at the effective shift end (checkoutOpensAt), not right
      // after check-in.
      return now >= today.checkoutOpensAt && now <= '23:59' ? 'checkout' : null;
    }
    return null; // already checked out → bar disappears (no "done" banner)
  })();

  // Reset the dismiss when the actionable state changes (so a checkout nudge
  // still appears after a dismissed check-in nudge).
  useEffect(() => {
    if (mode !== lastModeRef.current) {
      lastModeRef.current = mode;
      setDismissed(false);
    }
  }, [mode]);

  if (!mode || dismissed) return null;

  const punch = async (dir: Mode) => {
    if (busy) return;
    setBusy(true);
    try {
      if (dir === 'checkin') await checkIn();
      else await checkOut();
      load();
      toast.success(dir === 'checkin' ? 'Checked in' : 'Checked out');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not record attendance';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const isIn = mode === 'checkin';
  const barCls = isIn
    ? 'border-amber-200 bg-gradient-to-r from-amber-50 to-transparent text-amber-900'
    : 'border-blue-200 bg-gradient-to-r from-blue-50 to-transparent text-blue-900';
  const iconWrap = isIn ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700';

  return (
    <div className={`shrink-0 border-b px-4 py-2.5 flex items-center gap-3 text-sm ${barCls}`}>
      <span className={`shrink-0 grid place-items-center w-8 h-8 rounded-lg ${iconWrap}`}>
        {isIn ? <Clock size={17} /> : <LogOut size={17} />}
      </span>
      <span className="min-w-0 leading-tight">
        <b className="block">{isIn ? "You haven't checked in today" : 'Time to check out'}</b>
        <span className="text-xs opacity-80">
          {isIn
            ? `Shift starts ${today?.workStart} · available until ${today?.checkinCutoff}`
            : `Checked in ${fmtClock(today?.record?.checkInAt ?? null)}${today?.workEnd ? ` · shift ended ${today.workEnd}` : ''}`.trim()}
        </span>
      </span>
      <span className="flex-1" />
      <button
        onClick={() => punch(mode)}
        disabled={busy}
        className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 font-semibold text-white whitespace-nowrap shadow-sm transition disabled:opacity-60 ${
          isIn
            ? 'bg-gradient-to-br from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700'
            : 'bg-gradient-to-br from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700'
        }`}
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : isIn ? <LogIn size={15} /> : <LogOut size={15} />}
        {isIn ? 'Check in now' : 'Check out'}
      </button>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="shrink-0 opacity-50 hover:opacity-80"
      >
        <X size={16} />
      </button>
    </div>
  );
}
