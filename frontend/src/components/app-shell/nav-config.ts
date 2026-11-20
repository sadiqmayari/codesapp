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
  PackageCheck,
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

  const mods = user?.company?.modules ?? null;
  // A module the super-admin hasn't granted is hidden. `null` (old /auth/me) = show.
  const has = (k: string) => (mods ? mods[k] === true : true);

  if (role === 'hr_manager') return flat([TEAM]);
  if (role === 'member')
    return flat([TEAM, ...(has('pack') ? [{ href: '/orders/pack', label: 'Pack station', icon: PackageCheck }] : [])]);
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
        ...(has('tickets') ? [{ href: '/tickets', label: 'Tickets', icon: LifeBuoy }] : []),
      ],
    },
    {
      title: 'Growth',
      items: [
        ...(isOwnerAdmin && has('growth') ? [{ href: '/growth', label: 'Growth', icon: TrendingUp }] : []),
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
        ...(isOwnerAdmin ? [{ href: '/analytics', label: 'Analytics', icon: BarChart3 }] : []),
        ...(has('leaderboard') ? [{ href: '/leaderboard', label: 'Leaderboard', icon: Trophy }] : []),
      ],
    },
    {
      title: 'Workspace',
      items: [
        ...(isOwnerAdmin
          ? [
              { href: '/webhooks', label: 'Webhooks', icon: Webhook },
              { href: '/billing', label: 'Billing', icon: CreditCard },
            ]
          : []),
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

// ── Role → route access (the ONE rule; (app)/layout.tsx enforces it) ────────

/** Paths every role may reach: own account settings + Team (chat, attendance). */
const SELF_SERVICE_PREFIXES = ['/settings', '/team-chat'];
const under = (p: string, b: string) => p === b || p.startsWith(`${b}/`);
export function isSelfServicePath(p: string): boolean {
  return SELF_SERVICE_PREFIXES.some((b) => under(p, b));
}

// Orders subpages the fulfillment role must NOT reach (money aggregates).
const FULFILLMENT_BLOCKED_ORDER_PATHS = [
  '/orders/analytics',
  '/orders/agent',
  '/orders/agents',
  '/orders/attribution',
  '/orders/abandoned',
];

export interface LockedAccess {
  /** Where a blocked path redirects. */
  home: string;
  allowed: (path: string) => boolean;
}

/**
 * Locked roles: their home + allow-list. `null` = a full-nav role (owner,
 * admin, agent) that goes through the normal onboarding gate.
 */
export function lockedAccessFor(role: string | undefined): LockedAccess | null {
  const self = (p: string) => isSelfServicePath(p);
  switch (role) {
    case 'finance':
      return { home: '/finance', allowed: (p) => self(p) || under(p, '/finance') };
    case 'fulfillment':
      return {
        home: '/orders',
        allowed: (p) =>
          self(p) ||
          (under(p, '/orders') && !FULFILLMENT_BLOCKED_ORDER_PATHS.some((b) => under(p, b))),
      };
    case 'content_manager':
    case 'videographer':
    case 'graphic_designer':
      return { home: '/content', allowed: (p) => self(p) || under(p, '/content') };
    case 'pr_manager':
      return { home: '/pr', allowed: (p) => self(p) || under(p, '/pr') };
    case 'creative_executive':
    case 'social_media_executive':
      return { home: '/content', allowed: (p) => self(p) || under(p, '/content') || under(p, '/pr') };
    case 'member':
      // Warehouse packers are often members.
      return { home: '/team-chat', allowed: (p) => self(p) || p === '/orders/pack' };
    case 'hr_manager':
      return { home: '/team-chat', allowed: (p) => self(p) };
    default:
      return null;
  }
}

/** Route prefix → the super-admin module grant it needs. */
export const MODULE_ROUTES: { prefix: string; module: string; label: string }[] = [
  { prefix: '/growth', module: 'growth', label: 'Growth' },
  { prefix: '/inventory', module: 'inventory', label: 'Inventory' },
  { prefix: '/content', module: 'content', label: 'Content' },
  { prefix: '/pr', module: 'pr', label: 'PR' },
  { prefix: '/leaderboard', module: 'leaderboard', label: 'Leaderboard' },
  { prefix: '/tickets', module: 'tickets', label: 'Tickets' },
  { prefix: '/orders/pack', module: 'pack', label: 'Pack station' },
];

/** The module a path needs that this workspace hasn't been granted, if any. */
export function blockedModuleFor(
  path: string,
  modules: Record<string, boolean> | null | undefined,
): { module: string; label: string } | null {
  if (!modules) return null;
  const hit = MODULE_ROUTES.find((r) => under(path, r.prefix));
  if (!hit || modules[hit.module] === true) return null;
  return { module: hit.module, label: hit.label };
}
