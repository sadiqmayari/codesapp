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
  LogOut,
} from 'lucide-react';
import { api, getAccessToken, setAccessToken } from '@/lib/api';
import { cn } from '@/lib/utils';

// Single token-presence gate for the super-admin area. The real credential
// check happens when a page calls the API and 401s (each page handles its
// own data-load failure). /super-admin/login is rendered bare (no gate, no
// chrome) so the gate never traps the login screen.
const NAV = [
  { href: '/super-admin/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/super-admin/clients', label: 'Clients', icon: Users },
  { href: '/super-admin/plans', label: 'Plans', icon: CreditCard },
  { href: '/super-admin/billing', label: 'Billing', icon: Receipt },
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
    // No in-memory token (reload/revisit) — try to rehydrate from the
    // httpOnly sa_refresh_token cookie before bouncing to login.
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
  }, [isLogin, pathname, router]);

  if (isLogin) return <>{children}</>;
  if (!ready) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <p className="text-white">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      <header className="border-b border-gray-800 px-4 sm:px-8 py-4 flex items-center gap-6">
        <div className="mr-auto">
          <h1 className="text-lg font-bold">CodesApp Super Admin</h1>
          <p className="text-gray-400 text-xs">Platform control</p>
        </div>
        <nav className="flex items-center gap-1">
          {NAV.map((n) => {
            const active =
              pathname === n.href || pathname.startsWith(`${n.href}/`);
            const Icon = n.icon;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-green-600 text-white'
                    : 'text-gray-300 hover:bg-gray-800 hover:text-white',
                )}
              >
                <Icon size={16} />
                <span className="hidden sm:inline">{n.label}</span>
              </Link>
            );
          })}
          <button
            onClick={() => {
              api
                .post('/auth/logout')
                .finally(() => router.push('/super-admin/login'));
            }}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-400 hover:text-white"
          >
            <LogOut size={16} />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </nav>
      </header>
      <main className="flex-1 p-4 sm:p-8">{children}</main>
    </div>
  );
}
