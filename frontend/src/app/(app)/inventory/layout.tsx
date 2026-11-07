'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/inventory', label: 'Catalogue', exact: true },
  { href: '/inventory/analytics', label: 'Analytics', exact: false },
];

export default function InventoryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // Hide the tab bar on the variant drill-down (/inventory/<id>).
  const onDetail = /^\/inventory\/\d+$/.test(pathname);

  if (onDetail) return <>{children}</>;

  return (
    <div>
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 pt-4">
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex gap-1 overflow-x-auto">
            {TABS.map((t) => {
              const active = t.exact
                ? pathname === t.href
                : pathname === t.href || pathname.startsWith(`${t.href}/`);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  className={cn(
                    'whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                    active
                      ? 'border-green-600 text-green-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
                  )}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
      {children}
    </div>
  );
}
