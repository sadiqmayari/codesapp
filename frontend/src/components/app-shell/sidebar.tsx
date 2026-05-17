'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  MessagesSquare,
  Users,
  FileText,
  Megaphone,
  Bot,
  Webhook,
  BarChart3,
  CreditCard,
  Settings,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

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
}: {
  open: boolean;
  onClose: () => void;
  unread: number;
}) {
  const pathname = usePathname();

  const items: NavItem[] = [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, enabled: true },
    {
      href: '/inbox',
      label: 'Inbox',
      icon: MessagesSquare,
      enabled: true,
      badge: unread,
    },
    { href: '/contacts', label: 'Contacts', icon: Users, enabled: true },
    { href: '/templates', label: 'Templates', icon: FileText, enabled: true },
    { href: '/broadcasts', label: 'Broadcasts', icon: Megaphone, enabled: true },
    { href: '/bots', label: 'Bots', icon: Bot, enabled: true },
    { href: '/webhooks', label: 'Webhooks', icon: Webhook, enabled: false },
    { href: '/analytics', label: 'Analytics', icon: BarChart3, enabled: false },
    { href: '/billing', label: 'Billing', icon: CreditCard, enabled: false },
  ];

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
        className={cn(
          'fixed z-40 inset-y-0 left-0 w-64 bg-gray-900 text-gray-300 flex flex-col transition-transform md:translate-x-0 md:static md:z-auto',
          open ? 'translate-x-0' : '-translate-x-full',
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
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-gray-700">
                    Soon
                  </span>
                </div>
              );
            }
            return (
              <Link
                key={it.href}
                href={it.href}
                onClick={onClose}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-green-600 text-white'
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

          <div className="pt-3 mt-3 border-t border-gray-800">
            <div
              title="Coming soon"
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-gray-600 cursor-not-allowed select-none"
            >
              <Settings size={18} />
              <span>Settings</span>
              <span className="ml-auto text-[10px] uppercase tracking-wide text-gray-700">
                Soon
              </span>
            </div>
          </div>
        </nav>
      </aside>
    </>
  );
}
