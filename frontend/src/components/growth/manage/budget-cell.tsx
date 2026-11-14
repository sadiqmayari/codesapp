'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fullMoney, money } from '@/lib/format-number';
import type { CampaignNode } from '@/lib/growth';
import { useGrowth } from '@/components/growth/growth-filters';
import { useStaged } from './staged';

const QUICK = [-20, -10, 10, 20, 50];

/** Fixed-position popover anchored to a trigger (never clipped by the scrolling table). */
export function Popover({ anchor, onClose, children, width = 300 }: { anchor: HTMLElement; onClose: () => void; children: React.ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 260;
    const below = r.bottom + 6 + h < window.innerHeight;
    setPos({
      top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - h),
      left: Math.min(window.innerWidth - width - 8, Math.max(8, r.right - width)),
    });
  }, [anchor, width]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const scroll = () => onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', scroll);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', scroll);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} role="dialog" style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
      className="fixed z-[60] whitespace-normal rounded-xl border border-line bg-surface p-3 text-left text-sm font-normal normal-case text-ink shadow-2xl">
      {children}
    </div>,
    document.body,
  );
}

/** Budget for a row: editable where the budget lives, otherwise a hint pointing to the owner. */
export function BudgetCell({ n, canEdit }: { n: CampaignNode; canEdit: boolean }) {
  const { mode } = useGrowth();
  const { stage, pendingFor, scaleFor, currency } = useStaged();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const owns = n.budgetOwner === n.level && n.level !== 'ad';
  const lifetime = n.budgetType === 'lifetime';
  const current = lifetime ? n.lifetimeBudget ?? null : n.dailyBudget;
  const pending = pendingFor(n.level, n.id);
  const staged = pending ? (lifetime ? pending.lifetimeBudget : pending.dailyBudget) ?? null : null;
  const pct = n.level === 'campaign' ? scaleFor(n.id) : null;
  // ABO campaign: total of its ad sets' budgets; scaling stages a proportional change on each.
  const childSum = n.level === 'campaign' && n.budgetOwner === 'adset'
    ? n.children.reduce((a, c) => a + ((c.budgetType === 'lifetime' ? c.lifetimeBudget : c.dailyBudget) ?? 0), 0)
    : null;
  const shown = owns ? current : childSum || null;
  const [val, setVal] = useState('');
  useEffect(() => {
    if (open) setVal(String(Math.round(staged ?? shown ?? 0)));
  }, [open, staged, shown]);

  if (n.level === 'ad') return <span className="text-muted">—</span>;
  if (!owns && !(childSum && childSum > 0)) {
    return <span className="text-xs text-muted" title={n.level === 'adset' ? 'Advantage+ campaign budget is set on the campaign' : 'Budgets are set on the ad sets'}>{n.level === 'adset' ? 'Campaign budget' : '—'}</span>;
  }
  const value = staged ?? (pct != null && shown != null ? shown * (1 + pct / 100) : shown);
  const isStaged = staged != null || pct != null;
  const num = Number(val);
  const changePct = shown ? ((num - shown) / shown) * 100 : 0;

  const apply = () => {
    if (!(num > 0) || !shown) return;
    if (owns) {
      stage({ kind: 'patch', level: n.level, entityId: n.id, patch: lifetime ? { lifetimeBudget: num } : { dailyBudget: num } }, `${n.name} · budget`);
    } else {
      stage({ kind: 'scale', campaignId: n.id, pct: Math.round(changePct) }, `${n.name} · ad set budgets ${changePct >= 0 ? '+' : ''}${Math.round(changePct)}%`);
    }
    setOpen(false);
  };

  return (
    <>
      <button ref={btn} type="button" disabled={!canEdit} onClick={() => setOpen((v) => !v)} title={fullMoney(value, currency)}
        className={cn('group inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 tabular-nums',
          isStaged ? 'bg-violet-50 font-bold text-violet-700 ring-1 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-200 dark:ring-violet-800' : 'text-ink',
          canEdit && 'hover:bg-sunken')}>
        {money(value, currency, mode)}
        <span className="text-[10px] font-semibold text-muted">{lifetime ? 'total' : '/day'}</span>
        {canEdit && <Pencil size={11} className="text-muted opacity-0 transition group-hover:opacity-100" />}
      </button>
      {open && btn.current && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)}>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-muted">{lifetime ? 'Lifetime budget' : 'Daily budget'}</span>
            <span className="text-xs text-muted">{owns ? (n.level === 'campaign' ? 'Campaign budget' : 'Ad set budget') : `Across ${n.children.length} ad sets`}</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-sunken/50 px-2.5 py-2 focus-within:ring-2 focus-within:ring-violet-400">
            <span className="text-xs font-semibold text-muted">{currency ?? ''}</span>
            <input autoFocus inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value.replace(/[^\d.]/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && apply()} aria-label="New budget"
              className="w-full bg-transparent text-lg font-bold tabular-nums text-ink outline-none" />
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {QUICK.map((q) => (
              <button key={q} type="button" onClick={() => setVal(String(Math.round(((shown ?? 0) * (1 + q / 100)) / 10) * 10))}
                className="rounded-md border border-line px-2 py-0.5 text-xs font-semibold text-ink hover:bg-sunken">{q > 0 ? '+' : ''}{q}%</button>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between text-xs">
            <span className="text-muted">Now {money(shown, currency, mode)}</span>
            {shown != null && num > 0 && Math.abs(changePct) >= 0.5 && (
              <span className={cn('font-bold', changePct > 0 ? 'text-emerald-600' : 'text-red-600')}>{changePct > 0 ? '+' : ''}{changePct.toFixed(0)}%</span>
            )}
          </div>
          {Math.abs(changePct) > 20 && (
            <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle size={13} className="mt-px shrink-0" /> Over 20% can restart Meta’s learning phase. Steps of ~20% every 2–3 days are safer.
            </p>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted hover:text-ink">Cancel</button>
            <button type="button" onClick={apply} disabled={!(num > 0) || Math.abs(changePct) < 0.5}
              className="rounded-lg bg-ink px-3 py-1.5 text-xs font-bold text-surface disabled:opacity-40">Stage change</button>
          </div>
          <p className="mt-2 text-[11px] text-muted">Nothing changes in Meta until you review and publish.</p>
        </Popover>
      )}
    </>
  );
}

/** On/off switch (configured status). Staging an off→on shows the "starts spending" confirm at publish. */
export function StatusSwitch({ n, canEdit }: { n: CampaignNode; canEdit: boolean }) {
  const { stage, pendingFor, unstage } = useStaged();
  const base = (n.configuredStatus ?? n.status ?? '').toUpperCase();
  if (!/^(ACTIVE|PAUSED)$/.test(base)) return null;
  const pending = pendingFor(n.level, n.id)?.status;
  const on = (pending ?? base) === 'ACTIVE';
  const staged = pending != null && pending !== base;
  const flip = () => {
    const next = on ? 'PAUSED' : 'ACTIVE';
    if (next === base) {
      // Flipping back to the live state = un-stage just the status part.
      const rest = { ...(pendingFor(n.level, n.id) ?? {}) };
      delete rest.status;
      unstage(`${n.level}:${n.id}`);
      if (Object.keys(rest).length) stage({ kind: 'patch', level: n.level, entityId: n.id, patch: rest }, n.name);
      return;
    }
    stage({ kind: 'patch', level: n.level, entityId: n.id, patch: { status: next } }, `${n.name} · ${next === 'ACTIVE' ? 'turn on' : 'pause'}`);
  };
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={on ? 'Turn off' : 'Turn on'} disabled={!canEdit} onClick={flip}
      title={staged ? 'Staged — publish to apply' : on ? 'On' : 'Off'}
      className={cn('relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50',
        on ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600', staged && 'ring-2 ring-violet-400 ring-offset-1 ring-offset-surface')}>
      <span className={cn('inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition', on ? 'translate-x-[15px]' : 'translate-x-0.5')} />
    </button>
  );
}
