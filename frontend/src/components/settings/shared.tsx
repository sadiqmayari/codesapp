'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import type { Template } from '@/lib/crm-types';

/**
 * Shared Settings building blocks. Every section page is
 *   <SettingsPage title description actions> → <SettingsCard>s → <SettingRow>s
 * so headings, spacing, widths and states are identical everywhere.
 */

/** Input / select / textarea class — tokens only, works in dark mode. */
export const inputCls =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted/70 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-sunken disabled:text-muted';

export function SettingsPage({
  title,
  description,
  icon,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start gap-3.5">
        {icon}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">{title}</h1>
          {description && (
            <p className="mt-1 max-w-[64ch] text-sm text-muted">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function SettingsCard({
  title,
  description,
  action,
  icon,
  tone,
  children,
  bodyClassName,
  flush,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'danger';
  children?: React.ReactNode;
  bodyClassName?: string;
  /** No body padding (tables). */
  flush?: boolean;
}) {
  return (
    <section
      className={cn(
        'rounded-2xl border bg-surface shadow-sm',
        tone === 'danger' ? 'border-red-200 dark:border-red-900/60' : 'border-line',
      )}
    >
      {(title || action) && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-3 px-5 py-4',
            children != null && 'border-b border-line',
          )}
        >
          {icon}
          <div className="min-w-0 flex-1">
            {title && (
              <h2
                className={cn(
                  'text-[15px] font-bold',
                  tone === 'danger' ? 'text-red-600' : 'text-ink',
                )}
              >
                {title}
              </h2>
            )}
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
          {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
        </div>
      )}
      {children != null && (
        <div className={cn(flush ? '' : 'flex flex-col gap-4 px-5 py-4', bodyClassName)}>
          {children}
        </div>
      )}
    </section>
  );
}

/** One setting: label + help on the left, the control on the right. */
export function SettingRow({
  title,
  description,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', className)}>
      <div className="min-w-[200px] flex-1">
        <div className="text-sm font-semibold text-ink">{title}</div>
        {description && <div className="mt-0.5 text-[13px] text-muted">{description}</div>}
      </div>
      {children}
    </div>
  );
}

/** Rows separated by hairlines inside a card. */
export function Rows({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col divide-y divide-line [&>*]:py-3.5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">{children}</div>;
}

export function FormField({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Tinted note. */
export function Callout({
  tone = 'brand',
  icon,
  children,
  action,
}: {
  tone?: 'brand' | 'warn' | 'info' | 'danger';
  icon?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start gap-3 rounded-xl px-3.5 py-3 text-[13px] text-ink',
        tone === 'brand' && 'bg-brand-50 dark:bg-brand-900/30',
        tone === 'warn' && 'bg-amber-50 dark:bg-amber-900/25',
        tone === 'info' && 'bg-sky-50 dark:bg-sky-900/25',
        tone === 'danger' && 'bg-red-50 dark:bg-red-900/25',
      )}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-[200px] flex-1">{children}</div>
      {action}
    </div>
  );
}

/** Card-shaped loading placeholder (initial loads — never a bare spinner). */
export function SettingsSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <div className="flex flex-col gap-5" role="status" aria-label="Loading">
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="rounded-2xl border border-line bg-surface p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-2 h-3 w-72 max-w-full" />
          <div className="mt-5 flex flex-col gap-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function CopyField({ label, value, hint }: { label: string; value: string; hint?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-ink">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[12.5px] text-ink">
          {value || '—'}
        </code>
        <button
          type="button"
          onClick={() => {
            if (!value) return;
            navigator.clipboard?.writeText(value).catch(() => undefined);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-xs font-semibold text-ink hover:bg-sunken"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check size={14} className="text-brand-600" /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function WebhookDot({ label, on }: { label: string; on: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-2.5 w-2.5 rounded-full', on ? 'bg-brand-500' : 'bg-gray-300')} />
      <code className="text-xs text-muted">{label}</code>
    </span>
  );
}

export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 break-all text-sm capitalize text-ink">{value}</p>
    </div>
  );
}

export function templateBody(t: Template): string {
  const body = t.content?.components?.find(
    (c) => (c.type || '').toString().toLowerCase() === 'body',
  );
  return body?.text ?? '';
}

export function extractSlots(text: string): string[] {
  const found = new Set<string>();
  const re = /\{\{(\d+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) found.add(m[1]);
  return Array.from(found).sort((a, b) => Number(a) - Number(b));
}
