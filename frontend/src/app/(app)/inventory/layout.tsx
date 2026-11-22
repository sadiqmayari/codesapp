'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/auth-context';
import { WAREHOUSE_INVENTORY_PATHS } from '@/components/app-shell/nav-config';

/**
 * Inventory module shell — one tab bar for every inventory screen. Hidden on
 * full-page editors (new / edit product) and the legacy /inventory/<id>
 * deep-link redirect.
 */
const TABS: Array<{ href: string; label: string }> = [
  { href: '/inventory', label: 'Catalogue' },
  { href: '/inventory/purchase-orders', label: 'Purchase orders' },
  { href: '/inventory/counts', label: 'Counts' },
  { href: '/inventory/transfers', label: 'Transfers' },
  { href: '/inventory/ledger', label: 'Ledger' },
  { href: '/inventory/suppliers', label: 'Suppliers' },
  { href: '/inventory/analytics', label: 'Analytics' },
];

export default function InventoryLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const { user } = useAuth();
  const manage = user?.role === 'owner' || user?.role === 'admin';
  // warehouse roles only see their floor screens
  const tabs = manage ? TABS : TABS.filter((t) => WAREHOUSE_INVENTORY_PATHS.includes(t.href));
  const hide = /^\/inventory\/\d+$/.test(pathname) || pathname.startsWith('/inventory/products/');
  const active = (href: string) =>
    href === '/inventory' ? pathname === '/inventory' : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <div className="flex min-h-full flex-col">
      {!hide && (
        <nav aria-label="Inventory sections" className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-[1400px] gap-1 overflow-x-auto px-4 sm:px-6">
            {tabs.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active(t.href) ? 'page' : undefined}
                className={cn(
                  'whitespace-nowrap border-b-2 px-3 py-3 text-sm font-semibold transition-colors',
                  active(t.href) ? 'border-brand-600 text-ink' : 'border-transparent text-muted hover:text-ink',
                )}
              >
                {t.label}
              </Link>
            ))}
          </div>
        </nav>
      )}
      <div className="flex-1">{children}</div>
    </div>
  );
}
