'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronsLeft, ChevronsRight, X } from 'lucide-react';
import { cn, mediaUrl } from '@/lib/utils';
import { useAuth } from '@/context/auth-context';
import {
  buildNav,
  isActivePath,
  SETTINGS_ITEM,
  type NavItem,
} from './nav-config';

const COLLAPSE_KEY = 'ca_sidebar_collapsed';

/**
 * App sidebar (UI Phase B): grouped sections, desktop collapse-to-icons
 * (remembered per device), workspace header + user card. The nav itself comes
 * from `nav-config.ts` (shared with the command palette + mobile tab bar).
 *
 * `open` keeps its old meaning: closed = slid fully off-canvas (mobile drawer
 * or desktop hidden via the navbar hamburger). Desktop clicks never close it.
 */
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
  const sections = buildNav(user);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* storage unavailable */
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  // Close the drawer on navigation only on mobile.
  const handleNavClick = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) onClose();
  };

  const badges = { unread, teamUnread };

  const renderItem = (it: NavItem) => {
    const active = isActivePath(pathname, it.href);
    const Icon = it.icon;
    const badge = it.badgeKey ? badges[it.badgeKey] : 0;
    return (
      <Link
        key={it.href}
        href={it.href}
        onClick={handleNavClick}
        aria-current={active ? 'page' : undefined}
        title={collapsed ? it.label : undefined}
        className={cn(
          'relative flex items-center gap-3 rounded-lg text-sm transition-colors',
          collapsed ? 'md:justify-center md:px-0 md:h-10 px-3 py-2' : 'px-3 py-2',
          active
            ? 'bg-brand-50 text-brand-700 font-semibold'
            : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
        )}
      >
        {active && (
          <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-brand-600" />
        )}
        <Icon size={18} className="shrink-0" />
        <span className={cn('truncate', collapsed && 'md:hidden')}>
          {it.label}
        </span>
        {badge > 0 && (
          <span
            className={cn(
              'bg-brand-600 text-white text-xs font-semibold rounded-full min-w-[20px] px-1.5 text-center',
              collapsed
                ? 'ml-auto md:ml-0 md:absolute md:top-1 md:right-1.5 md:min-w-[16px] md:px-1 md:text-[10px] md:leading-4'
                : 'ml-auto',
            )}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </Link>
    );
  };

  const company = user?.company;

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
          'fixed z-40 inset-y-0 left-0 w-64 bg-white border-r border-gray-200 flex flex-col transition-[transform,width] duration-200',
          collapsed && 'md:w-[68px]',
          open ? 'translate-x-0 md:static md:z-auto' : '-translate-x-full',
        )}
      >
        {/* Workspace header */}
        <div
          className={cn(
            'h-16 shrink-0 flex items-center gap-2.5 border-b border-gray-100',
            collapsed ? 'px-4 md:px-0 md:justify-center' : 'px-4',
          )}
        >
          {company?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={mediaUrl(company.logo_url) ?? ''}
              alt=""
              className="w-9 h-9 rounded-lg object-contain bg-gray-50 border border-gray-200 shrink-0"
            />
          ) : (
            <span className="w-9 h-9 rounded-lg bg-brand-600 text-white flex items-center justify-center font-bold shrink-0">
              {(company?.name?.[0] ?? 'C').toUpperCase()}
            </span>
          )}
          <div className={cn('min-w-0 leading-tight', collapsed && 'md:hidden')}>
            <p className="text-sm font-bold text-gray-900 truncate">
              {company?.name ?? 'CodesApp'}
            </p>
            <p className="text-xs text-gray-500">CodesApp</p>
          </div>
          <button
            className="ml-auto md:hidden text-gray-400 hover:text-gray-700"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-3 flex flex-col gap-4">
          {sections.map((s, i) => (
            <div key={s.title ?? i} className="flex flex-col gap-0.5">
              {s.title && (
                <p
                  className={cn(
                    'px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-gray-400',
                    collapsed && 'md:hidden',
                  )}
                >
                  {s.title}
                </p>
              )}
              {s.title && collapsed && (
                <div className="hidden md:block mx-3 mb-1 border-t border-gray-100" />
              )}
              {s.items.map(renderItem)}
            </div>
          ))}
          <div className="flex flex-col gap-0.5 pt-3 border-t border-gray-100">
            {renderItem(SETTINGS_ITEM)}
          </div>
        </nav>

        {/* User card + collapse */}
        <div
          className={cn(
            'shrink-0 border-t border-gray-100 p-3 flex items-center gap-2.5',
            collapsed && 'md:flex-col md:gap-2',
          )}
        >
          <span
            className="w-9 h-9 rounded-full bg-brand-50 text-brand-700 font-semibold flex items-center justify-center shrink-0"
            title={collapsed ? user?.name : undefined}
          >
            {user?.name?.[0]?.toUpperCase() ?? '?'}
          </span>
          <div className={cn('min-w-0 flex-1 leading-tight', collapsed && 'md:hidden')}>
            <p className="text-sm font-semibold text-gray-900 truncate">
              {user?.name}
            </p>
            <p className="text-xs text-gray-500 capitalize truncate">
              {user?.role?.replace(/_/g, ' ')}
            </p>
          </div>
          <button
            type="button"
            onClick={toggleCollapsed}
            className="hidden md:inline-flex w-8 h-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </button>
        </div>
      </aside>
    </>
  );
}
