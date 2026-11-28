'use client';

import Link from 'next/link';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PlanAccess } from '@/lib/dashboard';
import { Ring } from './kit';

interface Step {
  key: string;
  title: string;
  hint: string;
  done: boolean;
  cta: string;
  href: string;
}

export function setupSteps(plan: PlanAccess | null): Step[] {
  const used = (k: string) => plan?.limits.find((l) => l.key === k)?.used ?? 0;
  return [
    { key: 'wa', title: 'Connect WhatsApp', hint: 'Your business number, so customers can message you', done: used('numbers') > 0, cta: 'Connect', href: '/settings/whatsapp' },
    { key: 'store', title: 'Connect your store', hint: 'Shopify or WooCommerce orders, products and confirmations', done: used('stores') > 0, cta: 'Connect', href: '/settings/stores' },
    { key: 'contacts', title: 'Import contacts', hint: 'A CSV of your customers', done: used('contacts') > 0, cta: 'Import', href: '/contacts' },
    { key: 'templates', title: 'Create your first template', hint: 'Needed to message a customer after 24 hours', done: used('templates') > 0, cta: 'Create', href: '/templates' },
    { key: 'team', title: 'Invite your team', hint: 'Agents to answer chats and confirm orders', done: used('seats') > 1, cta: 'Invite', href: '/settings/team' },
    { key: 'ai', title: 'Turn on the AI assistant', hint: 'Answers product and order questions for you', done: !!plan?.ai?.on, cta: 'Set up', href: '/settings/ai' },
  ];
}

/** Shown on the owner/admin dashboard until the first four steps are done. */
export function SetupChecklist({ plan, full }: { plan: PlanAccess | null; full: boolean }) {
  const steps = setupSteps(plan);
  const done = steps.filter((s) => s.done).length;
  const firstOpen = steps.find((s) => !s.done)?.key;
  return (
    <section aria-label="Set up your workspace" className={cn('grid gap-4', full && 'lg:grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)]')}>
      {full && (
        <div className="flex flex-col justify-center gap-4 rounded-[22px] bg-navy p-7 text-white">
          <Ring pct={(done / steps.length) * 100} label={`${done}/${steps.length}`} size={132} ariaLabel={`${done} of ${steps.length} setup steps done`} />
          <h2 className="text-[26px] font-extrabold leading-tight tracking-tight">Let&apos;s get you selling on WhatsApp</h2>
          <p className="text-sm leading-relaxed text-[#C7CED9]">
            Each step unlocks part of this dashboard. Orders, sales and team numbers appear as soon as there is data.
          </p>
        </div>
      )}
      <div className="rounded-2xl border border-line bg-surface p-5">
        {!full && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[15px] font-extrabold text-ink">Finish setting up</h2>
            <span className="text-[13px] text-muted">
              {done} of {steps.length} done
            </span>
          </div>
        )}
        <ol className="flex flex-col gap-2.5">
          {steps.map((s, i) => (
            <li key={s.key} className="flex items-center gap-3.5 rounded-xl border border-line px-3.5 py-3">
              <span
                className={cn(
                  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-extrabold',
                  s.done ? 'bg-emerald-500 text-[#04150C]' : 'bg-sunken text-muted',
                )}
                aria-hidden="true"
              >
                {s.done ? <Check size={16} /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-extrabold text-ink">
                  {s.title}
                  {s.done && <span className="sr-only"> (done)</span>}
                </div>
                <div className="text-[13px] text-muted">{s.hint}</div>
              </div>
              <Link
                href={s.href}
                className={cn(
                  'inline-flex h-9 shrink-0 items-center rounded-xl px-3.5 text-[13px] font-extrabold',
                  s.key === firstOpen
                    ? 'bg-emerald-500 text-[#04150C] hover:bg-emerald-400'
                    : 'border border-line text-ink hover:border-emerald-500',
                )}
              >
                {s.done ? 'Edit' : s.cta}
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
