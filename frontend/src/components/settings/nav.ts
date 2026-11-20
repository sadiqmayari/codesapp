import type { LucideIcon } from 'lucide-react';
import {
  User,
  Lock,
  Bell,
  Building2,
  Users,
  MapPin,
  Trophy,
  Clock,
  CreditCard,
  MessageCircle,
  ShoppingBag,
  BadgeCheck,
  ShoppingCart,
  Send,
  Truck,
  Sparkles,
  BookOpen,
  Plug,
  UserRound,
  Wand2,
  Headphones,
  Bot,
  BarChart3,
} from 'lucide-react';

/**
 * Settings information architecture — the ONE source of truth for the
 * Settings sub-nav, the `/settings/[section]` route allow-list, settings
 * search and the role gating. Every setting lives in exactly one section.
 *
 * `roles`:
 *   'all'      → every signed-in member (own account only)
 *   'manage'   → owner/admin
 *   'kb'       → owner/admin + agent (knowledge base)
 *   'hr'       → owner/admin + hr_manager (team members, attendance)
 * `href` (instead of a section) = a shortcut to a setting that lives on
 * another page; rendered with a ↗ marker.
 */
export type SettingsSectionId =
  | 'profile'
  | 'security'
  | 'notifications'
  | 'general'
  | 'team'
  | 'tracking'
  | 'competition'
  | 'whatsapp'
  | 'stores'
  | 'confirmation'
  | 'abandoned'
  | 'delivery'
  | 'couriers'
  | 'ai'
  | 'ai-profile'
  | 'ai-skills'
  | 'ai-handoff'
  | 'ai-playground'
  | 'ai-performance'
  | 'knowledge'
  | 'integrations';

type Access = 'all' | 'manage' | 'kb' | 'hr';

export interface SettingsNavItem {
  id: SettingsSectionId | string;
  label: string;
  icon: LucideIcon;
  access: Access;
  /** Extra words for settings search. */
  keywords: string;
  /** External shortcut — navigates away from Settings. */
  href?: string;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'Your account',
    items: [
      { id: 'profile', label: 'Profile', icon: User, access: 'all', keywords: 'name email role' },
      { id: 'security', label: 'Security', icon: Lock, access: 'all', keywords: 'password two-factor 2fa authenticator totp' },
      { id: 'notifications', label: 'Notifications', icon: Bell, access: 'all', keywords: 'sound tone desktop alerts' },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { id: 'general', label: 'General', icon: Building2, access: 'manage', keywords: 'branding logo company timezone clock' },
      { id: 'team', label: 'Team', icon: Users, access: 'hr', keywords: 'members roles invite suspend reassign delete agents' },
      { id: 'tracking', label: 'Tracking page', icon: MapPin, access: 'manage', keywords: 'public tracking link handle' },
      { id: 'competition', label: 'Competition', icon: Trophy, access: 'manage', keywords: 'leaderboard points badges speed bonus gamification' },
      { id: 'attendance', label: 'Attendance & payroll', icon: Clock, access: 'hr', keywords: 'attendance payroll shifts leave salary check-in commission auto-checkout holidays', href: '/team-chat?view=attendance&tab=settings' },
      { id: 'billing', label: 'Billing & plan', icon: CreditCard, access: 'manage', keywords: 'billing invoices plan subscription usage', href: '/billing' },
    ],
  },
  {
    label: 'Channels',
    items: [
      { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle, access: 'manage', keywords: 'numbers meta webhook verify token waba calling sip phone' },
    ],
  },
  {
    label: 'Commerce',
    items: [
      { id: 'stores', label: 'Stores', icon: ShoppingBag, access: 'manage', keywords: 'shopify woocommerce connected store token api version cancelled voided' },
      { id: 'confirmation', label: 'Order confirmation', icon: BadgeCheck, access: 'manage', keywords: 'confirm cancel template tags pending decision window' },
      { id: 'abandoned', label: 'Abandoned carts', icon: ShoppingCart, access: 'manage', keywords: 'abandoned cart recovery checkout webhooks sequence' },
      { id: 'delivery', label: 'Delivery updates', icon: Send, access: 'manage', keywords: 'delivery notifications shipped out for delivery delivered attempted failed cancelled' },
      { id: 'couriers', label: 'Couriers', icon: Truck, access: 'manage', keywords: 'courier trax leopards postex rocket mnp rapidxpk city mapping sync shipper advice' },
    ],
  },
  {
    label: 'AI',
    items: [
      { id: 'ai', label: 'AI assistant', icon: Sparkles, access: 'manage', keywords: 'copilot auto reply auto order quality photos voice notes cap usage' },
      { id: 'ai-profile', label: 'Profile & persona', icon: UserRound, access: 'manage', keywords: 'industry pack persona name tone language currency country payment bank brand store' },
      { id: 'ai-skills', label: 'Skills', icon: Wand2, access: 'manage', keywords: 'skills orders bookings appointments reservations leads capture tools' },
      { id: 'ai-handoff', label: 'Handoff & hours', icon: Headphones, access: 'manage', keywords: 'handoff human agent business hours away message off hours resume' },
      { id: 'knowledge', label: 'Knowledge base', icon: BookOpen, access: 'kb', keywords: 'faq policies products sync knowledge website pdf import' },
      { id: 'ai-playground', label: 'Playground', icon: Bot, access: 'manage', keywords: 'test try chat simulate playground' },
      { id: 'ai-performance', label: 'Performance', icon: BarChart3, access: 'manage', keywords: 'performance metrics handoffs feedback cost results' },
    ],
  },
  {
    label: 'Connect',
    items: [
      { id: 'integrations', label: 'Integrations', icon: Plug, access: 'manage', keywords: 'meta ads google drive outbound webhooks growth' },
    ],
  },
];

/** Roles with the full Settings (everything). */
export function canManageSettings(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function canAccess(item: Pick<SettingsNavItem, 'access'>, role: string | undefined): boolean {
  if (item.access === 'all') return true;
  if (canManageSettings(role)) return true;
  if (item.access === 'kb') return role === 'agent';
  if (item.access === 'hr') return role === 'hr_manager';
  return false;
}

/** Nav groups filtered to what `role` may open (empty groups dropped). */
export function settingsNavFor(role: string | undefined): SettingsNavGroup[] {
  return SETTINGS_NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => canAccess(i, role)),
  })).filter((g) => g.items.length > 0);
}

export function findSection(id: string): SettingsNavItem | undefined {
  for (const g of SETTINGS_NAV) {
    const hit = g.items.find((i) => i.id === id && !i.href);
    if (hit) return hit;
  }
  return undefined;
}

export function defaultSectionFor(role: string | undefined): SettingsSectionId {
  return canManageSettings(role) ? 'general' : 'profile';
}

/** Old `/settings?tab=` values → new sections (keeps existing deep links working). */
export const LEGACY_TAB_MAP: Record<string, SettingsSectionId> = {
  whatsapp: 'whatsapp',
  team: 'team',
  shopify: 'stores',
  courier: 'couriers',
  ai: 'ai',
  'meta-ads': 'integrations',
  competition: 'competition',
  security: 'security',
  profile: 'profile',
};
