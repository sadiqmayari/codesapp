'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  CreditCard,
  Receipt,
  Activity,
  ScrollText,
  Settings,
  ArrowUpCircle,
  LogOut,
  ShieldCheck,
} from 'lucide-react';
import { api, getAccessToken, setAccessToken } from '@/lib/api';
import { cn } from '@/lib/utils';

// Light-themed control plane chrome — modern card layout, sticky top nav,
// brand chip on the left. /super-admin/login is rendered bare (no chrome).
// Token-presence gate stays; each page still handles its own 401 → /login.
const NAV = [
  { href: '/super-admin/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/super-admin/clients', label: 'Clients', icon: Users },
  { href: '/super-admin/plans', label: 'Plans', icon: CreditCard },
  { href: '/super-admin/billing', label: 'Billing', icon: Receipt },
  {
    href: '/super-admin/plan-requests',
    label: 'Upgrades',
    icon: ArrowUpCircle,
  },
  { href: '/super-admin/usage', label: 'Usage', icon: Activity },
  { href: '/super-admin/audit', label: 'Audit', icon: ScrollText },
  { href: '/super-admin/settings', label: 'Settings', icon: Settings },
];

export default function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === '/super-admin/login';
  const [ready, setReady] = useState(isLogin);

  useEffect(() => {
    if (isLogin) {
      setReady(true);
      return;
    }
    if (getAccessToken()) {
      setReady(true);
      return;
    }
    let cancelled = false;
    api
      .post<{ data: { accessToken: string } }>('/super-admin/auth/refresh')
      .then((res) => {
        if (cancelled) return;
        setAccessToken(res.data.data.accessToken);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) router.replace('/super-admin/login');
      });
    return () => {
      cancelled = true;
    };
    // `router` is intentionally NOT a dep — useRouter() from next/navigation
    // returns a fresh wrapper object on every render in some Next 14 minor
    // versions, which would re-fire this effect every render and produce the
    // "loader keeps spinning + page flickers" symptom. `pathname` is also
    // dropped: `isLogin` already derives from it, so re-running on any other
    // sub-route is wasted work. See ERRORS.md "[super-admin] flickering".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLogin]);

  if (isLogin) return <>{children}</>;
  if (!ready) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800 flex flex-col">
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
          <Link
            href="/super-admin/dashboard"
            className="flex items-center gap-2 mr-auto"
          >
            <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center text-white shadow-sm">
              <ShieldCheck size={16} />
            </span>
            <span className="flex flex-col leading-tight">
              <span className="font-semibold text-gray-900">CodesApp</span>
              <span className="text-[10px] text-gray-500 -mt-0.5">
                Super-admin control plane
              </span>
            </span>
          </Link>
          <nav className="hidden md:flex items-center gap-0.5">
            {NAV.map((n) => {
              const active =
                pathname === n.href || pathname.startsWith(`${n.href}/`);
              const Icon = n.icon;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    active
                      ? 'bg-green-600 text-white shadow-sm'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                  )}
                >
                  <Icon size={15} />
                  <span>{n.label}</span>
                </Link>
              );
            })}
          </nav>
          <button
            onClick={() => {
              api
                .post('/super-admin/auth/logout')
                .finally(() => {
                  setAccessToken(null);
                  router.replace('/super-admin/login');
                });
            }}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors"
            title="Sign out"
          >
            <LogOut size={15} />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
        {/* Mobile-only horizontal nav */}
        <nav className="md:hidden flex overflow-x-auto px-2 pb-2 gap-1 border-t border-gray-100">
          {NAV.map((n) => {
            const active =
              pathname === n.href || pathname.startsWith(`${n.href}/`);
            const Icon = n.icon;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  'shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium',
                  active
                    ? 'bg-green-600 text-white'
                    : 'text-gray-600 hover:bg-gray-100',
                )}
              >
                <Icon size={13} />
                {n.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
