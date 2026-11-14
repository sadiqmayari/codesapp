'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock, History, Undo2, XCircle } from 'lucide-react';
import { cn, fmtDateTime } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { money } from '@/lib/format-number';
import { useToast } from '@/components/toast';
import { ConfirmDialog } from '@/components/ui/modal';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Panel } from '@/components/growth/ui';
import { useGrowth } from '@/components/growth/growth-filters';
import { useBaseCurrency } from '@/components/growth/insights';
import { ACTION_LABEL, describePatch, growthManageApi, type ChangeLogRow, type EntityPatch } from '@/lib/growth-manage';

/** Every change made to ads from CodesApp, grouped by publish batch, with Undo. */
export default function GrowthActivityPage() {
  const { mode, version } = useGrowth();
  const cur = useBaseCurrency();
  const toast = useToast();
  const [rows, setRows] = useState<ChangeLogRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ batchId?: string; logId?: number; label: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    growthManageApi
      .log(undefined, 200)
      .then((r) => {
        setRows(r);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof ApiError ? e.userMessage : 'Could not load the activity.'));
  }, []);
  useEffect(load, [load, version]);

  const batches = useMemo(() => {
    const m = new Map<string, ChangeLogRow[]>();
    for (const r of rows ?? []) {
      const k = r.batchId ?? `log:${r.id}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return Array.from(m.entries());
  }, [rows]);

  const fmt = (v: number) => money(v, cur, mode);

  const undo = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const r = await growthManageApi.undo({ batchId: confirm.batchId, logId: confirm.logId });
      toast[r.ok ? 'success' : 'error'](r.ok ? 'Reverted on Meta' : r.results.find((x) => !x.ok)?.error ?? 'Partly reverted');
      setConfirm(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Undo failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Activity" hint="Every change made to your ads from CodesApp. Undo restores the previous values. Created or duplicated objects are paused, never deleted.">
      {err && <p className="py-6 text-sm text-red-600">{err}</p>}
      {!rows && !err && <SkeletonRows rows={6} />}
      {rows && !rows.length && <EmptyState icon={History} title="No changes yet" description="Pause, budget and bid changes you publish from Campaigns show up here." compact />}
      {rows && rows.length > 0 && (
        <ol className="space-y-3">
          {batches.map(([k, list]) => {
            const head = list[list.length - 1];
            const undoable = list.filter((r) => r.canUndo);
            const isBatch = !!head.batchId && list.length > 1;
            return (
              <li key={k} className="rounded-xl border border-line">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-sunken/50 px-4 py-2">
                  <div className="text-xs text-muted">
                    <span className="font-bold text-ink">{head.userName ?? 'Someone'}</span> · {fmtDateTime(head.createdAt)}
                    {isBatch && <span> · {list.length} changes</span>}
                  </div>
                  {undoable.length > 0 && (
                    <button type="button"
                      onClick={() => setConfirm(isBatch ? { batchId: head.batchId!, label: `${undoable.length} changes` } : { logId: undoable[0].id, label: undoable[0].entityName ?? 'this change' })}
                      className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs font-semibold text-ink hover:bg-sunken">
                      <Undo2 size={12} /> {isBatch ? 'Undo batch' : 'Undo'}
                    </button>
                  )}
                </div>
                <ul className="divide-y divide-line">
                  {list.map((r) => {
                    const Icon = r.result === 'ok' ? CheckCircle2 : r.result === 'failed' ? XCircle : Clock;
                    const after = r.after ?? {};
                    const detail = r.action === 'create' || r.action === 'duplicate'
                      ? `Paused · ${Object.entries(after).filter(([key]) => /Id$/.test(key) || key === 'newIds').map(([, v]) => String(v)).join(', ')}`
                      : describePatch(after as EntityPatch, fmt).join(' · ');
                    const before = r.action === 'create' || r.action === 'duplicate' ? '' : describePatch((r.before ?? {}) as EntityPatch, fmt).join(' · ');
                    return (
                      <li key={r.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                        <Icon size={16} className={cn('mt-0.5 shrink-0', r.result === 'ok' ? 'text-emerald-600' : r.result === 'failed' ? 'text-red-600' : 'text-muted')} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-bold text-ink">{ACTION_LABEL[r.action] ?? r.action}</span>
                            <span className="truncate text-ink">{r.entityName ?? r.entityId}</span>
                            <span className="text-xs capitalize text-muted">{r.level === 'adset' ? 'ad set' : r.level}</span>
                            {r.undoneAt && <span className="rounded-full bg-sunken px-1.5 text-[10px] font-bold text-muted">UNDONE</span>}
                          </div>
                          <div className="mt-0.5 text-xs text-muted">
                            {before && <><span className="line-through decoration-muted/60">{before}</span> → </>}
                            <span className="font-semibold text-ink">{detail}</span>
                          </div>
                          {r.error && <div className="mt-0.5 text-xs text-red-600 dark:text-red-400">{r.error}</div>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
      <ConfirmDialog open={!!confirm} onCancel={() => setConfirm(null)} onConfirm={undo} busy={busy} title="Undo on Meta?" confirmLabel="Undo"
        message={`This restores the previous settings for ${confirm?.label ?? ''} in Meta. It is logged too.`} />
    </Panel>
  );
}
