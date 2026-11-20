'use client';

import { useEffect, useState } from 'react';
import { BellRing, LogIn, LogOut, X } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { checkIn, checkOut } from '@/lib/attendance';
import { Button } from '@/components/ui/button';
import { useMyToday } from '@/components/team/attendance/use-my-today';

type Mode = 'checkin' | 'checkout' | null;

const dismissKey = (date: string, mode: Mode) => `ca_att_dismiss:${date}:${mode}`;
const isDismissed = (date: string, mode: Mode) => {
  try {
    return localStorage.getItem(dismissKey(date, mode)) === '1';
  } catch {
    return false;
  }
};

/**
 * Reminder bar above the navbar — FIXED-shift staff only (flexible staff use the
 * navbar chip and are never nagged). Shows at most one nudge:
 *  - "You haven't checked in" while the check-in window is open, or
 *  - "Your shift has ended" once the shift end passes and the day is still open.
 * Dismissing hides that nudge for the rest of the tenant day (remembered on this
 * device). Admins also get toasts for late arrivals and new requests.
 */
export default function AttendanceReminderBanner() {
  const { user } = useAuth();
  const { on } = useSocket();
  const toast = useToast();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin' || user?.role === 'hr_manager';
  const a = useMyToday();
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);

  useEffect(() => {
    if (!isAdmin) return;
    const off1 = on('attendance.late', (p: { name?: string }) => toast.info(`${p?.name ?? 'A teammate'} checked in late`));
    const off2 = on('attendance.request', () => toast.info('New attendance request waiting for review'));
    return () => {
      off1();
      off2();
    };
  }, [isAdmin, on, toast]);

  const t = a.today;
  let mode: Mode = null;
  if (t && !t.flexible && t.dayKind === 'work') {
    if (!a.checkedIn && a.inWindow) mode = 'checkin';
    else if (a.open && a.shiftOver) mode = 'checkout';
  }
  if (!t || !mode || isDismissed(t.date, mode)) return null;

  const punch = async () => {
    setBusy(true);
    try {
      await (mode === 'checkin' ? checkIn() : checkOut());
      toast.success(mode === 'checkin' ? 'Checked in' : 'Checked out');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  const dismiss = () => {
    try {
      localStorage.setItem(dismissKey(t.date, mode), '1');
    } catch {
      /* private mode */
    }
    force((n) => n + 1);
  };

  const checkinText = `You haven't checked in. Shift starts ${t.workStart}${t.graceMinutes ? ` (+${t.graceMinutes} min grace)` : ''}, check-in closes ${t.checkinCutoff}.`;
  const checkoutText =
    t.autoCheckout.mode === 'off'
      ? `Your shift ended at ${t.effectiveEnd}. Remember to check out.`
      : `Your shift ended at ${t.effectiveEnd}. Check out now, or the day closes itself at ${t.effectiveEnd}.`;

  return (
    <div
      role="status"
      className={
        mode === 'checkin'
          ? 'shrink-0 flex items-center gap-3 px-4 py-2 text-sm bg-amber-50 text-amber-900 border-b border-amber-200'
          : 'shrink-0 flex items-center gap-3 px-4 py-2 text-sm bg-sky-50 text-sky-900 border-b border-sky-200'
      }
    >
      <BellRing size={16} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{mode === 'checkin' ? checkinText : checkoutText}</span>
      <Button size="sm" loading={busy} onClick={punch}>
        {mode === 'checkin' ? <LogIn size={14} /> : <LogOut size={14} />}
        {mode === 'checkin' ? 'Check in' : 'Check out'}
      </Button>
      <button type="button" onClick={dismiss} aria-label="Hide for today" className="p-1 rounded hover:bg-black/5">
        <X size={16} />
      </button>
    </div>
  );
}
