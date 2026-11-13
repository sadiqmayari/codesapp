'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { BarChart3, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { fulfillmentLaneCounts, loadsheetStaging } from '@/lib/couriers';
import {
  OrdersHeaderSlot,
  OrdersHeaderSlotProvider,
} from '@/components/orders/board/header-slot';

/**
 * Orders module shell — ONE header + ONE section tab bar for the whole module
 * (it used to stack route tabs, a pill switcher and loose link-buttons).
 *
 * The board's views (queue / dispatch / replacements / performance / payments)
 * live at `/orders/fulfillment?view=<key>` so Back and shared links work; the
 * other sections are their own routes. Role gating mirrors `(app)/layout.tsx`
 * `isFulfillmentPathAllowed` (fulfillment: no analytics/agent/agents/
 * attribution/abandoned) and the old ViewTabs (payments + agents: owner/admin).
 */

type Tab = {
  key: string;
  label: string;
  href: string;
  /** Count key shown as a badge. */
  count?: 'toBook' | 'dispatch';
  /** Extra path prefixes that also mark this tab active. */
  also?: string[];
};

const BOARD = '/orders/fulfillment';

function isActive(tab: Tab, pathname: string, view: string): boolean {
  const [path, query] = tab.href.split('?');
  if (tab.also?.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return true;
  if (path === BOARD) {
    if (pathname !== BOARD) return false;
    const want = query ? new URLSearchParams(query).get('view') : 'queue';
    return (view || 'queue') === want;
  }
  return pathname === path || pathname.startsWith(`${path}/`);
}

export default function OrdersLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const params = useSearchParams();
  const view = params?.get('view') ?? '';
  const { user } = useAuth();
  const { on } = useSocket();

  const role = user?.role;
  const isFulfillment = role === 'fulfillment';
  const canManage = role === 'owner' || role === 'admin';

  // The full-page order detail (/orders/<no>) is a drill-down — no section tabs.
  const isDetail = /^\/orders\/\d+$/.test(pathname);

  const primary: Tab[] = [
    { key: 'queue', label: 'Orders', href: BOARD, count: 'toBook' },
    { key: 'dispatch', label: 'Dispatch', href: `${BOARD}?view=dispatch`, count: 'dispatch' },
    { key: 'returns', label: 'Returns', href: '/orders/returns', also: [`${BOARD}/receive`] },
    { key: 'replacements', label: 'Replacements', href: `${BOARD}?view=replacements` },
    ...(!isFulfillment
      ? [
          { key: 'abandoned', label: 'Abandoned', href: '/orders/abandoned' },
          { key: 'agent', label: 'Agent orders', href: '/orders/agent' },
        ]
      : []),
  ];
  const secondary: Tab[] = canManage
    ? [{ key: 'payments', label: 'Courier payments', href: `${BOARD}?view=payments` }]
    : [];
  const insights: Tab[] = [
    ...(!isFulfillment ? [{ key: 'analytics', label: 'Analytics', href: '/orders/analytics' }] : []),
    { key: 'performance', label: 'Courier performance', href: `${BOARD}?view=performance` },
    ...(canManage ? [{ key: 'agents', label: 'Agent performance', href: '/orders/agents' }] : []),
    ...(!isFulfillment ? [{ key: 'attribution', label: 'Ad attribution', href: '/orders/attribution' }] : []),
  ];
  const insightActive = insights.find((t) => isActive(t, pathname, view));

  // Live badge counts (best-effort; a failure just hides the badge).
  const [counts, setCounts] = useState<{ toBook?: number; dispatch?: number }>({});
  useEffect(() => {
    if (isDetail) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      Promise.allSettled([fulfillmentLaneCounts(), loadsheetStaging()]).then(([lc, st]) => {
        if (!alive) return;
        setCounts({
          toBook: lc.status === 'fulfilled' ? lc.value.toBook.total : undefined,
          dispatch: st.status === 'fulfilled' ? st.value.totals.total : undefined,
        });
      });
    };
    load();
    // Coalesce bursts of order changes into one refetch.
    const off = on('orders.changed', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 1500);
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [on, isDetail]);

  const [insOpen, setInsOpen] = useState(false);
  const insRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!insOpen) return;
    // The menu renders OUTSIDE insRef (so the overflow-x nav can't clip it), and
    // in the App Router React's event root is `document` itself — a synthetic
    // stopPropagation can't shield this listener. So ignore clicks inside the
    // menu explicitly, else mousedown closes it before the link's click lands.
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (insRef.current?.contains(t as Node) || t?.closest?.('[data-insights-menu]')) return;
      setInsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setInsOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [insOpen]);
  useEffect(() => setInsOpen(false), [pathname, view]);

  if (isDetail) return <>{children}</>;

  const tabCls = (active: boolean) =>
    cn(
      'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-2.5 text-sm font-semibold transition-colors xl:px-3',
      active
        ? 'border-brand-600 text-ink'
        : 'border-transparent text-muted hover:border-line hover:text-ink',
    );
  const badge = (tab: Tab, active: boolean) => {
    const n = tab.count ? counts[tab.count] : undefined;
    if (n == null || n === 0) return null;
    return (
      <span
        className={cn(
          'rounded-full px-1.5 py-px text-xs font-bold tabular-nums',
          active ? 'bg-brand-50 text-brand-700' : 'bg-sunken text-muted',
        )}
      >
        {n.toLocaleString()}
      </span>
    );
  };

  return (
    <OrdersHeaderSlotProvider>
      <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
        <header className="-mx-4 -mt-4 border-b border-line bg-surface px-4 pt-4 sm:-mx-6 sm:-mt-6 sm:px-6 sm:pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-extrabold tracking-tight text-ink">Orders</h1>
            <span className="flex-1" />
            {/* Page actions from the mounted board (Scan / Sync / Create order). */}
            <OrdersHeaderSlot className="flex flex-wrap items-center gap-2" />
          </div>
          <nav aria-label="Orders sections" className="-mb-px mt-3 flex items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {primary.map((t) => {
              const a = isActive(t, pathname, view);
              return (
                <Link key={t.key} href={t.href} aria-current={a ? 'page' : undefined} className={tabCls(a)}>
                  {t.label}
                  {badge(t, a)}
                </Link>
              );
            })}
            {(secondary.length > 0 || insights.length > 0) && (
              <span aria-hidden className="mx-1 mb-2.5 h-5 w-px shrink-0 bg-line" />
            )}
            {secondary.map((t) => {
              const a = isActive(t, pathname, view);
              return (
                <Link key={t.key} href={t.href} aria-current={a ? 'page' : undefined} className={tabCls(a)}>
                  {t.label}
                </Link>
              );
            })}
            {insights.length > 0 && (
              <div ref={insRef} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setInsOpen((o) => !o)}
                  aria-haspopup="menu"
                  aria-expanded={insOpen}
                  className={tabCls(!!insightActive)}
                >
                  <BarChart3 size={15} />
                  {insightActive ? insightActive.label : 'Insights'}
                  <ChevronDown size={14} className={cn('opacity-60 transition-transform', insOpen && 'rotate-180')} />
                </button>
              </div>
            )}
          </nav>
        </header>

        {/* The Insights menu sits outside the overflow-x nav so it isn't clipped. */}
        {insOpen && (
          <InsightsMenu
            anchor={insRef.current}
            items={insights}
            activeKey={insightActive?.key}
          />
        )}

        {children}
      </div>
    </OrdersHeaderSlotProvider>
  );
}

function InsightsMenu({
  anchor,
  items,
  activeKey,
}: {
  anchor: HTMLElement | null;
  items: Tab[];
  activeKey?: string;
}) {
  const r = anchor?.getBoundingClientRect();
  if (!r) return null;
  return (
    <div
      role="menu"
      style={{ left: Math.max(8, Math.min(r.left, window.innerWidth - 232)), top: r.bottom + 4 }}
      data-insights-menu
      className="fixed z-40 w-56 rounded-xl border border-line bg-surface p-1.5 shadow-lg"
    >
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          role="menuitem"
          className={cn(
            'block rounded-lg px-3 py-2 text-sm font-semibold',
            t.key === activeKey ? 'bg-brand-50 text-brand-700' : 'text-ink hover:bg-sunken',
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
