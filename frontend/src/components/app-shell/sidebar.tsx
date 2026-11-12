'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  MessagesSquare,
  MessageCircle,
  Users,
  FileText,
  Megaphone,
  Bot,
  ShoppingBag,
  Webhook,
  BarChart3,
  Target,
  Trophy,
  CreditCard,
  LifeBuoy,
  Settings,
  Wallet,
  Clapperboard,
  Sparkles,
  Boxes,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/auth-context';

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  enabled: boolean;
  badge?: number;
}

export function Sidebar({
  open,
  onClose,
  unread,
  teamUnread,
}: {
  open: boolean;
  onClose: () => void;
  unread: number;
  teamUnread: number;
}) {
  const pathname = usePathname();
  const { user } = useAuth();
  const isFinance = user?.role === 'finance';
  const isFulfillment = user?.role === 'fulfillment';
  const isContentManager = user?.role === 'content_manager';
  const isPrManager = user?.role === 'pr_manager';
  // Creative executive and social media executive share the same Content + PR
  // access (the social media exec is the junior title, same enforced powers).
  const isCreativeExec =
    user?.role === 'creative_executive' ||
    user?.role === 'social_media_executive';
  const isUploaderRole =
    user?.role === 'videographer' || user?.role === 'graphic_designer';
  // Team-only "member" role: nothing but the Team tab (attendance + chats).
  const isMember = user?.role === 'member';
  const isOwnerAdmin = user?.role === 'owner' || user?.role === 'admin';
  // Content/PR nav in the MAIN list is owner/admin only — agents never see it.
  // (The creative roles reach these via their own dedicated branches above.)
  const contentEnabled = !!user?.company?.contentEnabled && isOwnerAdmin;
  const prEnabled = !!user?.company?.prEnabled && isOwnerAdmin;
  const inventoryEnabled = !!user?.company?.inventoryEnabled && isOwnerAdmin;

  // Close the drawer on navigation only on mobile. On desktop the sidebar is a
  // persistent column the user explicitly toggles — clicking a link must NOT
  // collapse it.
  const handleNavClick = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) onClose();
  };

  // Team (chat + attendance) is for EVERY role — appended to each locked-role
  // nav and shown in the full nav. The matching route allow-list lives in
  // (app)/layout.tsx (SELF_SERVICE_PREFIXES includes /team-chat).
  const teamItem: NavItem = {
    href: '/team-chat',
    label: 'Team',
    icon: MessageCircle,
    enabled: true,
    badge: teamUnread,
  };

  // The finance role is locked to a single read-only Payments view. The
  // fulfillment role is locked to the Orders module (no payments visible there).
  const items: NavItem[] = isMember
    ? [teamItem]
    : isFinance
    ? [{ href: '/finance', label: 'Finance', icon: Wallet, enabled: true }, teamItem]
    : isFulfillment
    ? [{ href: '/orders', label: 'Orders', icon: ShoppingBag, enabled: true }, teamItem]
    : isContentManager
    ? [{ href: '/content', label: 'Content', icon: Clapperboard, enabled: true }, teamItem]
    : isPrManager
    ? [{ href: '/pr', label: 'PR', icon: Sparkles, enabled: true }, teamItem]
    : isCreativeExec
    ? [
        { href: '/content', label: 'Content', icon: Clapperboard, enabled: true },
        { href: '/pr', label: 'PR', icon: Sparkles, enabled: true },
        teamItem,
      ]
    : isUploaderRole
    ? [{ href: '/content', label: 'My tasks', icon: Clapperboard, enabled: true }, teamItem]
    : [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, enabled: true },
    {
      href: '/inbox',
      label: 'Inbox',
      icon: MessagesSquare,
      enabled: true,
      badge: unread,
    },
    teamItem,
    { href: '/contacts', label: 'Contacts', icon: Users, enabled: true },
    { href: '/templates', label: 'Templates', icon: FileText, enabled: true },
    { href: '/broadcasts', label: 'Broadcasts', icon: Megaphone, enabled: true },
    { href: '/bots', label: 'Bots', icon: Bot, enabled: true },
    { href: '/orders', label: 'Orders', icon: ShoppingBag, enabled: true },
    ...(inventoryEnabled
      ? [{ href: '/inventory', label: 'Inventory', icon: Boxes, enabled: true }]
      : []),
    ...(contentEnabled
      ? [{ href: '/content', label: 'Content', icon: Clapperboard, enabled: true }]
      : []),
    ...(prEnabled
      ? [{ href: '/pr', label: 'PR', icon: Sparkles, enabled: true }]
      : []),
    { href: '/tickets', label: 'Tickets', icon: LifeBuoy, enabled: true },
    { href: '/webhooks', label: 'Webhooks', icon: Webhook, enabled: true },
    { href: '/analytics', label: 'Analytics', icon: BarChart3, enabled: true },
    ...(isOwnerAdmin
      ? [{ href: '/ad-report', label: 'Ad Report', icon: Target, enabled: true }]
      : []),
    { href: '/leaderboard', label: 'Leaderboard', icon: Trophy, enabled: true },
    { href: '/billing', label: 'Billing', icon: CreditCard, enabled: true },
  ];

  const settingsActive =
    pathname === '/settings' || pathname.startsWith('/settings/');

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}
      <aside
        aria-label="Main navigation"
        className={cn(
          'fixed z-40 inset-y-0 left-0 w-64 bg-gray-900 text-gray-300 flex flex-col transition-transform',
          // When open, become an in-flow column on desktop (pushes content).
          // When closed, slide fully off-canvas on EVERY breakpoint so desktop
          // can collapse to a hamburger-revealed overlay just like mobile.
          open ? 'translate-x-0 md:static md:z-auto' : '-translate-x-full',
        )}
      >
        <div className="h-16 flex items-center justify-between px-5 border-b border-gray-800">
          <span className="text-white font-bold text-lg">CodesApp</span>
          <button
            className="md:hidden text-gray-400"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
          {items.map((it) => {
            const active =
              pathname === it.href || pathname.startsWith(`${it.href}/`);
            const Icon = it.icon;
            if (!it.enabled) {
              return (
                <div
                  key={it.href}
                  title="Coming soon"
                  className="group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-gray-600 cursor-not-allowed select-none"
                >
                  <Icon size={18} />
                  <span>{it.label}</span>
                  <span className="ml-auto text-xs uppercase tracking-wide text-gray-700">
                    Soon
                  </span>
                </div>
              );
            }
            return (
              <Link
                key={it.href}
                href={it.href}
                onClick={handleNavClick}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-brand-600 text-white'
                    : 'hover:bg-gray-800 hover:text-white',
                )}
              >
                <Icon size={18} />
                <span>{it.label}</span>
                {!!it.badge && it.badge > 0 && (
                  <span className="ml-auto bg-red-500 text-white text-xs rounded-full px-2 py-0.5 min-w-[20px] text-center">
                    {it.badge > 99 ? '99+' : it.badge}
                  </span>
                )}
              </Link>
            );
          })}

          {/* Settings is available to EVERY role — restricted roles see only a
              trimmed Settings page (Profile + Security) so they can edit their
              name and change their password. */}
          <div className="pt-3 mt-3 border-t border-gray-800">
            <Link
              href="/settings"
              onClick={handleNavClick}
              aria-current={settingsActive ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                settingsActive
                  ? 'bg-brand-600 text-white'
                  : 'hover:bg-gray-800 hover:text-white',
              )}
            >
              <Settings size={18} />
              <span>Settings</span>
            </Link>
          </div>
        </nav>

        <div className="px-5 py-4 border-t border-gray-800">
          <p className="text-xs text-gray-500">
            Powered by{' '}
            <a
              href="https://codentra.pk"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-white"
            >
              Codentra
            </a>
          </p>
        </div>
      </aside>
    </>
  );
}
