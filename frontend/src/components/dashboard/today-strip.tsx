'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  MessagesSquare,
  PackageCheck,
  Truck,
  AlertTriangle,
} from 'lucide-react';
import { apiFetch, apiFetchEnvelope } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import type { LaneCounts } from '@/lib/couriers';
import { Skeleton } from '@/components/ui/skeleton';

interface Tile {
  key: string;
  label: string;
  value: number;
  cta: string;
  href: string;
  icon: React.ElementType;
  /** Left accent + icon tone. */
  tone: 'red' | 'amber' | 'sky' | 'violet';
}

const TONE: Record<Tile['tone'], { bar: string; icon: string }> = {
  red: { bar: 'border-l-red-500', icon: 'bg-red-50 text-red-600' },
  amber: { bar: 'border-l-amber-500', icon: 'bg-amber-50 text-amber-600' },
  sky: { bar: 'border-l-sky-500', icon: 'bg-sky-50 text-sky-600' },
  violet: { bar: 'border-l-violet-500', icon: 'bg-violet-50 text-violet-600' },
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Dashboard v2 "Needs you today" strip (UI Phase C): the four queues an
 * operator should clear, each one tap from the screen that clears it.
 * Live: refetches on inbox/order socket events + every 60 s. All sources are
 * best-effort — a failing source hides its tile, never the dashboard.
 */
export function TodayStrip() {
  const { user } = useAuth();
  const { on } = useSocket();
  const [unread, setUnread] = useState<number | null>(null);
  const [lanes, setLanes] = useState<LaneCounts | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [u, l] = await Promise.allSettled([
      apiFetchEnvelope<unknown[]>('/inbox/conversations', {
        params: { status: 'unread', limit: 1 },
        noOnboardingRedirect: true,
      }),
      apiFetch<LaneCounts>('/shipments/queue/lane-counts', {
        noOnboardingRedirect: true,
      }),
    ]);
    if (u.status === 'fulfilled') {
      const env = u.value;
      setUnread(
        typeof env.meta?.total === 'number'
          ? (env.meta.total as number)
          : Array.isArray(env.data)
            ? env.data.length
            : 0,
      );
    }
    if (l.status === 'fulfilled') setLanes(l.value);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 1500);
    };
    const offs = [
      on('message.received', bump),
      on('message.read.bulk', bump),
      on('orders.changed', bump),
    ];
    return () => {
      offs.forEach((off) => off?.());
      if (timer) clearTimeout(timer);
    };
  }, [on, load]);

  const tiles: Tile[] = [];
  if (unread !== null)
    tiles.push({
      key: 'unread',
      label: 'Unread chats',
      value: unread,
      cta: 'Open inbox',
      href: '/inbox',
      icon: MessagesSquare,
      tone: 'red',
    });
  if (lanes) {
    tiles.push(
      {
        key: 'confirm',
        label: 'Orders awaiting confirmation',
        value: lanes.toBook.awaiting,
        cta: 'Start confirming',
        href: '/orders/fulfillment',
        icon: PackageCheck,
        tone: 'amber',
      },
      {
        key: 'book',
        label: 'Confirmed, ready to book',
        value: lanes.toBook.confirmed,
        cta: 'Book parcels',
        href: '/orders/fulfillment',
        icon: Truck,
        tone: 'sky',
      },
      {
        key: 'attention',
        label: 'Parcels needing attention',
        value: lanes.needsAttention.total,
        cta: 'Review',
        href: '/orders/fulfillment',
        icon: AlertTriangle,
        tone: 'violet',
      },
    );
  }

  const firstName = user?.name?.split(' ')[0];

  return (
    <section className="mb-6" aria-labelledby="today-h">
      <div className="mb-3">
        <h2 id="today-h" className="text-lg font-bold text-gray-900">
          {greeting()}
          {firstName ? `, ${firstName}` : ''}
        </h2>
        <p className="text-sm text-gray-500">Here&apos;s what needs you today.</p>
      </div>
      {!loaded ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-xl" />
          ))}
        </div>
      ) : tiles.length === 0 ? null : (
        <div className={cn('grid grid-cols-2 gap-3', tiles.length >= 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
          {tiles.map((t) => {
            const Icon = t.icon;
            const done = t.value === 0;
            return (
              <Link
                key={t.key}
                href={t.href}
                className={cn(
                  'group bg-white border border-gray-200 border-l-4 rounded-xl p-4 flex flex-col gap-1 hover:shadow-md transition-shadow',
                  done ? 'border-l-emerald-500' : TONE[t.tone].bar,
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-500 leading-snug">
                    {t.label}
                  </span>
                  <span
                    className={cn(
                      'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                      done ? 'bg-emerald-50 text-emerald-600' : TONE[t.tone].icon,
                    )}
                  >
                    <Icon size={16} />
                  </span>
                </div>
                <span className="text-2xl font-bold text-gray-900 tabular-nums">
                  {t.value.toLocaleString()}
                </span>
                <span className="text-xs font-semibold text-brand-600 inline-flex items-center gap-1">
                  {done ? 'All clear' : t.cta}
                  {!done && (
                    <ArrowRight size={12} className="transition-transform group-hover:translate-x-0.5" />
                  )}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
