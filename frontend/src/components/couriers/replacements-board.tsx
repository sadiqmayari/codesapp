'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Printer, FileText, Package, Loader2 } from 'lucide-react';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import {
  listReplacements,
  generateLabels,
  generateLoadsheetsForSelection,
  COURIER_LABELS,
  STATUS_LABELS,
  type ReplacementBoardRow,
} from '@/lib/couriers';
import type { CourierType, ShipmentStatus } from '@/lib/couriers';

/**
 * Dispatch → Replacements board. Replacement parcels are kept out of the normal
 * to-book / manifest worklists; this is where they're dispatched. Grouped by
 * courier (labels + loadsheets are per-courier), select → print labels or
 * generate a loadsheet — reusing the same endpoints as normal dispatch.
 */
export function ReplacementsBoard() {
  const toast = useToast();
  const [rows, setRows] = useState<ReplacementBoardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listReplacements());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load replacements');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Group by courier, keeping insertion (newest-first) order.
  const groups = useMemo(() => {
    const m = new Map<CourierType, ReplacementBoardRow[]>();
    for (const r of rows) {
      const g = m.get(r.courierType) ?? [];
      g.push(r);
      m.set(r.courierType, g);
    }
    return Array.from(m.entries());
  }, [rows]);

  const toggle = (id: number) =>
    setSel((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleGroup = (courier: CourierType, ids: number[]) =>
    setSel((cur) => {
      const next = new Set(cur);
      const allOn = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const selectedIn = (ids: number[]) => ids.filter((id) => sel.has(id));

  const printLabels = async (ids: number[]) => {
    if (!ids.length) return;
    setBusy(`labels:${ids[0]}`);
    try {
      const res = await generateLabels(ids);
      const w = window.open('', '_blank');
      if (!w) {
        toast.error('Allow pop-ups to print labels.');
        return;
      }
      const frames = res.labels
        .map((l) => `<div class="lbl"><iframe src="${l.url}"></iframe></div>`)
        .join('');
      w.document.write(
        `<!doctype html><title>Labels — ${res.courier}</title><style>body{margin:0}iframe{width:100%;height:100vh;border:0}</style>${frames}`,
      );
      w.document.close();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not fetch labels');
    } finally {
      setBusy(null);
    }
  };

  const genLoadsheet = async (ids: number[]) => {
    if (!ids.length) return;
    setBusy(`ls:${ids[0]}`);
    try {
      await generateLoadsheetsForSelection(ids);
      toast.success('Loadsheet queued — download it from Dispatch → Manifests.');
      setSel(new Set());
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to generate loadsheet');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Replacement parcels — dispatch them here (kept out of the normal queue).
        </p>
        <button onClick={load} className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900">
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="p-10 text-center text-gray-400 text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="p-10 text-center text-gray-400 text-sm bg-white rounded-xl border border-gray-200">
          No replacement parcels yet. Book one from a support ticket.
        </div>
      ) : (
        groups.map(([courier, list]) => {
          const dispatchable = list.filter((r) => r.labelReady && !r.onLoadsheet).map((r) => r.id);
          const chosen = selectedIn(dispatchable);
          const allOn = dispatchable.length > 0 && dispatchable.every((id) => sel.has(id));
          return (
            <div key={courier} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="flex items-center gap-2.5 px-3 py-2.5 bg-gray-50 border-b border-gray-100">
                <input
                  type="checkbox"
                  checked={allOn}
                  onChange={() => toggleGroup(courier, dispatchable)}
                  disabled={dispatchable.length === 0}
                  className="w-4 h-4 accent-green-600"
                />
                <span className="font-bold text-sm">{COURIER_LABELS[courier]}</span>
                <span className="text-xs text-gray-500">
                  {list.length} parcel{list.length > 1 ? 's' : ''}
                  {chosen.length > 0 ? ` · ${chosen.length} selected` : ''}
                </span>
                <div className="ml-auto flex gap-2">
                  <button
                    onClick={() => printLabels(chosen)}
                    disabled={chosen.length === 0 || busy != null}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-1.5 border border-gray-200 text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                  >
                    {busy === `labels:${chosen[0]}` ? <Loader2 size={13} className="animate-spin" /> : <Printer size={13} />} Labels
                  </button>
                  <button
                    onClick={() => genLoadsheet(chosen)}
                    disabled={chosen.length === 0 || busy != null}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-1.5 bg-green-600 text-white hover:bg-green-700 disabled:opacity-40"
                  >
                    {busy === `ls:${chosen[0]}` ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />} Generate loadsheet
                  </button>
                </div>
              </div>

              <div className="divide-y divide-gray-50">
                {list.map((r) => {
                  const selectable = r.labelReady && !r.onLoadsheet;
                  return (
                    <div key={r.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                      <input
                        type="checkbox"
                        checked={sel.has(r.id)}
                        onChange={() => toggle(r.id)}
                        disabled={!selectable}
                        className="w-4 h-4 accent-green-600 disabled:opacity-30"
                      />
                      <Package size={15} className="text-gray-300 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-gray-900 truncate">
                          {r.orderName || `#${r.id}`}
                          {r.contactName && <span className="ml-2 font-normal text-gray-500">{r.contactName}</span>}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">
                          {r.city || '—'}
                          {r.trackingNumber && (
                            <>
                              {' · '}
                              {r.trackingUrl ? (
                                <a href={r.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-green-700 hover:underline">
                                  {r.trackingNumber}
                                </a>
                              ) : (
                                <span className="font-mono">{r.trackingNumber}</span>
                              )}
                            </>
                          )}
                          {r.onLoadsheet && <span className="ml-1 text-blue-500">· on loadsheet</span>}
                        </div>
                      </div>
                      <span className="text-xs font-medium text-gray-500 shrink-0">
                        {STATUS_LABELS[r.status as ShipmentStatus] ?? r.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
