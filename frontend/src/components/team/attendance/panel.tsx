'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/auth-context';
import { getLeaveRequests } from '@/lib/attendance';
import { useSocket } from '@/context/socket-context';
import { cn } from '@/lib/utils';
import TodayBoardTab from './today-board';
import MyAttendanceTab from './my-attendance';
import GridTab from './grid';
import SummaryTab from './summary';
import RequestsTab from './requests';
import PayrollTab from './payroll';
import CommissionsTab from './commissions';
import SettingsTab from './settings';

type Tab = 'today' | 'my' | 'grid' | 'summary' | 'requests' | 'payroll' | 'commissions' | 'settings';

/**
 * Team → Attendance. The sub-tab lives in the URL (`?view=attendance&tab=…`) so
 * every screen is deep-linkable and survives a refresh. Owners aren't tracked,
 * so they have no "My attendance".
 */
export default function AttendancePanel() {
  const { user } = useAuth();
  const { on } = useSocket();
  const router = useRouter();
  const params = useSearchParams();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const isOwner = user?.role === 'owner';
  const [pending, setPending] = useState(0);

  const tabs: { key: Tab; label: string }[] = isAdmin
    ? [
        { key: 'today', label: 'Today' },
        ...(!isOwner ? [{ key: 'my' as Tab, label: 'My attendance' }] : []),
        { key: 'grid', label: 'Daily grid' },
        { key: 'summary', label: 'Summary' },
        { key: 'requests', label: 'Requests' },
        { key: 'payroll', label: 'Payroll' },
        { key: 'commissions', label: 'Commissions' },
        { key: 'settings', label: 'Settings' },
      ]
    : [
        { key: 'my', label: 'My attendance' },
        { key: 'requests', label: 'Leave & fixes' },
      ];
  const fromUrl = params.get('tab') as Tab | null;
  const tab: Tab = fromUrl && tabs.some((t) => t.key === fromUrl) ? fromUrl : tabs[0].key;

  const setTab = (t: Tab) => {
    const q = new URLSearchParams(params.toString());
    q.set('view', 'attendance');
    q.set('tab', t);
    router.replace(`/team-chat?${q.toString()}`, { scroll: false });
  };

  const loadPending = useCallback(() => {
    if (!isAdmin) return;
    getLeaveRequests('pending')
      .then((r) => setPending(r.length))
      .catch(() => undefined);
  }, [isAdmin]);
  useEffect(() => {
    loadPending();
    const off = on('attendance.request', loadPending);
    return () => off();
  }, [loadPending, on]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="sticky top-0 z-10 border-b border-line bg-surface/95 px-3 sm:px-6 backdrop-blur">
        <div role="tablist" aria-label="Attendance" className="flex gap-1 overflow-x-auto py-2 no-scrollbar">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                tab === t.key ? 'bg-brand-50 text-brand-700' : 'text-muted hover:bg-sunken hover:text-ink',
              )}
            >
              {t.label}
              {t.key === 'requests' && pending > 0 && (
                <span className="ml-1.5 rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">{pending}</span>
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="p-3 sm:p-6">
        {tab === 'today' && <TodayBoardTab />}
        {tab === 'my' && <MyAttendanceTab />}
        {tab === 'grid' && <GridTab />}
        {tab === 'summary' && <SummaryTab />}
        {tab === 'requests' && <RequestsTab isAdmin={isAdmin} onChanged={loadPending} />}
        {tab === 'payroll' && <PayrollTab />}
        {tab === 'commissions' && <CommissionsTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}
