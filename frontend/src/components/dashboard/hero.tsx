'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { cn, getActiveTimeZone } from '@/lib/utils';
import { money, count, fullMoney, useNumberMode } from '@/lib/format-number';
import { GROSS_HELP, NET_HELP } from '@/components/ui/sales-breakdown';
import type { BriefItem, ManagerData } from '@/lib/dashboard';
import { deltaPct } from '@/lib/dashboard';
import { Ring } from './kit';

export interface TrendPoint {
  bucket: string;
  net: number;
  gross: number;
  orders: number;
}

export interface HeroSales {
  currency: string | null;
  gross: number;
  net: number;
  orders: number;
  kept: number;
  netPrev: number | null;
}

const TONE_DOT: Record<BriefItem['tone'], string> = {
  bad: 'bg-red-400',
  warn: 'bg-amber-400',
  good: 'bg-emerald-400',
};

/** Cumulative series by hour (0–23) from hourly trend buckets "YYYY-MM-DD HH:00". */
function cumulativeByHour(points: TrendPoint[], untilHour: number): number[] {
  const byH = Array(24).fill(0) as number[];
  for (const p of points) {
    const h = Number(p.bucket.slice(11, 13));
    if (Number.isFinite(h) && h >= 0 && h < 24) byH[h] += p.net;
  }
  const out: number[] = [];
  let run = 0;
  for (let h = 0; h <= untilHour; h++) {
    run += byH[h];
    out.push(run);
  }
  return out;
}

function Chart({
  series,
  compare,
  labels,
  currency,
}: {
  series: number[];
  compare: number[] | null;
  labels: string[];
  currency: string | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 150;
  const n = Math.max(labels.length, 2);
  const max = Math.max(1, ...series, ...(compare ?? []));
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => 132 - (v / max) * 110;
  const line = (arr: number[]) => arr.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = series.length > 1 ? `${line(series)} ${x(series.length - 1)},146 0,146` : '';
  const hi = hover ?? series.length - 1;
  const tick = (i: number) => i === 0 || i === n - 1 || i % Math.ceil(n / 4) === 0;
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label="Net sales over the period"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
          setHover(Math.max(0, Math.min(series.length - 1, i)));
        }}
      >
        <defs>
          <linearGradient id="dashHeroFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#12B76A" stopOpacity=".35" />
            <stop offset="1" stopColor="#12B76A" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[30, 80, 130].map((g) => (
          <line key={g} x1="0" x2={W} y1={g} y2={g} stroke="rgb(var(--navy-line))" strokeWidth="1" />
        ))}
        {compare && compare.length > 1 && (
          <polyline points={line(compare)} fill="none" stroke="#4A5B74" strokeWidth="2" strokeDasharray="5 5" />
        )}
        {area && <polygon points={area} fill="url(#dashHeroFill)" />}
        {series.length > 1 && (
          <polyline points={line(series)} fill="none" stroke="#12B76A" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        )}
        {series.length > 0 && (
          <>
            <line x1={x(hi)} x2={x(hi)} y1="20" y2="140" stroke="rgb(var(--navy-line))" strokeWidth="1" />
            <circle cx={x(hi)} cy={y(series[hi] ?? 0)} r="5" fill="#12B76A" stroke="rgb(var(--navy))" strokeWidth="3" />
          </>
        )}
        {labels.map((l, i) =>
          tick(i) ? (
            <text key={i} x={Math.min(W - 24, x(i))} y="148" fill="#8592A6" fontSize="11" fontWeight="700">
              {l}
            </text>
          ) : null,
        )}
      </svg>
      {series.length > 0 && (
        <div className="pointer-events-none absolute right-0 top-0 rounded-lg bg-navy-2 px-2.5 py-1 text-xs font-bold text-white">
          {labels[hi]} · {fullMoney(series[hi], currency)}
          {compare && compare[hi] != null ? <span className="ml-2 text-[#8592A6]">vs {fullMoney(compare[hi], currency)}</span> : null}
        </div>
      )}
    </div>
  );
}

