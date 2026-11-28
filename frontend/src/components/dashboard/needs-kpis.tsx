'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { money, count, fullMoney, pct, useNumberMode } from '@/lib/format-number';
import type { LaneCounts } from '@/lib/couriers';
import type { ManagerData } from '@/lib/dashboard';
import { deltaPct, fmtWait } from '@/lib/dashboard';
import { Chip, Delta, SectionTitle, Sparkbars, type Tone } from './kit';

export interface NeedTile {
  key: string;
  label: string;
  value: number | null;
  hint: string;
  cta: string;
  href: string;
  accent: string;
  chip?: { text: string; tone: Tone } | null;
}

/** One-tap queue tiles. A zero tile turns green ("All clear"). */
export function TaskTiles({ tiles, loading }: { tiles: NeedTile[]; loading: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(206px,1fr))]">
      {tiles.map((t) => {
        const done = t.value === 0;
        return (
          <Link
            key={t.key}
            href={t.href}
            className="group relative flex min-h-[138px] flex-col gap-1 rounded-2xl border border-line bg-surface p-4 text-ink shadow-[0_1px_2px_rgba(16,24,40,.04)] transition hover:-translate-y-0.5 hover:border-emerald-500 hover:shadow-md"
          >
            <span aria-hidden="true" className={cn('absolute inset-x-4 top-0 h-[3px] rounded-b', done ? 'bg-emerald-500' : t.accent)} />
            <div className="flex items-start justify-between gap-2">
              <span className="text-[13px] font-bold leading-snug text-muted">{t.label}</span>
              {done ? <Chip tone="good">clear</Chip> : t.chip ? <Chip tone={t.chip.tone}>{t.chip.text}</Chip> : null}
            </div>
            {loading && t.value == null ? (
              <span className="mt-1 h-8 w-16 animate-pulse rounded bg-sunken" />
            ) : (
              <span className="text-[32px] font-extrabold leading-tight tracking-tight tabular-nums">
                {t.value == null ? '—' : t.value.toLocaleString('en-US')}
              </span>
            )}
            <span className="text-[12.5px] text-muted">{done ? 'All clear' : t.hint}</span>
            <span className="mt-auto pt-1.5 text-[13px] font-extrabold text-brand-700 group-hover:underline dark:text-brand-300">
              {t.cta} →
            </span>
          </Link>
        );
      })}
    </div>
  );
}

export function buildNeedTiles(m: ManagerData | null, lanes: LaneCounts | null, mods: Record<string, boolean>): NeedTile[] {
  const n = m?.needs;
  const tiles: NeedTile[] = [
    {
      key: 'unread',
      label: 'Unread chats',
      value: n ? n.unread : null,
      hint: n?.unreadOldestMin != null ? `Oldest waiting ${fmtWait(n.unreadOldestMin)}` : 'Customers waiting for a reply',
      cta: 'Reply now',
      href: '/inbox?status=unread',
      accent: 'bg-red-500',
      chip:
        n?.unreadOldestMin != null && n.unread > 0
          ? { text: fmtWait(n.unreadOldestMin), tone: n.unreadOldestMin >= 60 ? 'bad' : n.unreadOldestMin >= 15 ? 'warn' : 'flat' }
          : null,
    },
    {
      key: 'confirm',
      label: 'Awaiting confirmation',
      value: lanes ? lanes.toBook.awaiting : null,
      hint: n?.unconfirmedOld ? `${n.unconfirmedOld.toLocaleString('en-US')} over 24 h old` : 'Orders to confirm with the customer',
      cta: 'Confirm orders',
      href: '/orders/fulfillment?lane=unfulfilled&conf=unconfirmed',
      accent: 'bg-amber-500',
      chip: n?.unconfirmedOld ? { text: '24h+', tone: 'warn' } : null,
    },
  ];
  if (mods.couriers !== false) {
    tiles.push(
      {
        key: 'advice',
        label: 'Shipper advice',
        value: lanes ? lanes.needsAttention.shipperAdvice : null,
        hint: 'Courier is waiting for your decision',
        cta: 'Send advice',
        href: '/orders/fulfillment?lane=shipper_advice',
        accent: 'bg-violet-500',
        chip: lanes && lanes.needsAttention.shipperAdvice > 0 ? { text: 'due', tone: 'warn' } : null,
      },
      {
        key: 'book',
        label: 'Ready to book',
        value: lanes ? lanes.toBook.confirmed : null,
        hint: 'Confirmed, no courier yet',
        cta: 'Book parcels',
        href: '/orders/fulfillment?lane=unfulfilled&conf=confirmed',
        accent: 'bg-sky-500',
      },
    );
  }
  if (mods.tickets) {
    tiles.push({
      key: 'tickets',
      label: 'Tickets open 2+ days',
      value: n?.overdueTickets ?? null,
      hint: 'Customers still waiting on a fix',
      cta: 'Tickets',
      href: '/tickets?status=open_any',
      accent: 'bg-rose-500',
    });
  }
  return tiles;
}

export interface PeriodSales {
  currency: string | null;
  gross: number;
  grossPrev: number | null;
  net: number;
  netPrev: number | null;
  orders: number;
  ordersPrev: number | null;
  kept: number;
  keptPrev: number | null;
}

