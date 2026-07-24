'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/orders', label: 'Abandoned Checkouts', exact: true },
  { href: '/orders/agent', label: 'Agent Orders', exact: false },
  { href: '/orders/attribution', label: 'Ad Attribution', exact: false },
  { href: '/orders/fulfillment', label: 'Fulfillment', exact: false },
];

export default function OrdersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Recover abandoned checkouts and review orders created from chats.
        </p>
      </div>

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

      {children}
    </div>
  );
}
