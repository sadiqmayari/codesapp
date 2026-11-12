'use client';

import { useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/toast';

/** Formats a money value in the order's currency ("PKR 6,480"). */
export type MoneyFmt = (v: number | null | undefined) => string;

/** One-tap copy for the values agents re-type all day (phone, address, order
 *  #, tracking #). Never throws — a blocked clipboard just shows an error toast. */
export function CopyButton({
  value,
  label,
  className,
  size = 13,
}: {
  value: string | null | undefined;
  label: string;
  className?: string;
  size?: number;
}) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  if (!value) return null;
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          toast.success(`Copied ${label}`);
          setTimeout(() => setDone(false), 1200);
        } catch {
          toast.error('Could not copy — your browser blocked the clipboard');
        }
      }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md p-1 text-muted hover:bg-brand-50 hover:text-brand-700',
        done && 'text-brand-700',
        className,
      )}
    >
      {done ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}

/** Drawer section card. Title is a small uppercase eyebrow; `right` holds a
 *  link/meta aligned to the end of the title row. */
export function Section({
  title,
  icon,
  right,
  children,
  className,
}: {
  title: string;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-2xl border border-line bg-surface p-4', className)}>
      <div className="mb-3 flex items-center gap-1.5">
        {icon && <span className="text-muted">{icon}</span>}
        <h3 className="text-xs font-extrabold uppercase tracking-wide text-muted">{title}</h3>
        {right && <div className="ml-auto text-xs font-semibold">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/** Small stat tile (value over label). */
export function Stat({
  value,
  label,
  tone,
}: {
  value: React.ReactNode;
  label: string;
  tone?: 'bad' | 'warn' | 'good';
}) {
  return (
    <div className="min-w-0 flex-1 basis-20 rounded-xl bg-sunken px-3 py-2">
      <div
        className={cn(
          'truncate text-[15px] font-extrabold tabular-nums text-ink',
          tone === 'bad' && 'text-rose-600',
          tone === 'warn' && 'text-amber-600',
          tone === 'good' && 'text-brand-700',
        )}
      >
        {value}
      </div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

/** Pill-shaped action button used inside the drawer (callout + cards). */
export function ActionButton({
  onClick,
  icon,
  children,
  tone = 'default',
  busy,
  disabled,
  className,
}: {
  onClick?: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
  tone?: 'primary' | 'default' | 'warn' | 'danger';
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-bold transition disabled:opacity-50',
        tone === 'primary' && 'bg-brand-600 text-white hover:bg-brand-700',
        tone === 'default' && 'border border-line bg-surface text-ink hover:bg-sunken',
        tone === 'warn' && 'bg-amber-100 text-amber-800 hover:bg-amber-200',
        tone === 'danger' && 'bg-rose-100 text-rose-700 hover:bg-rose-200',
        className,
      )}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

/** "2m ago" / "3h ago" / "4d ago" from an ISO string or epoch ms. */
export function timeAgo(at: string | number | null | undefined): string {
  if (at == null) return '';
  const t = typeof at === 'number' ? at : new Date(at).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** Whole days between an ISO date and now (floor, never negative). */
export function daysSince(at: string | null | undefined): number | null {
  if (!at) return null;
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}
