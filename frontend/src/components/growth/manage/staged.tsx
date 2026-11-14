'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Layers, Loader2, Undo2, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { fullMoney, money } from '@/lib/format-number';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { useGrowth } from '@/components/growth/growth-filters';
import {
  describePatch,
  growthManageApi,
  type Change,
  type EntityLevel,
  type EntityPatch,
  type PreviewItem,
  type PublishResult,
} from '@/lib/growth-manage';

export interface StagedItem {
  key: string;
  name: string;
  change: Change;
}

interface StagedCtx {
  items: StagedItem[];
  stage: (change: Change, name: string) => void;
  unstage: (key: string) => void;
  clear: () => void;
  /** Merged staged patch for an entity (table shows the staged value with a violet marker). */
  pendingFor: (level: EntityLevel, id: string) => EntityPatch | null;
  scaleFor: (campaignId: string) => number | null;
  openReview: () => void;
  currency: string | null;
  setCurrency: (c: string | null) => void;
}

const Ctx = createContext<StagedCtx | null>(null);

export const keyOf = (c: Change) => (c.kind === 'scale' ? `scale:${c.campaignId}` : `${c.level}:${c.entityId}`);

export function useStaged() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStaged must be used inside StagedProvider');
  return v;
}

export function StagedProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<StagedItem[]>([]);
  const [review, setReview] = useState(false);
  const [currency, setCurrency] = useState<string | null>(null);

  const stage = useCallback((change: Change, name: string) => {
    setItems((list) => {
      const key = keyOf(change);
      const i = list.findIndex((x) => x.key === key);
      if (i < 0) return [...list, { key, name, change }];
      const prev = list[i].change;
      const merged: Change =
        prev.kind === 'patch' && change.kind === 'patch' ? { ...prev, patch: { ...prev.patch, ...change.patch } } : change;
      const next = [...list];
      next[i] = { key, name, change: merged };
      return next;
    });
  }, []);
  const unstage = useCallback((key: string) => setItems((l) => l.filter((x) => x.key !== key)), []);
  const clear = useCallback(() => setItems([]), []);
  const pendingFor = useCallback(
    (level: EntityLevel, id: string) => {
      const it = items.find((x) => x.key === `${level}:${id}`);
      return it && it.change.kind === 'patch' ? it.change.patch : null;
    },
    [items],
  );
  const scaleFor = useCallback(
    (campaignId: string) => {
      const it = items.find((x) => x.key === `scale:${campaignId}`);
      return it && it.change.kind === 'scale' ? it.change.pct : null;
    },
    [items],
  );

  // Don't lose staged edits on an accidental tab close.
  useEffect(() => {
    if (!items.length) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [items.length]);

  const value = useMemo<StagedCtx>(
    () => ({ items, stage, unstage, clear, pendingFor, scaleFor, openReview: () => setReview(true), currency, setCurrency }),
    [items, stage, unstage, clear, pendingFor, scaleFor, currency],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <StagedBar />
      {review && <ReviewModal onClose={() => setReview(false)} />}
    </Ctx.Provider>
  );
}

