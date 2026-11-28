'use client';

import Link from 'next/link';
import { ShieldCheck, X } from 'lucide-react';
import { cn, fmtDate } from '@/lib/utils';
import type { PlanAccess, WidgetId } from '@/lib/dashboard';
import { WIDGETS } from '@/lib/dashboard';
import { Switch } from '@/components/ui/switch';
import { Chip, Panel, UsageBar } from './kit';

/** Strip shown when CodesApp has customised this workspace (any super-admin override). */
export function CodesAppNotice({ plan }: { plan: PlanAccess | null }) {
  if (!plan || plan.overrides.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-violet-50 px-4 py-3 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200">
      <ShieldCheck size={18} aria-hidden="true" />
      <p className="min-w-0 flex-[1_1_420px] text-[13px] font-semibold">
        CodesApp customised your workspace: <span className="font-extrabold">{plan.overrides.join(' · ')}</span>.
      </p>
      <a href="#dash-plan" className="text-[13px] font-extrabold hover:underline">
        View plan &amp; access
      </a>
    </div>
  );
}

const usd = (cents: number | null | undefined) => (cents == null ? '—' : `$${(cents / 100).toFixed(2)}`);

export function PlanAccessPanel({ plan }: { plan: PlanAccess | null }) {
  if (!plan) return null;
  const off = plan.modules.filter((m) => !m.on);
  const on = plan.modules.filter((m) => m.on).length;
  const ai = plan.ai;
  const aiCap = ai?.effectiveCapCents || ai?.ceilingCents || null;
  return (
    <Panel
      id="dash-plan"
      title="Plan & access"
      description={
        <>
          {plan.plan ?? 'No plan'} · <span className="capitalize">{plan.status}</span>
          {plan.cycle && <> · cycle {fmtDate(plan.cycle.start)} – {fmtDate(new Date(new Date(plan.cycle.end).getTime() - 1))} · next invoice {fmtDate(plan.cycle.end)}</>}
          {plan.unpaid.count > 0 ? (
            <span className="font-bold text-red-700 dark:text-red-300"> · {plan.unpaid.count} unpaid invoice{plan.unpaid.count > 1 ? 's' : ''}</span>
          ) : (
            <> · no balance due</>
          )}
        </>
      }
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="violet">Custom = set for you by CodesApp</Chip>
          <Link href="/billing" className="inline-flex h-9 items-center rounded-xl border border-line px-3 text-[13px] font-bold text-ink hover:border-emerald-500">
            Billing
          </Link>
        </div>
      }
    >
      <div className="grid gap-7 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          {plan.limits.map((l) => {
            const p = l.limit > 0 ? (l.used / l.limit) * 100 : 0;
            return (
              <div key={l.key}>
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[13px]">
                  <span className="inline-flex items-center gap-2 font-extrabold text-ink">
                    {l.label}
                    {l.custom && (
                      <Chip tone="violet" className="h-5 text-[11px]">
                        Custom · plan {l.planLimit.toLocaleString('en-US')}
                      </Chip>
                    )}
                  </span>
                  <span className="tabular-nums text-muted">
                    <strong className="text-ink">{l.used.toLocaleString('en-US')}</strong> / {l.limit.toLocaleString('en-US')}
                  </span>
                </div>
                <UsageBar pct={p} />
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2.5 rounded-xl bg-sunken px-3.5 py-2.5 text-[13px] text-ink">
            {plan.usageLimitAction.custom && <Chip tone="violet">Custom</Chip>}
            {plan.usageLimitAction.value === 'warn_only' ? (
              <span>At 100% your team <strong>keeps working</strong>; you get a warning, not a block.</span>
            ) : (
              <span>At 100% new contacts, templates or seats are <strong>blocked</strong> until you upgrade.</span>
            )}
          </div>
          {plan.graceUntil && (
            <div className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
              Payment grace until <strong>{fmtDate(plan.graceUntil)}</strong>, set by CodesApp.
            </div>
          )}
        </div>

        <div className="flex flex-col gap-5">
          {ai && (
            <div className="rounded-2xl border border-line p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <span className="font-extrabold text-ink">AI spend this month</span>
                <span className="tabular-nums">
                  <strong className="text-ink">{usd(ai.spentCents)}</strong>
                  {aiCap ? <span className="text-muted"> of {usd(aiCap)} cap</span> : <span className="text-muted"> · no cap</span>}
                </span>
              </div>
              <UsageBar className="mt-2.5" pct={aiCap ? (ai.spentCents / aiCap) * 100 : 0} />
              <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted">
                <span>{ai.tenantCapCents ? `Your cap ${usd(ai.tenantCapCents)}` : 'No cap of your own'}</span>
                {ai.ceilingCents ? (
                  <span className={cn(ai.ceilingCustom && 'font-bold text-violet-700 dark:text-violet-300')}>
                    CodesApp ceiling {usd(ai.ceilingCents)}
                    {ai.ceilingCustom ? ' · Custom' : ''}
                  </span>
                ) : null}
              </div>
              {ai.adminDisabled && <p className="mt-2 text-xs font-bold text-red-700 dark:text-red-300">AI is switched off for this workspace by CodesApp.</p>}
            </div>
          )}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[11.5px] font-bold uppercase tracking-[.06em] text-muted">Modules</span>
              <span className="text-xs text-muted">
                {on} of {plan.modules.length} on
              </span>
            </div>
            <ul className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
              {plan.modules.map((m) => (
                <li
                  key={m.key}
                  className={cn(
                    'flex items-center gap-2 rounded-xl border px-3 py-2 text-[13px] font-bold',
                    m.on ? 'border-line bg-surface text-ink' : 'border-dashed border-line text-muted',
                  )}
                >
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', m.on ? 'bg-emerald-500' : 'bg-gray-400')} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{m.label}</span>
                  <span className="text-[11px] font-semibold text-muted">{m.note ?? (m.on ? '' : 'off')}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-[12.5px] text-muted">
              Modules are switched on by CodesApp.{' '}
              {off.length > 0 && (
                <a
                  href={`mailto:admin@codentra.pk?subject=${encodeURIComponent(`Module request: ${off.map((m) => m.label).join(', ')}`)}`}
                  className="font-bold text-brand-700 hover:underline dark:text-brand-300"
                >
                  Ask for {off.length === 1 ? off[0].label : 'a module'}
                </a>
              )}
            </p>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** Customise: which widgets show. Saved per user; owner/admin can also save it as the team default. */
export function CustomisePanel({
  hidden,
  onToggle,
  onClose,
  onSaveTeam,
  onReset,
  canTeam,
  saving,
}: {
  hidden: Set<string>;
  onToggle: (id: WidgetId, show: boolean) => void;
  onClose: () => void;
  onSaveTeam: () => void;
  onReset: () => void;
  canTeam: boolean;
  saving: boolean;
}) {
  return (
    <section aria-label="Customise dashboard" className="rounded-2xl border-2 border-emerald-500 bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-extrabold text-ink">Customise your dashboard</h2>
          <p className="mt-0.5 text-[13px] text-muted">Saved to your account, on every device.{saving ? ' Saving…' : ''}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onReset} className="h-9 rounded-xl border border-line px-3 text-[13px] font-bold text-ink hover:border-emerald-500">
            Use team default
          </button>
          {canTeam && (
            <button type="button" onClick={onSaveTeam} className="h-9 rounded-xl border border-line px-3 text-[13px] font-bold text-ink hover:border-emerald-500">
              Make this the team default
            </button>
          )}
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-emerald-500 px-3.5 text-[13px] font-extrabold text-[#04150C] hover:bg-emerald-400">
            <X size={14} aria-hidden="true" /> Done
          </button>
        </div>
      </div>
      <div className="mt-2 grid gap-x-7 sm:grid-cols-2 lg:grid-cols-3">
        {WIDGETS.map((w) => {
          const show = !hidden.has(w.id);
          return (
            <div key={w.id} className="flex items-center justify-between gap-3 border-b border-line py-2.5 text-sm font-semibold text-ink">
              <span>{w.label}</span>
              <Switch checked={show} onChange={(v) => onToggle(w.id, v)} label={`Show ${w.label}`} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
