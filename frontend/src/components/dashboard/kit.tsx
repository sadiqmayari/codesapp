'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Dashboard v3 building blocks. Tokens only (surface/line/ink/muted/brand/navy/accent)
 * so light + dark both work without the generated dark-overrides.
 */

export function Panel({
  title,
  description,
  action,
  className,
  children,
  id,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        'min-w-0 rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(16,24,40,.04),0_8px_24px_rgba(16,24,40,.05)]',
        className,
      )}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-extrabold tracking-tight text-ink">{title}</h3>
          {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function PanelLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-[13px] font-bold text-brand-700 hover:underline dark:text-brand-300"
    >
      {children} <ArrowRight size={13} aria-hidden="true" />
    </Link>
  );
}

export function SectionTitle({ id, title, aside }: { id: string; title: string; aside?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 id={id} className="text-lg font-extrabold tracking-tight text-ink">
        {title}
      </h2>
      {aside}
    </div>
  );
}

export type Tone = 'good' | 'bad' | 'warn' | 'flat' | 'violet';

const TONE: Record<Tone, string> = {
  good: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  bad: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  warn: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  flat: 'bg-sunken text-muted',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200',
};

export function Chip({ tone = 'flat', className, children, title }: { tone?: Tone; className?: string; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-bold',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Change vs the previous period. `higherIsBetter=false` flips the colour (return rate).
 * `unit='pts'` for rate differences.
 */
export function Delta({
  value,
  higherIsBetter = true,
  unit = '%',
  suffix,
}: {
  value: number | null | undefined;
  higherIsBetter?: boolean;
  unit?: '%' | 'pts';
  suffix?: string;
}) {
  if (value == null || !Number.isFinite(value)) return <Chip tone="flat">no comparison</Chip>;
  const up = value > 0;
  const tone: Tone = value === 0 ? 'flat' : up === higherIsBetter ? 'good' : 'bad';
  const n = Math.abs(value) >= 10 ? Math.round(Math.abs(value)) : Math.round(Math.abs(value) * 10) / 10;
  return (
    <Chip tone={tone}>
      {value === 0 ? '±0' : `${up ? '▲' : '▼'} ${n}${unit === '%' ? '%' : ' pts'}`}
      {suffix ? <span className="font-semibold opacity-80">{suffix}</span> : null}
    </Chip>
  );
}

/** 14-bar sparkline; the last bar (today) is solid. */
export function Sparkbars({ values, tone = 'good' }: { values: number[]; tone?: 'good' | 'bad' | 'accent' }) {
  const max = Math.max(1, ...values);
  const color = tone === 'bad' ? 'bg-red-500' : tone === 'accent' ? 'bg-accent' : 'bg-emerald-500';
  if (!values.length) return <div className="h-7" />;
  return (
    <div className="flex h-7 items-end gap-[3px]" aria-hidden="true">
      {values.map((v, i) => (
        <span
          key={i}
          className={cn('flex-1 rounded-[3px]', color, i === values.length - 1 ? 'opacity-100' : 'opacity-35')}
          style={{ height: `${Math.max(10, Math.round((v / max) * 100))}%` }}
        />
      ))}
    </div>
  );
}

/** Progress ring (navy tiles). */
export function Ring({
  pct,
  label,
  sub,
  size = 120,
  ariaLabel,
}: {
  pct: number;
  label: string;
  sub?: string;
  size?: number;
  ariaLabel: string;
}) {
  const r = 50;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label={ariaLabel} className="shrink-0">
      <circle cx="60" cy="60" r={r} fill="none" stroke="rgb(var(--navy-line))" strokeWidth="12" />
      <circle
        cx="60"
        cy="60"
        r={r}
        fill="none"
        stroke="#12B76A"
        strokeWidth="12"
        strokeLinecap="round"
        strokeDasharray={`${(p / 100) * c} ${c}`}
        transform="rotate(-90 60 60)"
        style={{ transition: 'stroke-dasharray .6s ease' }}
      />
      <text x="60" y={sub ? 58 : 66} textAnchor="middle" fill="#FFFFFF" fontSize="24" fontWeight="800">
        {label}
      </text>
      {sub && (
        <text x="60" y="76" textAnchor="middle" fill="#9AA4B2" fontSize="10.5" fontWeight="700">
          {sub}
        </text>
      )}
    </svg>
  );
}

/** Thin progress bar coloured by fill level (≥90 red, ≥75 amber). */
export function UsageBar({ pct, className }: { pct: number; className?: string }) {
  const p = Math.max(0, Math.min(100, pct));
  const color = p >= 90 ? 'bg-red-500' : p >= 75 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-sunken', className)}>
      <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${p}%` }} />
    </div>
  );
}

const AV = ['bg-emerald-300', 'bg-cyan-300', 'bg-amber-300', 'bg-violet-300', 'bg-rose-300', 'bg-lime-300'];
export function Avatar({ name, i = 0, size = 30 }: { name: string; i?: number; size?: number }) {
  const ini =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '?';
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full text-xs font-extrabold text-[#04150C]', AV[i % AV.length])}
      style={{ width: size, height: size }}
    >
      {ini}
    </span>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-2xl bg-sunken', className)} />;
}