function StagedBar() {
  const { items, clear, openReview } = useStaged();
  if (!items.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-3 md:bottom-6">
      <div role="region" aria-label="Staged ad changes"
        className="pointer-events-auto flex w-full max-w-2xl items-center gap-3 rounded-2xl border border-violet-300/40 bg-gray-900 px-4 py-3 text-white shadow-2xl dark:border-violet-500/30">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-violet-500/20 text-violet-200"><Layers size={18} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">{items.length} change{items.length === 1 ? '' : 's'} staged</div>
          <div className="truncate text-xs text-gray-300">{items.map((i) => i.name).join(' · ')}</div>
        </div>
        <button type="button" onClick={clear} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-gray-300 hover:bg-white/10 hover:text-white">Discard</button>
        <button type="button" onClick={openReview}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm font-bold text-gray-900 hover:bg-gray-100">
          Review &amp; publish <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

function Delta({ v, cur, good }: { v: number | null; cur: string | null; good: 'up' | 'down' }) {
  const { mode } = useGrowth();
  if (v == null || Math.abs(v) < 1) return <span className="text-muted">—</span>;
  const pos = v > 0;
  const ok = good === 'up' ? pos : !pos;
  return (
    <span title={fullMoney(v, cur)} className={cn('font-bold tabular-nums', ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
      {pos ? '+' : '−'}{money(Math.abs(v), cur, mode)}
    </span>
  );
}

function ReviewModal({ onClose }: { onClose: () => void }) {
  const { items, unstage, clear, currency } = useStaged();
  const { mode } = useGrowth();
  const toast = useToast();
  const [preview, setPreview] = useState<PreviewItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
  const changes = useMemo(() => items.map((i) => i.change), [items]);

  useEffect(() => {
    if (!changes.length) return;
    let alive = true;
    setPreview(null);
    setErr(null);
    growthManageApi
      .preview(changes)
      .then((r) => alive && setPreview(r.items))
      .catch((e) => alive && setErr(e instanceof ApiError ? e.userMessage : 'Could not preview these changes.'));
    return () => {
      alive = false;
    };
  }, [changes]);

  const fmt = (v: number) => money(v, currency, mode);
  const blocked = preview?.some((p) => p.error) ?? false;
  const turnsOn = preview?.some((p) => p.after.status === 'ACTIVE') ?? false;
  const spendDelta = (preview ?? []).reduce((a, p) => a + (p.spendDeltaMonthly ?? 0), 0);
  const netDelta = (preview ?? []).reduce((a, p) => a + (p.expectedNetDeltaMonthly ?? 0), 0);

  const publish = async () => {
    setBusy(true);
    try {
      const r = await growthManageApi.publish(changes);
      setResult(r);
      const okN = r.results.filter((x) => x.ok).length;
      if (r.ok) {
        clear();
        toast.success(`Published ${okN} change${okN === 1 ? '' : 's'} to Meta`);
      } else {
        // Keep only the failed ones staged so they can be fixed and retried.
        const failed = new Set(r.results.filter((x) => !x.ok).map((x) => x.entityId));
        items.forEach((i) => {
          const id = i.change.kind === 'scale' ? i.change.campaignId : i.change.entityId;
          if (!failed.has(id)) unstage(i.key);
        });
        toast.error(`${okN} published, ${r.results.length - okN} failed`);
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Publishing failed.');
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const r = await growthManageApi.undo({ batchId: result.batchId });
      toast.success(r.ok ? 'Reverted' : 'Partly reverted. Check Activity.');
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Undo failed.');
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Modal open onClose={onClose} title="Published" size="lg"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <button type="button" onClick={undo} disabled={busy || !result.results.some((r) => r.ok)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink hover:bg-sunken disabled:opacity-50">
              <Undo2 size={15} /> Undo this batch
            </button>
            <button type="button" onClick={onClose} className="rounded-lg bg-ink px-4 py-2 text-sm font-bold text-surface">Done</button>
          </div>
        }>
        <ul className="divide-y divide-line">
          {result.results.map((r) => (
            <li key={r.logId} className="flex items-start gap-2.5 py-2.5 text-sm">
              {r.ok ? <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" /> : <XCircle size={17} className="mt-0.5 shrink-0 text-red-600" />}
              <div className="min-w-0">
                <div className="font-semibold text-ink">{r.entityName ?? r.entityId}</div>
                {r.error && <div className="mt-0.5 text-xs text-red-600 dark:text-red-400">{r.error}</div>}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">Meta can take a minute to reflect a change. Every change is in Growth → Activity.</p>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title={`Review ${items.length} change${items.length === 1 ? '' : 's'}`} size="xl"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">
            <span>Spend / mo <Delta v={spendDelta} cur={currency} good="down" /></span>
            <span>Expected net / mo <Delta v={netDelta} cur={currency} good="up" /></span>
          </div>
          <div className="flex items-center gap-2">
            {turnsOn && (
              <label className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                <input type="checkbox" checked={confirmLive} onChange={(e) => setConfirmLive(e.target.checked)} />
                I understand this starts spending
              </label>
            )}
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-semibold text-muted hover:text-ink">Keep editing</button>
            <button type="button" onClick={publish} disabled={busy || !preview || blocked || (turnsOn && !confirmLive)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
              {busy && <Loader2 size={15} className="animate-spin" />} Publish to Meta
            </button>
          </div>
        </div>
      }>
      {err && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{err}</div>}
      {!preview && !err && (
        <div className="flex items-center gap-2 py-10 text-sm text-muted"><Loader2 size={16} className="animate-spin" /> Checking each change against Meta’s rules…</div>
      )}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {items.map((i) => (
          <span key={i.key} className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 py-0.5 pl-2.5 pr-1 text-xs font-semibold text-violet-800 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200">
            {i.name}
            <button type="button" aria-label={`Remove ${i.name} from the batch`} onClick={() => unstage(i.key)} className="rounded-full p-0.5 hover:bg-violet-200/60 dark:hover:bg-violet-800/60"><X size={12} /></button>
          </span>
        ))}
      </div>
      {preview && (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-bold">Object</th>
                <th className="px-3 py-2 font-bold">Before</th>
                <th className="px-3 py-2 font-bold">After</th>
                <th className="px-3 py-2 text-right font-bold">Spend / mo</th>
                <th className="px-3 py-2 text-right font-bold">Exp. net / mo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {preview.map((p) => {
                return (
                  <tr key={`${p.level}:${p.entityId}`} className={cn('align-top', p.error && 'bg-red-50/60 dark:bg-red-950/20')}>
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-ink">{p.entityName ?? p.entityId}</div>
                      <div className="text-xs capitalize text-muted">{p.level === 'adset' ? 'ad set' : p.level}</div>
                    </td>
                    <td className="px-3 py-2.5 text-muted">{describePatch(p.before, fmt).join(' · ') || '—'}</td>
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-violet-700 dark:text-violet-300">{describePatch(p.after, fmt).join(' · ')}</div>
                      {p.error && <div className="mt-1 flex items-start gap-1 text-xs font-semibold text-red-600 dark:text-red-400"><XCircle size={13} className="mt-px shrink-0" />{p.error}</div>}
                      {p.warnings.map((w) => (
                        <div key={w} className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle size={13} className="mt-px shrink-0" />{w}</div>
                      ))}
                    </td>
                    <td className="px-3 py-2.5 text-right"><Delta v={p.spendDeltaMonthly} cur={currency} good="down" /></td>
                    <td className="px-3 py-2.5 text-right"><Delta v={p.expectedNetDeltaMonthly} cur={currency} good="up" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        Expected net uses this campaign’s own spend-to-delivered-revenue curve from the last 60 days. Changes are logged and can be undone from Activity.
      </p>
    </Modal>
  );
}
