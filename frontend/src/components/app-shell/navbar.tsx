'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Menu,
  Bell,
  LogOut,
  ChevronDown,
  Settings,
  AlertTriangle,
  Phone,
  Search,
  Sun,
  Moon,
  Monitor,
  Truck,
  PackageCheck,
  MessageSquareWarning,
  ArrowRight,
} from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { apiFetch } from '@/lib/api';
import { cn, fmtDateTime, mediaUrl } from '@/lib/utils';
import type { ConversationRow } from '@/lib/inbox-types';
import type { LaneCounts } from '@/lib/couriers';
import {
  getThemePref,
  setThemePref,
  watchSystemTheme,
  type ThemePref,
} from '@/lib/theme';
import { useCommandPalette } from './command-palette';
import { flatNav } from './nav-config';

interface UsageWarning {
  dim: 'contacts' | 'templates';
  threshold: string;
  pct: number;
  current: number;
  limit: number;
  severity: 'warn' | 'critical';
}

interface AlertItem {
  key: string;
  icon: React.ElementType;
  tone: 'amber' | 'red' | 'sky';
  title: string;
  detail: string;
  href: string;
}

const TONE: Record<AlertItem['tone'], string> = {
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700',
  sky: 'bg-sky-100 text-sky-700',
};

export function Navbar({
  onToggleSidebar,
  unread,
  usageSeverity,
}: {
  onToggleSidebar: () => void;
  unread: number;
  /** When 'critical' (≥99%) shows a pulsing chip; 'warn' a static one. */
  usageSeverity?: 'warn' | 'critical' | null;
}) {
  const { user, logout } = useAuth();
  const { status } = useSocket();
  const router = useRouter();
  const palette = useCommandPalette();
  const [menuOpen, setMenuOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [bellTab, setBellTab] = useState<'chats' | 'alerts'>('chats');
  const [bellRows, setBellRows] = useState<ConversationRow[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [bellLoading, setBellLoading] = useState(false);
  const [theme, setTheme] = useState<ThemePref>('light');
  const bellRef = useRef<HTMLDivElement>(null);
  const navHrefs = new Set(flatNav(user).map((n) => n.href));
  const hasInbox = navHrefs.has('/inbox');
  const hasOrders = navHrefs.has('/orders');

  useEffect(() => {
    setTheme(getThemePref());
    return watchSystemTheme();
  }, []);

  // Once the bell is opened, hide the red count until a NEW message bumps the
  // unread total.
  const [seen, setSeen] = useState(false);
  const prevUnread = useRef(unread);
  useEffect(() => {
    if (unread > prevUnread.current) setSeen(false);
    prevUnread.current = unread;
  }, [unread]);

  const [waNumber, setWaNumber] = useState<string | null>(null);
  useEffect(() => {
    if (!user?.company?.id || !hasInbox) return;
    let alive = true;
    apiFetch<{ number: string | null }>('/workspace/whatsapp-number')
      .then((r) => {
        if (alive) setWaNumber(r?.number ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [user?.company?.id, hasInbox]);

  const loadBell = useCallback(async () => {
    setBellLoading(true);
    const [chats, warnings, lanes] = await Promise.allSettled([
      hasInbox
        ? apiFetch<ConversationRow[]>('/inbox/conversations', {
            params: { status: 'unread', limit: 8 },
            noOnboardingRedirect: true,
          })
        : Promise.resolve([] as ConversationRow[]),
      apiFetch<UsageWarning[]>('/billing/usage-warnings', {
        noOnboardingRedirect: true,
      }),
      hasOrders
        ? apiFetch<LaneCounts>('/shipments/queue/lane-counts', {
            noOnboardingRedirect: true,
          })
        : Promise.resolve(null),
    ]);
    setBellRows(
      chats.status === 'fulfilled' && Array.isArray(chats.value) ? chats.value : [],
    );
    const items: AlertItem[] = [];
    if (lanes.status === 'fulfilled' && lanes.value) {
      const l = lanes.value;
      if (l.needsAttention.shipperAdvice > 0)
        items.push({
          key: 'advice',
          icon: MessageSquareWarning,
          tone: 'amber',
          title: `${l.needsAttention.shipperAdvice} parcels awaiting shipper advice`,
          detail: 'The courier needs your instruction',
          href: '/orders/fulfillment',
        });
      const issues = l.needsAttention.total - l.needsAttention.shipperAdvice;
      if (issues > 0)
        items.push({
          key: 'attention',
          icon: AlertTriangle,
          tone: 'red',
          title: `${issues} orders need attention`,
          detail: `${l.needsAttention.addressIssue} address · ${l.needsAttention.failed} failed · ${l.needsAttention.returned} returned`,
          href: '/orders/fulfillment',
        });
      if (l.toBook.confirmed > 0)
        items.push({
          key: 'tobook',
          icon: Truck,
          tone: 'sky',
          title: `${l.toBook.confirmed} confirmed orders to book`,
          detail: `${l.toBook.awaiting} more awaiting confirmation`,
          href: '/orders/fulfillment',
        });
      else if (l.toBook.awaiting > 0)
        items.push({
          key: 'awaiting',
          icon: PackageCheck,
          tone: 'sky',
          title: `${l.toBook.awaiting} orders awaiting confirmation`,
          detail: 'Confirm them to start booking',
          href: '/orders/fulfillment',
        });
    }
    if (warnings.status === 'fulfilled' && Array.isArray(warnings.value)) {
      for (const w of warnings.value) {
        items.push({
          key: `usage:${w.dim}`,
          icon: AlertTriangle,
          tone: w.severity === 'critical' ? 'red' : 'amber',
          title: `${w.dim === 'contacts' ? 'Contacts' : 'Templates'} at ${Math.round(w.pct)}% of your plan`,
          detail: `${w.current.toLocaleString()} / ${w.limit.toLocaleString()}`,
          href: '/billing',
        });
      }
    }
    setAlerts(items);
    setBellLoading(false);
  }, [hasInbox, hasOrders]);

  useEffect(() => {
    if (bellOpen) loadBell();
  }, [bellOpen, loadBell]);

  useEffect(() => {
    if (!bellOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setBellOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBellOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [bellOpen]);

  const onLogout = async () => {
    await logout();
    router.replace('/login');
  };

  const pickTheme = (t: ThemePref) => {
    setTheme(t);
    setThemePref(t);
  };

  const go = (href: string) => {
    setBellOpen(false);
    router.push(href);
  };

  const showChats = hasInbox && bellTab === 'chats';

  return (
    <header className="h-16 shrink-0 bg-white border-b border-gray-200 flex items-center px-3 sm:px-4 gap-2 sm:gap-3">
      <button
        className="w-9 h-9 shrink-0 inline-flex items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 hover:text-gray-900"
        onClick={onToggleSidebar}
        aria-label="Toggle menu"
      >
        <Menu size={20} />
      </button>

      {/* Company (mobile only — the sidebar header shows it on desktop) */}
      {user?.company && (
        <div className="md:hidden flex items-center gap-2 min-w-0">
          {user.company.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={mediaUrl(user.company.logo_url) ?? ''}
              alt={user.company.name}
              className="w-7 h-7 rounded object-contain bg-gray-50 border border-gray-200"
            />
          ) : (
            <span className="w-7 h-7 rounded bg-gray-100 text-gray-600 flex items-center justify-center text-xs font-semibold">
              {user.company.name?.[0]?.toUpperCase() ?? '?'}
            </span>
          )}
          <span className="text-sm font-semibold text-gray-800 truncate max-w-[14ch]">
            {user.company.name}
          </span>
        </div>
      )}

      {/* Search / command palette */}
      <button
        type="button"
        onClick={palette.open}
        className="hidden md:flex items-center gap-2 h-9 w-full max-w-sm px-3 rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-500 hover:border-brand-500 hover:text-gray-700 transition-colors"
        aria-label="Search (Ctrl K)"
      >
        <Search size={16} className="shrink-0" />
        <span className="truncate">
          {hasInbox ? 'Search chats, contacts, orders…' : 'Search pages…'}
        </span>
        <kbd className="ml-auto text-xs font-semibold text-gray-400 border border-gray-200 bg-white rounded px-1.5">
          Ctrl K
        </kbd>
      </button>

      <div
        className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0"
        title={
          status === 'connected'
            ? 'Real-time connection is live'
            : status === 'connecting'
              ? 'Reconnecting…'
              : 'Offline'
        }
      >
        <span
          className={cn(
            'inline-block w-2 h-2 rounded-full',
            status === 'connected' && 'bg-brand-500',
            status === 'connecting' && 'bg-yellow-400',
            status === 'disconnected' && 'bg-red-500',
          )}
          aria-hidden
        />
        <span className="hidden lg:inline">
          {status === 'connected' ? 'Live' : status === 'connecting' ? 'Reconnecting…' : 'Offline'}
        </span>
      </div>

      {waNumber && (
        <span className="hidden xl:flex items-center gap-1 text-xs text-gray-500 shrink-0">
          <Phone size={12} className="text-brand-600" />
          {waNumber}
        </span>
      )}

      {usageSeverity && (
        <Link
          href="/billing"
          title={
            usageSeverity === 'critical'
              ? 'Critical: usage at 99%+ — service may be restricted'
              : 'Warning: usage at 90% of your quota'
          }
          className={cn(
            'inline-flex items-center justify-center w-7 h-7 rounded-full ring-2 ring-offset-1 shrink-0',
            usageSeverity === 'critical'
              ? 'bg-red-100 text-red-700 ring-red-300 animate-pulse'
              : 'bg-amber-100 text-amber-700 ring-amber-200',
          )}
          aria-label="Usage warning"
        >
          <AlertTriangle size={13} />
        </Link>
      )}

      <div className="ml-auto flex items-center gap-1 sm:gap-2 shrink-0">
        <button
          type="button"
          onClick={palette.open}
          className="md:hidden w-9 h-9 inline-flex items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
          aria-label="Search"
        >
          <Search size={19} />
        </button>

        {/* Notification centre */}
        <div className="relative" ref={bellRef}>
          <button
            type="button"
            title="Notifications"
            aria-label={unread > 0 ? `Notifications, ${unread} unread chats` : 'Notifications'}
            aria-expanded={bellOpen}
            onClick={() => {
              setBellOpen((o) => !o);
              setSeen(true);
            }}
            className="relative w-9 h-9 inline-flex items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 hover:text-gray-900"
          >
            <Bell size={20} />
            {unread > 0 && !seen && (
              <span className="absolute top-0.5 right-0.5 bg-red-500 text-white text-[10px] font-semibold rounded-full px-1.5 min-w-[16px] text-center leading-4">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
          {bellOpen && (
            <div className="fixed sm:absolute inset-x-2 sm:inset-x-auto top-16 sm:top-auto sm:right-0 sm:mt-2 sm:w-96 bg-white border border-gray-200 rounded-xl shadow-xl z-50 overflow-hidden">
              <div className="px-4 pt-3 pb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-900">Notifications</span>
                {hasInbox && (
                  <button
                    onClick={() => go('/inbox')}
                    className="text-xs font-semibold text-brand-600 hover:underline"
                  >
                    Open inbox
                  </button>
                )}
              </div>
              <div className="flex gap-1 px-3 pb-2 border-b border-gray-100" role="tablist">
                {hasInbox && (
                  <button
                    role="tab"
                    aria-selected={showChats}
                    onClick={() => setBellTab('chats')}
                    className={cn(
                      'px-3 py-1 rounded-md text-xs font-semibold',
                      showChats ? 'bg-brand-50 text-brand-700' : 'text-gray-500 hover:bg-gray-50',
                    )}
                  >
                    Chats{unread > 0 ? ` · ${unread > 99 ? '99+' : unread}` : ''}
                  </button>
                )}
                <button
                  role="tab"
                  aria-selected={!showChats}
                  onClick={() => setBellTab('alerts')}
                  className={cn(
                    'px-3 py-1 rounded-md text-xs font-semibold',
                    !showChats ? 'bg-brand-50 text-brand-700' : 'text-gray-500 hover:bg-gray-50',
                  )}
                >
                  Alerts{alerts.length > 0 ? ` · ${alerts.length}` : ''}
                </button>
              </div>
              <div className="max-h-96 overflow-y-auto">
                {bellLoading ? (
                  <div className="p-6 flex justify-center">
                    <div className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : showChats ? (
                  bellRows.length === 0 ? (
                    <p className="p-8 text-center text-sm text-gray-500">
                      You&apos;re all caught up.
                    </p>
                  ) : (
                    bellRows.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => go(`/inbox/${r.id}`)}
                        className="w-full text-left px-4 py-2.5 border-b border-gray-50 hover:bg-gray-50 flex gap-3"
                      >
                        <span className="w-9 h-9 shrink-0 rounded-full bg-brand-50 text-brand-700 font-semibold flex items-center justify-center text-sm">
                          {(r.contact?.name || r.contact?.phone || '?')[0]?.toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                          <span className="flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold text-gray-900 truncate">
                              {r.contact?.name || r.contact?.phone || 'Unknown'}
                            </span>
                            {r.unread_count > 0 && (
                              <span className="bg-brand-600 text-white text-[10px] font-semibold rounded-full px-1.5 min-w-[18px] text-center shrink-0">
                                {r.unread_count}
                              </span>
                            )}
                          </span>
                          <span className="text-xs text-gray-500 truncate">
                            {r.last_message || r.contact?.phone}
                          </span>
                          <span className="text-xs text-gray-400">
                            {fmtDateTime(r.last_message_at ?? r.updated_at)}
                          </span>
                        </span>
                      </button>
                    ))
                  )
                ) : alerts.length === 0 ? (
                  <p className="p-8 text-center text-sm text-gray-500">
                    No alerts right now.
                  </p>
                ) : (
                  alerts.map((a) => {
                    const Icon = a.icon;
                    return (
                      <button
                        key={a.key}
                        onClick={() => go(a.href)}
                        className="w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 flex gap-3 items-start"
                      >
                        <span
                          className={cn(
                            'w-9 h-9 shrink-0 rounded-full flex items-center justify-center',
                            TONE[a.tone],
                          )}
                        >
                          <Icon size={16} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-gray-900">
                            {a.title}
                          </span>
                          <span className="block text-xs text-gray-500">{a.detail}</span>
                        </span>
                        <ArrowRight size={14} className="text-gray-300 mt-1 shrink-0" />
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* Account menu */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Account menu"
            aria-expanded={menuOpen}
            className="flex items-center gap-2 text-sm rounded-lg pl-1 pr-1.5 py-1 hover:bg-gray-100"
          >
            <span className="w-8 h-8 rounded-full bg-brand-600 text-white flex items-center justify-center font-semibold">
              {user?.name?.[0]?.toUpperCase() ?? '?'}
            </span>
            <span className="hidden lg:flex flex-col items-start leading-tight">
              <span className="font-semibold text-gray-900">{user?.name}</span>
              <span className="text-xs text-gray-500 capitalize">
                {user?.role?.replace(/_/g, ' ')}
              </span>
            </span>
            <ChevronDown size={16} className="text-gray-400 hidden sm:block" />
          </button>

          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
                aria-hidden
              />
              <div className="absolute right-0 mt-2 w-64 bg-white border border-gray-200 rounded-xl shadow-xl z-20 py-1">
                <div className="px-4 py-2.5 border-b border-gray-100">
                  <p className="text-sm font-semibold text-gray-900 truncate">{user?.name}</p>
                  <p className="text-xs text-gray-500 truncate">{user?.email}</p>
                  <p className="text-xs text-gray-400 capitalize mt-0.5">
                    {user?.role?.replace(/_/g, ' ')}
                  </p>
                </div>
                <div className="px-4 py-2.5 border-b border-gray-100">
                  <p className="text-xs font-semibold text-gray-500 mb-1.5">Theme</p>
                  <div
                    className="grid grid-cols-3 gap-1 bg-gray-100 rounded-lg p-1"
                    role="radiogroup"
                    aria-label="Theme"
                  >
                    {(
                      [
                        ['light', 'Light', Sun],
                        ['dark', 'Dark', Moon],
                        ['system', 'Auto', Monitor],
                      ] as const
                    ).map(([v, label, Icon]) => (
                      <button
                        key={v}
                        role="radio"
                        aria-checked={theme === v}
                        onClick={() => pickTheme(v)}
                        className={cn(
                          'flex items-center justify-center gap-1 rounded-md py-1 text-xs font-semibold',
                          theme === v
                            ? 'bg-white text-gray-900 shadow-sm'
                            : 'text-gray-500 hover:text-gray-800',
                        )}
                      >
                        <Icon size={13} />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <Link
                  href="/settings"
                  onClick={() => setMenuOpen(false)}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Settings size={16} />
                  Settings
                </Link>
                <button
                  onClick={onLogout}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-gray-50"
                >
                  <LogOut size={16} />
                  Log out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
