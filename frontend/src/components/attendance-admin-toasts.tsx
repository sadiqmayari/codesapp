'use client';

import { useEffect } from 'react';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';

/**
 * Headless: toasts owners/admins/HR about late arrivals and new attendance
 * requests. Renders nothing.
 *
 * (It used to be the attendance reminder BAR above the navbar. That bar showed
 * the same Check in / Check out action as the navbar chip, so staff saw it
 * twice — the navbar `AttendanceChip` is now the ONE attendance control and
 * carries the nudges itself.)
 */
export default function AttendanceAdminToasts() {
  const { user } = useAuth();
  const { on } = useSocket();
  const toast = useToast();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin' || user?.role === 'hr_manager';

  useEffect(() => {
    if (!isAdmin) return;
    const off1 = on('attendance.late', (p: { name?: string }) => toast.info(`${p?.name ?? 'A teammate'} checked in late`));
    const off2 = on('attendance.request', () => toast.info('New attendance request waiting for review'));
    return () => {
      off1();
      off2();
    };
  }, [isAdmin, on, toast]);

  return null;
}
