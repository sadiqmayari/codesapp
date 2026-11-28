'use client';

import { useEffect, useState } from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { useCommandPalette } from '@/components/app-shell/command-palette';
import { cn, getActiveTimeZone } from '@/lib/utils';
import { ManagerHome, PERIODS, type PeriodKey } from '@/components/dashboard/manager-home';
import { AgentHome } from '@/components/dashboard/agent-home';

function greeting(): string {
  const h = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: getActiveTimeZone() }).format(new Date()),
  );
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function nowLabel(): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: getActiveTimeZone(),
  }).format(new Date());
}

/**
 * Dashboard v3: a router by role. Owner/admin get the business command centre,
 * agents get their own cockpit. Locked roles never land here (layout redirects
 * them to their home module), and the backend enforces the same split.
 */
export default function DashboardPage() {
  const { user } = useAuth();
  const { status } = useSocket();
  const palette = useCommandPalette();
  const isManager = user?.role === 'owner' || user?.role === 'admin';
  const [period, setPeriod] = useState<PeriodKey>('today');
  const [customize, setCustomize] = useState(false);
  const [clock, setClock] = useState('');

  // Period lives in the URL (?period=) so refresh / a shared link keep it.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('period');
    if (p && PERIODS.some((x) => x.key === p)) setPeriod(p as PeriodKey);
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (period === 'today') url.searchParams.delete('period');
    else url.searchParams.set('period', period);
    window.history.replaceState(window.history.state, '', url.toString());
  }, [period]);

  useEffect(() => {
    setClock(nowLabel());
    const t = setInterval(() => setClock(nowLabel()), 30_000);
    return () => clearInterval(t);
  }, []);

  const first = user?.name?.split(' ')[0];
  const live = status === 'connected';

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] font-semibold text-muted">
            <span className={cn('inline-flex items-center gap-1.5 font-extrabold', live ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300')}>
              <span className={cn('h-2 w-2 rounded-full', live ? 'bg-emerald-500 shadow-[0_0_0_4px_rgba(18,183,106,.18)]' : 'bg-amber-500')} />
              {live ? 'Live' : 'Reconnecting'}
            </span>
            {clock && <span>{clock}</span>}
            {user?.company?.name && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{user.company.name}</span>
              </>
            )}
          </div>
          <h1 className="mt-1 text-[28px] font-extrabold tracking-[-.03em] text-ink sm:text-[30px]">
            {greeting()}
            {first ? `, ${first}` : ''}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => palette.open()}
            className="hidden h-10 min-w-[230px] items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3.5 text-[13px] font-semibold text-muted hover:border-emerald-500 md:inline-flex"
          >
            <span className="inline-flex items-center gap-2">
              <Search size={15} aria-hidden="true" /> Search orders, chats, contacts
            </span>
            <kbd className="rounded-md bg-sunken px-1.5 py-0.5 font-mono text-xs">Ctrl K</kbd>
          </button>
          {isManager && (
            <>
              <div role="group" aria-label="Period" className="inline-flex gap-0.5 rounded-xl border border-line bg-surface p-1">
                {PERIODS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    aria-pressed={period === p.key}
                    onClick={() => setPeriod(p.key)}
                    className={cn(
                      'h-8 rounded-lg px-3 text-[13px] font-bold transition-colors',
                      period === p.key ? 'bg-ink text-surface' : 'text-muted hover:bg-sunken hover:text-ink',
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                aria-expanded={customize}
                onClick={() => setCustomize((v) => !v)}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-surface px-3.5 text-[13px] font-bold text-ink hover:border-emerald-500"
              >
                <SlidersHorizontal size={15} aria-hidden="true" /> Customise
              </button>
            </>
          )}
        </div>
      </header>

      {isManager ? (
        <ManagerHome period={period} customizeOpen={customize} onCloseCustomize={() => setCustomize(false)} />
      ) : (
        <AgentHome />
      )}
    </div>
  );
}
