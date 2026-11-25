'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { startAttendanceHeartbeat } from '@/lib/attendance-heartbeat';
import { getMyToday, onAttendanceChanged, tenantHHMM, tenantNowHHMM, toMin, type MyToday } from '@/lib/attendance';

/**
 * ONE source of "my attendance today" for the navbar chip, the reminder bar and
 * the My attendance tab. Refetches on: a check-in/out anywhere in the app, an
 * auto-checkout (socket), window focus, and when the tenant day rolls over (so
 * a forgotten check-out from yesterday never lingers past midnight).
 * `now` ticks every 30 s so live timers and time-gated buttons flip on time.
 */
export function useMyToday() {
  const { user } = useAuth();
  const { on } = useSocket();
  // Not tracked: owner/super-admin, or a workspace without the Attendance module.
  const attendanceOn = user?.company?.modules ? user.company.modules.attendance === true : true;
  const tracked = !!user && attendanceOn && user.role !== 'owner' && user.role !== 'super_admin';
  const [today, setToday] = useState<MyToday | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const dayRef = useRef<string | null>(null);

  const load = useCallback(() => {
    if (!tracked) return;
    getMyToday()
      .then((t) => {
        dayRef.current = t.date;
        setToday(t.excluded ? null : t);
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [tracked]);

  useEffect(() => {
    if (!tracked) return;
    load();
    const off = onAttendanceChanged(load);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    const iv = setInterval(() => {
      setNow(Date.now());
      // Day rollover: past midnight with no open day → reload once.
      const hhmm = tenantNowHHMM();
      if (hhmm === '00:00' || hhmm === '00:01') load();
    }, 30_000);
    return () => {
      off();
      window.removeEventListener('focus', onFocus);
      clearInterval(iv);
    };
  }, [tracked, load]);

  useEffect(() => {
    if (!tracked) return;
    const offAuto = on('attendance.auto_checkout', () => load());
    const offRev = on('attendance.request.reviewed', () => load());
    return () => {
      offAuto();
      offRev();
    };
  }, [tracked, on, load]);

  const rec = today?.record ?? null;
  const checkedIn = !!rec?.checkInAt;
  const open = checkedIn && !rec?.checkOutAt;

  // While the day is open, report app activity so a forgotten check-out is
  // credited at the last activity (extra hours count).
  useEffect(() => {
    if (!tracked || !open) return;
    return startAttendanceHeartbeat();
  }, [tracked, open]);

  // "Lock app after shift end": minutes until the lock (null = no lock ahead).
  const locksInMin = today?.appLocksAt
    ? Math.max(0, Math.round((new Date(today.appLocksAt).getTime() - now) / 60000))
    : null;
  const workedMin =
    rec?.checkInAt != null
      ? Math.max(0, Math.round(((rec.checkOutAt ? new Date(rec.checkOutAt).getTime() : now) - new Date(rec.checkInAt).getTime()) / 60000))
      : 0;
  const nowHHMM = tenantNowHHMM();
  const requiredMin = today?.flexible ? today.requiredMinutes ?? 480 : null;
  // Check-in is offered on WORK days only (working a day off is done from the
  // My attendance tab), and for fixed staff only inside their own window.
  const inWindow =
    !!today &&
    today.dayKind === 'work' &&
    (today.flexible ||
      (toMin(nowHHMM) >= toMin(today.checkinOpensAt) && toMin(nowHHMM) <= toMin(today.checkinCutoff)));
  // Shift over = minutes since THIS shift's start ≥ its length. Measured from the
  // check-in (offset to shift start in −12h..+12h) so night shifts and early
  // arrivals work; a plain clock compare broke for 22:00→06:00 shifts.
  let shiftOver = false;
  if (today && !today.flexible && rec?.checkInAt) {
    const startMin = toMin(today.workStart);
    const len = ((toMin(today.effectiveEnd) - startMin + 1440) % 1440) || 1440;
    const inOffset = ((toMin(tenantHHMM(rec.checkInAt)) - startMin + 1440 + 720) % 1440) - 720;
    shiftOver = inOffset + workedMin >= len;
  }
  const doneForToday = open && (today?.flexible ? workedMin >= (requiredMin ?? 480) : shiftOver);

  return {
    tracked,
    loaded,
    today,
    reload: load,
    now,
    rec,
    checkedIn,
    open,
    workedMin,
    requiredMin,
    inWindow,
    shiftOver,
    doneForToday,
    locksInMin,
  };
}