export function Hero({
  periodKey,
  periodLabel,
  sales,
  trend,
  yesterday,
  target,
  brief,
  loading,
  hideBrief,
}: {
  periodKey: string;
  periodLabel: string;
  sales: HeroSales | null;
  trend: TrendPoint[];
  yesterday: TrendPoint[] | null;
  target: ManagerData['target'] | null;
  brief: BriefItem[];
  loading: boolean;
  hideBrief?: boolean;
}) {
  const [mode] = useNumberMode();
  const cur = sales?.currency ?? null;
  const d = deltaPct(sales?.net, sales?.netPrev);
  const aov = sales && sales.kept > 0 ? sales.net / sales.kept : null;

  const chart = useMemo(() => {
    if (periodKey === 'today') {
      const nowH = Number(
        new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: getActiveTimeZone() ?? undefined }).format(new Date()),
      );
      const hourLabel = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);
      const lastBucket = trend.length ? Number(trend[trend.length - 1].bucket.slice(11, 13)) : nowH;
      const until = Math.max(lastBucket, Math.min(23, nowH));
      return {
        title: 'Net sales by hour, cumulative',
        series: cumulativeByHour(trend, until),
        compare: yesterday ? cumulativeByHour(yesterday, 23) : null,
        labels: Array.from({ length: 24 }, (_, h) => hourLabel(h)),
        legendCompare: 'Yesterday',
      };
    }
    return {
      title: 'Net sales by day',
      series: trend.map((t) => t.net),
      compare: null,
      labels: trend.map((t) => {
        const dt = new Date(`${t.bucket.slice(0, 10)}T12:00:00Z`);
        return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      }),
      legendCompare: null as string | null,
    };
  }, [periodKey, trend, yesterday]);

  return (
    <section
      aria-label="Sales, target and brief"
      className="grid overflow-hidden rounded-[22px] bg-navy text-white shadow-[0_20px_48px_rgba(14,26,43,.28)] lg:grid-cols-[1.35fr_1fr]"
    >
      <div className="flex min-w-0 flex-col gap-5 p-6 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="text-xs font-extrabold uppercase tracking-[.08em] text-[#9AA4B2]" title={NET_HELP}>
              Net sales · {periodLabel}
            </div>
            {loading && !sales ? (
              <div className="mt-2 h-12 w-64 animate-pulse rounded-lg bg-navy-2" />
            ) : (
              <div className="mt-1.5 break-words text-[34px] font-extrabold leading-[1.05] tracking-[-.03em] tabular-nums sm:text-[44px] xl:text-[52px]" title={fullMoney(sales?.net, cur)}>
                {money(sales?.net ?? 0, cur, mode)}
              </div>
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-[#C7CED9]">
              {d != null && (
                <span
                  className={cn(
                    'inline-flex h-6 items-center rounded-full px-2.5 text-xs font-bold',
                    d >= 0 ? 'bg-emerald-500/20 text-[#6CE9A6]' : 'bg-red-500/20 text-[#FDA29B]',
                  )}
                >
                  {d >= 0 ? '▲' : '▼'} {Math.abs(d)}% vs previous period
                </span>
              )}
              <span title={GROSS_HELP}>Gross {money(sales?.gross ?? 0, cur, mode)}</span>
              <span aria-hidden="true">·</span>
              <span>{count(sales?.orders ?? 0, mode)} orders</span>
              {aov != null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>AOV {fullMoney(aov, cur)}</span>
                </>
              )}
            </div>
          </div>
          {target?.target ? (
            <div className="flex items-center gap-4">
              <Ring
                pct={target.pct ?? 0}
                label={`${Math.round(target.pct ?? 0)}%`}
                sub="OF TARGET"
                size={112}
                ariaLabel={`${Math.round(target.pct ?? 0)} percent of the monthly net target reached`}
              />
              <div className="text-[13px] leading-relaxed text-[#C7CED9]">
                <div className="font-extrabold text-white">Monthly target</div>
                <div>
                  {money(target.net, cur, mode)} of {money(target.target, cur, mode)}
                </div>
                <div className={cn('font-bold', target.onTrack ? 'text-[#6CE9A6]' : 'text-[#FEC84B]')}>
                  {target.onTrack ? 'On track' : 'Behind'} · heading for {money(target.projected, cur, mode)}
                </div>
                {!target.onTrack && target.neededPerDay != null && <div>Need {money(target.neededPerDay, cur, mode)} / day</div>}
              </div>
            </div>
          ) : (
            <Link
              href="/growth/forecast"
              className="rounded-xl border border-navy-line px-3.5 py-2.5 text-[13px] font-bold text-[#C7CED9] hover:border-emerald-400 hover:text-white"
            >
              Set a monthly target →
            </Link>
          )}
        </div>
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-[#9AA4B2]">
            <span>{chart.title}</span>
            <span className="flex gap-3">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500" /> {periodKey === 'today' ? 'Today' : 'Net'}
              </span>
              {chart.legendCompare && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-[#4A5B74]" /> {chart.legendCompare}
                </span>
              )}
            </span>
          </div>
          {loading && !trend.length ? (
            <div className="mt-2 h-[150px] animate-pulse rounded-xl bg-navy-2" />
          ) : (
            <Chart series={chart.series} compare={chart.compare} labels={chart.labels} currency={cur} />
          )}
        </div>
      </div>

      {!hideBrief && (
        <div className="flex min-w-0 flex-col gap-3 bg-navy-2 p-6 sm:p-7">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 text-xs font-extrabold uppercase tracking-[.08em] text-accent">
              <Sparkles size={15} aria-hidden="true" /> Today&apos;s brief
            </span>
            <span className="text-xs text-[#9AA4B2]">from live numbers</span>
          </div>
          {loading && !brief.length ? (
            <>
              <div className="h-[74px] animate-pulse rounded-2xl bg-navy" />
              <div className="h-[74px] animate-pulse rounded-2xl bg-navy" />
            </>
          ) : brief.length === 0 ? (
            <div className="rounded-2xl border border-navy-line bg-navy p-4 text-sm text-[#C7CED9]">
              <div className="font-bold text-white">Nothing urgent right now.</div>
              Chats are answered, orders are moving and returns look normal.
            </div>
          ) : (
            brief.map((b, i) => (
              <div key={i} className="flex gap-3 rounded-2xl border border-navy-line bg-navy p-3.5">
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', TONE_DOT[b.tone])} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold leading-snug">{b.text}</div>
                  <div className="mt-0.5 text-[12.5px] text-[#9AA4B2]">{b.why}</div>
                </div>
                <Link href={b.href} className="self-center whitespace-nowrap text-[13px] font-extrabold text-[#6CE9A6] hover:underline">
                  {b.cta} →
                </Link>
              </div>
            ))
          )}
          <Link href="/growth" className="mt-auto pt-1 text-[13px] font-bold text-[#C7CED9] hover:text-white">
            Open Growth for the full picture →
          </Link>
        </div>
      )}
    </section>
  );
}