function KpiCard({
  label,
  value,
  title,
  delta,
  note,
  bars,
  barTone,
}: {
  label: string;
  value: string;
  title?: string;
  delta: React.ReactNode;
  note: string;
  bars: number[];
  barTone?: 'good' | 'bad' | 'accent';
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-surface p-3.5 shadow-[0_1px_2px_rgba(16,24,40,.04)] sm:gap-2.5 sm:p-4">
      <span className="text-[11px] font-bold uppercase leading-snug tracking-[.05em] text-muted sm:text-[11.5px]">{label}</span>
      {/* Never truncate a figure: smaller on phones, wraps if it must. */}
      <span className="break-words text-[20px] font-extrabold leading-tight tracking-tight tabular-nums text-ink sm:text-[26px]" title={title}>
        {value}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">{delta}</div>
      <Sparkbars values={bars} tone={barTone} />
      <span className="text-xs leading-snug text-muted">{note}</span>
    </div>
  );
}

export function HealthKpis({
  m,
  s,
  periodLabel,
  loading,
}: {
  m: ManagerData | null;
  s: PeriodSales | null;
  periodLabel: string;
  /** The selected period is still loading: show skeletons, never the previous period's figures. */
  loading?: boolean;
}) {
  const [mode] = useNumberMode();
  if (loading) {
    return (
      <section aria-labelledby="dash-kpis" aria-busy="true">
        <SectionTitle id="dash-kpis" title="Business health" aside={<span className="text-[13px] text-muted">Loading {periodLabel}…</span>} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-[168px] animate-pulse rounded-2xl border border-line bg-sunken" />
          ))}
        </div>
      </section>
    );
  }
  const cur = s?.currency ?? null;
  const sp = m?.sparks ?? [];
  const q = m?.quality;
  const aov = s && s.kept > 0 ? s.net / s.kept : null;
  const aovPrev = s && s.keptPrev && s.netPrev != null ? s.netPrev / s.keptPrev : null;
  const pts = (a: number | null | undefined, b: number | null | undefined) =>
    a == null || b == null ? null : Math.round((a - b) * 10) / 10;
  const confirmRate = m?.flow && m.flow.placed > 0 ? (m.flow.confirmed / m.flow.placed) * 100 : null;

  return (
    <section aria-labelledby="dash-kpis">
      <SectionTitle id="dash-kpis" title="Business health" aside={<span className="text-[13px] text-muted">{periodLabel} vs the period before</span>} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
        <KpiCard label="Gross sales" value={money(s?.gross ?? 0, cur, mode)} title={fullMoney(s?.gross, cur)} delta={<Delta value={deltaPct(s?.gross, s?.grossPrev)} />} note={`${count(s?.orders ?? 0, mode)} orders placed`} bars={sp.map((d) => d.gross)} />
        <KpiCard label="Net sales" value={money(s?.net ?? 0, cur, mode)} title={fullMoney(s?.net, cur)} delta={<Delta value={deltaPct(s?.net, s?.netPrev)} />} note={s && s.gross > 0 ? `${pct((s.net / s.gross) * 100)} of gross kept` : 'after discounts, cancels and returns'} bars={sp.map((d) => d.net)} />
        <KpiCard label="Avg order value" value={aov != null ? fullMoney(aov, cur) : '—'} delta={<Delta value={deltaPct(aov, aovPrev)} />} note="net, per kept order" bars={sp.map((d) => d.aov)} barTone="accent" />
        <KpiCard label="Confirmation rate" value={pct(confirmRate)} delta={<Chip tone="flat">30 days</Chip>} note="placed → confirmed or shipped" bars={sp.map((d) => d.orders)} barTone="accent" />
        <KpiCard label="Delivery rate" value={pct(q?.deliveryRate)} delta={<Delta value={pts(q?.deliveryRate, q?.deliveryRatePrev)} unit="pts" />} note={`settled parcels · ${count(q?.parcels ?? 0, mode)}`} bars={[]} />
        <KpiCard label="Return (RTO) rate" value={pct(q?.rtoRate)} delta={<Delta value={pts(q?.rtoRate, q?.rtoRatePrev)} unit="pts" higherIsBetter={false} />} note={m?.hotspots?.cities[0] ? `${m.hotspots.cities[0].city} worst at ${m.hotspots.cities[0].rtoRate}%` : 'parcels that came back'} bars={[]} barTone="bad" />
        {m?.ads && (
          <KpiCard label="Ad spend" value={money(m.ads.spend, cur, mode)} title={fullMoney(m.ads.spend, cur)} delta={m.ads.roas != null ? <Chip tone={m.ads.roas >= 2 ? 'good' : m.ads.roas >= 1.5 ? 'warn' : 'bad'}>{m.ads.roas}× ROAS</Chip> : <Delta value={deltaPct(m.ads.spend, m.ads.spendPrev)} higherIsBetter={false} />} note="net sales ÷ ad spend" bars={m.ads.daily} barTone="accent" />
        )}
        {m?.cod && (
          <KpiCard label="COD to collect" value={money(m.cod.amount, cur, mode)} title={fullMoney(m.cod.amount, cur)} delta={m.cod.oldestDays != null ? <Chip tone={m.cod.oldestDays >= 30 ? 'bad' : m.cod.oldestDays >= 15 ? 'warn' : 'flat'}>oldest {m.cod.oldestDays} d</Chip> : <Chip tone="flat">—</Chip>} note={`${count(m.cod.parcels, mode)} delivered parcels not paid yet`} bars={[]} barTone="accent" />
        )}
      </div>
    </section>
  );
}
