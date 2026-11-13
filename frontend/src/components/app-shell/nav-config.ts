'use client';

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
  TrendingUp,
  Trophy,
  CreditCard,
  LifeBuoy,
  Settings,
  Wallet,
  Clapperboard,
  Sparkles,
  Boxes,
} from 'lucide-react';
import type { AuthUser } from '@/context/auth-context';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  /** Live count rendered as a badge (inbox unread, team unread). */
  badgeKey?: 'unread' | 'teamUnread';
}

export interface NavSection {
  /** null = no heading (locked roles get one flat list). */
  title: string | null;
  items: NavItem[];
}

const TEAM: NavItem = {
  href: '/team-chat',
  label: 'Team',
  icon: MessageCircle,
  badgeKey: 'teamUnread',
};
export const SETTINGS_ITEM: NavItem = {
  href: '/settings',
  label: 'Settings',
  icon: Settings,
};

/**
 * SINGLE source of truth for the app navigation (sidebar, command palette,
 * mobile tab bar). Role gating mirrors the route allow-lists in
 * `(app)/layout.tsx` — a locked role only ever sees its home module + Team
 * (+ Settings, appended by consumers). Keep the two in sync.
 */
export function buildNav(user: AuthUser | null): NavSection[] {
  const role = user?.role;
  const flat = (items: NavItem[]): NavSection[] => [{ title: null, items }];

  if (role === 'member') return flat([TEAM]);
  if (role === 'finance')
    return flat([{ href: '/finance', label: 'Finance', icon: Wallet }, TEAM]);
  if (role === 'fulfillment')
    return flat([{ href: '/orders', label: 'Orders', icon: ShoppingBag }, TEAM]);
  if (role === 'content_manager')
    return flat([
      { href: '/content', label: 'Content', icon: Clapperboard },
      TEAM,
    ]);
  if (role === 'pr_manager')
    return flat([{ href: '/pr', label: 'PR', icon: Sparkles }, TEAM]);
  if (role === 'creative_executive' || role === 'social_media_executive')
    return flat([
      { href: '/content', label: 'Content', icon: Clapperboard },
      { href: '/pr', label: 'PR', icon: Sparkles },
      TEAM,
    ]);
  if (role === 'videographer' || role === 'graphic_designer')
    return flat([
      { href: '/content', label: 'My tasks', icon: Clapperboard },
      TEAM,
    ]);

  const isOwnerAdmin = role === 'owner' || role === 'admin';
  // Content/PR/Inventory in the main nav are owner/admin only.
  const contentEnabled = !!user?.company?.contentEnabled && isOwnerAdmin;
  const prEnabled = !!user?.company?.prEnabled && isOwnerAdmin;
  const inventoryEnabled = !!user?.company?.inventoryEnabled && isOwnerAdmin;

  const sections: NavSection[] = [
    {
      title: 'Conversations',
      items: [
        { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
        {
          href: '/inbox',
          label: 'Inbox',
          icon: MessagesSquare,
          badgeKey: 'unread',
        },
        TEAM,
        { href: '/contacts', label: 'Contacts', icon: Users },
      ],
    },
    {
      title: 'Commerce',
      items: [
        { href: '/orders', label: 'Orders', icon: ShoppingBag },
        ...(inventoryEnabled
          ? [{ href: '/inventory', label: 'Inventory', icon: Boxes }]
          : []),
        { href: '/tickets', label: 'Tickets', icon: LifeBuoy },
      ],
    },
    {
      title: 'Growth',
      items: [
        ...(isOwnerAdmin ? [{ href: '/growth', label: 'Growth', icon: TrendingUp }] : []),
        { href: '/templates', label: 'Templates', icon: FileText },
        { href: '/broadcasts', label: 'Broadcasts', icon: Megaphone },
        { href: '/bots', label: 'Bots', icon: Bot },
        ...(contentEnabled
          ? [{ href: '/content', label: 'Content', icon: Clapperboard }]
          : []),
        ...(prEnabled ? [{ href: '/pr', label: 'PR', icon: Sparkles }] : []),
      ],
    },
    {
      title: 'Insights',
      items: [
        { href: '/analytics', label: 'Analytics', icon: BarChart3 },
        { href: '/leaderboard', label: 'Leaderboard', icon: Trophy },
      ],
    },
    {
      title: 'Workspace',
      items: [
        { href: '/webhooks', label: 'Webhooks', icon: Webhook },
        { href: '/billing', label: 'Billing', icon: CreditCard },
      ],
    },
  ];
  return sections;
}

/** Flattened nav (+ Settings) — for the palette and the mobile tab bar. */
export function flatNav(user: AuthUser | null): NavItem[] {
  return [...buildNav(user).flatMap((s) => s.items), SETTINGS_ITEM];
}

export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Roles that get the WhatsApp inbox (palette chat/contact search). */
export function hasInbox(user: AuthUser | null): boolean {
  const r = user?.role;
  return r === 'owner' || r === 'admin' || r === 'agent';
}
