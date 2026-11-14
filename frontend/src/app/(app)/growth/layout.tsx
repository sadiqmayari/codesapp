'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { TrendingUp } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';
import { GrowthControlBar, GrowthProvider, useGrowth } from '@/components/growth/growth-filters';
import { AskPanel } from '@/components/growth/insights';

const TABS: Array<[string, string]> = [
  ['/growth', 'Overview'],
  ['/growth/channels', 'Channels'],
  ['/growth/campaigns', 'Campaigns'],
  ['/growth/creatives', 'Creatives'],
  ['/growth/attribution', 'Attribution'],
  ['/growth/customers', 'Customers'],
  ['/growth/forecast', 'Forecast'],
  ['/growth/activity', 'Activity'],
  ['/growth/connections', 'Connections'],
];

const NO_ATTRIBUTION = new Set(['/growth/customers', '/growth/forecast', '/growth/connections', '/growth/activity', '/growth/campaigns/new']);

function Shortcuts() {
  const { filters, set, setAskOpen } = useGrowth();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (e.key === '/') {
        e.preventDefault();
        setAskOpen(true);
      } else if (e.key === 'c' || e.key === 'C') {
        set({ compare: filters.compare === 'none' ? 'prev' : 'none' });
      } else if (e.key === '[' || e.key === ']') {
        // Step the window back / forward by its own length.
        const len = (Date.parse(`${filters.to}T00:00:00Z`) - Date.parse(`${filters.from}T00:00:00Z`)) / 86_400_000 + 1;
        const dir = e.key === '[' ? -1 : 1;
        const sh = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + dir * len * 86_400_000).toISOString().slice(0, 10);
        set({ preset: 'custom', from: sh(filters.from), to: sh(filters.to) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filters, set, setAskOpen]);
  return null;
}

export default function GrowthLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const allowed = user?.role === 'owner' || user?.role === 'admin';

  if (user && !allowed) {
    return (
      <div className="p-6">
        <EmptyState icon={TrendingUp} title="Growth is available to owners and admins" description="Ask an owner or admin for access to ad spend, ROAS and profit." />
      </div>
    );
  }

  const go = (href: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    router.push(`${href}${window.location.search}`);
  };

  return (
    <GrowthProvider>
      <Shortcuts />
      <div className="px-4 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3 pt-4">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-ink">Growth</h1>
            <p className="mt-0.5 text-sm text-muted">Ad spend, revenue and profit across every channel, from click to delivered parcel.</p>
          </div>
        </div>
        <nav aria-label="Growth sections" className="-mx-4 mt-3 flex gap-1 overflow-x-auto border-b border-line px-4 sm:-mx-6 sm:px-6">
          {TABS.map(([href, label]) => {
            const active = href === '/growth' ? pathname === '/growth' : pathname.startsWith(href);
            return (
              <a key={href} href={href} onClick={go(href)} aria-current={active ? 'page' : undefined}
                className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-semibold transition',
                  active ? 'border-brand-600 text-ink' : 'border-transparent text-muted hover:text-ink')}>
                {label}
              </a>
            );
          })}
        </nav>
        {pathname !== '/growth/connections' && pathname !== '/growth/activity' && pathname !== '/growth/campaigns/new' && <GrowthControlBar showAttribution={!NO_ATTRIBUTION.has(pathname)} />}
        <div className="pb-24 pt-4">{children}</div>
      </div>
      <AskPanel />
    </GrowthProvider>
  );
}
