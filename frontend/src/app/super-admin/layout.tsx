'use client';

import './theme.css';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  Contact as ContactIcon,
  CreditCard,
  Receipt,
  Activity,
  ScrollText,
  Settings,
  ArrowUpCircle,
  LogOut,
  ShieldCheck,
  Menu,
} from 'lucide-react';
import { api, getAccessToken, setAccessToken } from '@/lib/api';
import { SaThemeProvider, SaThemeToggle, useSaTheme } from './_components/sa-theme';

// Grouped sidebar nav. Active-state matches nested routes.
const NAV_GROUPS: {
  group: string;
  items: { href: string; label: string; icon: typeof LayoutDashboard }[];
}[] = [
  {
    group: 'Monitor',
    items: [
      { href: '/super-admin/dashboard', label: 'Overview', icon: LayoutDashboard },
      { href: '/super-admin/clients', label: 'Clients', icon: Users },
      { href: '/super-admin/customers', label: 'Customers', icon: ContactIcon },
      { href: '/super-admin/usage', label: 'Usage', icon: Activity },
    ],
  },
  {
    group: 'Revenue',
    items: [
      { href: '/super-admin/plans', label: 'Plans', icon: CreditCard },
      { href: '/super-admin/billing', label: 'Billing', icon: Receipt },
      { href: '/super-admin/plan-requests', label: 'Upgrades', icon: ArrowUpCircle },
    ],
  },
  {
    group: 'System',
    items: [
      { href: '/super-admin/audit', label: 'Audit log', icon: ScrollText },
      { href: '/super-admin/settings', label: 'Settings', icon: Settings },
    ],
  },
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
    // `router` and `pathname` intentionally NOT deps — see the original note /
    // ERRORS.md "[super-admin] flickering": useRouter()'s identity is unstable
    // in Next 14 and `isLogin` already derives from pathname.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLogin]);

  if (isLogin) return <>{children}</>;
  if (!ready) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f9fafb',
        }}
      >
        <div className="sa-spinner" />
      </div>
    );
  }

  return (
    <SaThemeProvider>
      <Shell pathname={pathname} router={router}>
        {children}
      </Shell>
    </SaThemeProvider>
  );
}

function Shell({
  pathname,
  router,
  children,
}: {
  pathname: string;
  router: ReturnType<typeof useRouter>;
  children: React.ReactNode;
}) {
  const { navOpen, setNavOpen } = useSaTheme();

  // Close the drawer whenever the route changes (mobile).
  useEffect(() => {
    setNavOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const signOut = () => {
    api.post('/super-admin/auth/logout').finally(() => {
      setAccessToken(null);
      router.replace('/super-admin/login');
    });
  };

  return (
    <div className="sa-shell">
      <aside className="sa-rail">
        <div className="sa-rail-head">
          <span className="sa-rail-mark">
            <ShieldCheck size={17} />
          </span>
          <span className="sa-rail-name">
            CodesApp<small>Control plane</small>
          </span>
        </div>
        <nav className="sa-nav">
          {NAV_GROUPS.map((g, gi) => (
            <div key={g.group}>
              {gi > 0 && <div className="sa-nav-sep" />}
              <div className="sa-nav-group">{g.group}</div>
              {g.items.map((n) => {
                const active =
                  pathname === n.href || pathname.startsWith(`${n.href}/`);
                const Icon = n.icon;
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`sa-nav-item${active ? ' active' : ''}`}
                  >
                    <Icon size={18} />
                    <span>{n.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sa-rail-foot">
          Powered by{' '}
          <a href="https://codentra.pk" target="_blank" rel="noopener noreferrer">
            Codentra
          </a>
        </div>
      </aside>
      <div className="sa-scrim" onClick={() => setNavOpen(false)} aria-hidden />

      <div className="sa-main">
        <header className="sa-topbar">
          <button
            className="sa-burger"
            aria-label="Menu"
            onClick={() => setNavOpen(!navOpen)}
          >
            <Menu size={22} />
          </button>
          <div className="sa-live">
            <span className="sa-live-dot" />
            <span>Live</span>
          </div>
          <div className="sa-tb-right">
            <SaThemeToggle />
            <button
              className="sa-btn"
              onClick={signOut}
              title="Sign out"
            >
              <LogOut size={15} />
              <span style={{ fontSize: 13 }}>Sign out</span>
            </button>
          </div>
        </header>
        <main className="sa-main">{children}</main>
      </div>
    </div>
  );
}
