'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarCheck } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { getTodaySummary, type TodaySummary } from '@/lib/attendance';

/**
 * Owner/admin "today's attendance" snapshot for the dashboard. Self-contained:
 * renders nothing for other roles or on any error (the endpoint is owner/admin).
 */
export default function AttendanceTodayTile() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const [s, setS] = useState<TodaySummary | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    getTodaySummary().then(setS).catch(() => undefined);
  }, [isAdmin]);

  if (!isAdmin || !s) return null;

  const cells: { label: string; value: number; cls: string }[] = [
    { label: 'present', value: s.present, cls: 'text-green-700' },
    { label: 'late', value: s.late, cls: 'text-amber-600' },
    { label: 'absent', value: s.absent, cls: 'text-red-600' },
    { label: 'not checked in', value: s.notCheckedIn, cls: 'text-gray-400' },
  ];

  return (
    <Link
      href="/team-chat"
      className="mb-4 block rounded-2xl border border-gray-200 bg-white p-4 hover:border-green-300 transition"
    >
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-gray-500">
        <CalendarCheck size={14} className="text-green-600" /> Attendance · Today
      </p>
      <div className="flex flex-wrap gap-6 text-sm">
        {cells.map((c) => (
          <div key={c.label}>
            <span className={`text-2xl font-bold ${c.cls}`}>{c.value}</span>
            <span className="ml-1 text-gray-500">{c.label}</span>
          </div>
        ))}
      </div>
    </Link>
  );
}
