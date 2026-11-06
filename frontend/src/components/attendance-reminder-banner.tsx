'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Clock, X } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';
import { getMyToday } from '@/lib/attendance';

/**
 * Self-contained attendance reminders, mounted beside the navbar in the app
 * shell (mirrors UsageWarningBanner — does NOT touch the onboarding/billing
 * gate). Two behaviours:
 *  - a trackable member who hasn't checked in today (past their shift start)
 *    sees a dismissible reminder banner;
 *  - owners/admins get a toast when a teammate checks in late.
 */
export default function AttendanceReminderBanner() {
  const { user } = useAuth();
  const { on } = useSocket();
  const toast = useToast();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const isOwner = user?.role === 'owner';
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Member reminder (skip the owner — not tracked).
  useEffect(() => {
    if (!user || isOwner) return;
    let alive = true;
    getMyToday()
      .then((t) => {
        if (!alive || t.excluded || t.record?.checkInAt) return;
        const now = new Date();
        const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (nowHHMM >= t.workStart) setShow(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [user, isOwner]);

  // Admin late-arrival toast.
  useEffect(() => {
    if (!isAdmin) return;
    const off = on('attendance.late', (p: { name?: string }) => {
      toast.info(`${p?.name ?? 'A teammate'} checked in late`);
    });
    return () => off();
  }, [isAdmin, on, toast]);

  if (!show || dismissed) return null;

  return (
    <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 flex items-center justify-between gap-3 text-sm text-amber-800">
      <span className="flex items-center gap-2 min-w-0">
        <Clock size={15} className="shrink-0" />
        <span className="truncate">You haven&apos;t checked in today.</span>
        <Link href="/team-chat" className="font-semibold underline whitespace-nowrap">Check in</Link>
      </span>
      <button onClick={() => setDismissed(true)} aria-label="Dismiss" className="text-amber-500 hover:text-amber-700">
        <X size={16} />
      </button>
    </div>
  );
}
