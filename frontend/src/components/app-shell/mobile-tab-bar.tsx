'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/auth-context';
import { flatNav, isActivePath, type NavItem } from './nav-config';

/** Preferred tab order; whatever the role can reach fills up to 3 tabs. */
const PRIORITY = ['/inbox', '/orders', '/team-chat', '/dashboard', '/finance', '/content', '/pr'];

/**
 * Mobile bottom tab bar (UI Phase B, < md only). Three role-aware tabs + "More"
 * (opens the sidebar drawer). Rendered as a flex child of the shell column
 * (not position:fixed) so it never covers page content. Hidden inside a chat
 * thread / team chat, where the composer owns the bottom of the screen.
 */
export function MobileTabBar({
  onMore,
  unread,
  teamUnread,
}: {
  onMore: () => void;
  unread: number;
  teamUnread: number;
}) {
  const pathname = usePathname();
  const { user } = useAuth();

  if (/^\/inbox\/[^/]+/.test(pathname) || pathname.startsWith('/team-chat')) {
    return null;
  }

  const nav = flatNav(user);
  const byHref = new Map(nav.map((n) => [n.href, n]));
  const tabs: NavItem[] = [];
  for (const h of PRIORITY) {
    const it = byHref.get(h);
    if (it && tabs.length < 3) tabs.push(it);
  }
  if (tabs.length < 2) return null; // single-module roles: nothing to switch

  const badges = { unread, teamUnread };

  return (
    <nav
      aria-label="Primary"
      className="md:hidden shrink-0 bg-white border-t border-gray-200 grid h-14"
      style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}
    >
      {tabs.map((t) => {
        const active = isActivePath(pathname, t.href);
        const Icon = t.icon;
        const badge = t.badgeKey ? badges[t.badgeKey] : 0;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex flex-col items-center justify-center gap-0.5 text-xs font-semibold',
              active ? 'text-brand-600' : 'text-gray-500',
            )}
          >
            <span className="relative">
              <Icon size={22} />
              {badge > 0 && (
                <span className="absolute -top-1.5 -right-2.5 bg-brand-600 text-white text-[10px] leading-4 rounded-full px-1 min-w-[16px] text-center">
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </span>
            {t.label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMore}
        className="flex flex-col items-center justify-center gap-0.5 text-xs font-semibold text-gray-500"
      >
        <MoreHorizontal size={22} />
        More
      </button>
    </nav>
  );
}
