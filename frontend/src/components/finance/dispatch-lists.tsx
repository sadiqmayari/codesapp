'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileText, Loader2, Truck } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn, fmtDate, fmtDateTime, zonedYMDString } from '@/lib/utils';
import { periodRange, type PeriodKey } from '@/lib/date-period';
import { useLatestRequest } from '@/lib/use-list-query';
import { useTenantCouriers } from '@/lib/use-tenant-couriers';
import {
  COURIER_LABELS,
  listLoadsheets,
  loadsheetDispatchList,
  type CourierType,
  type LoadsheetBatch,
} from '@/lib/couriers';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';

/**
 * Read-only dispatch lists for the finance role: every loadsheet batch grouped
 * by day, with only the courier's loadsheet PDF and the A-List (dispatch list,
 * payment snapshotted at dispatch) as downloads. Generating, rebuilding, labels
 * and deleting stay on Orders → Dispatch (`ManifestsPanel`).
 */
const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'custom', label: 'Custom' },
];

export function DispatchLists() {
  const toast = useToast();
  const couriers = useTenantCouriers();
  const latest = useLatestRequest();
  const [period, setPeriod] = useState<PeriodKey>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [courier, setCourier] = useState<CourierType | 'all'>('all');
  const [batches, setBatches] = useState<LoadsheetBatch[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBatches(null);
    const range =
      period === 'custom' && !(customFrom && customTo)
        ? periodRange('30d')
        : periodRange(period, { from: customFrom, to: customTo });
    try {
      const rows = await latest(() =>
        listLoadsheets({
          courier: courier === 'all' ? undefined : courier,
          from: range.from,
          to: range.to,
        }),
      );
      if (rows) setBatches(rows.filter((b) => b.status !== 'failed'));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load dispatch lists');
      setBatches([]);
    }
  }, [latest, toast, period, customFrom, customTo, courier]);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; rows: LoadsheetBatch[]; parcels: number }>();
    for (const b of batches ?? []) {
      const key = zonedYMDString(new Date(b.created_at));
      const g = map.get(key) ?? { key, label: fmtDate(b.created_at), rows: [], parcels: 0 };
      g.rows.push(b);
      g.parcels += b.shipment_count;
      map.set(key, g);
    }
    return Array.from(map.values()).sort((a, b) => (a.key < b.key ? 1 : -1));
  }, [batches]);

  const totalParcels = groups.reduce((s, g) => s + g.parcels, 0);

  const openUrl = (url: string, filename: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    a.rel = 'noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const aList = async (b: LoadsheetBatch) => {
    setBusy(`${b.id}`);
    try {
      const res = await loadsheetDispatchList(b.id);
      openUrl(res.url, `a-list-${b.courier_type}-${b.id}.pdf`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not build the A-List');
    } finally {
      setBusy(null);
    }
  };

  const btn =
    'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-line bg-surface">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPeriod(p.key)}
              className={cn(
                'px-3 py-1.5 text-sm',
                period === p.key ? 'bg-brand-600 font-semibold text-white' : 'text-muted hover:bg-sunken',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        {period === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              aria-label="From"
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
            />
            <span className="text-muted">→</span>
            <input
              type="date"
              aria-label="To"
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
            />
          </div>
        )}
        <select
          aria-label="Courier"
          value={courier}
          onChange={(e) => setCourier(e.target.value as CourierType | 'all')}
          className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm"
        >
          <option value="all">All couriers</option>
          {couriers.configured.map((c) => (
            <option key={c} value={c}>
              {COURIER_LABELS[c] ?? c}
            </option>
          ))}
        </select>
        {batches && batches.length > 0 && (
          <span className="ml-auto text-xs text-muted">
            View &amp; download only · {batches.length} manifest{batches.length === 1 ? '' : 's'} ·{' '}
            {totalParcels.toLocaleString()} parcels
          </span>
        )}
      </div>

      {batches === null ? (
        <SkeletonRows rows={5} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No dispatch lists in this period"
          description="Pick a wider period or another courier."
        />
      ) : (
        groups.map((g) => (
          <section key={g.key} className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-2.5">
              <span className="text-sm font-semibold text-ink">{g.label}</span>
              <span className="text-xs text-muted">
                {g.rows.length} manifest{g.rows.length === 1 ? '' : 's'} · {g.parcels.toLocaleString()} parcels
              </span>
            </div>
            <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {g.rows.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <span className="w-24 font-semibold text-ink">{COURIER_LABELS[b.courier_type] ?? b.courier_type}</span>
                  <span className="w-40 text-sm text-muted">
                    {b.courier_loadsheet_id ? `Loadsheet #${b.courier_loadsheet_id}` : `Batch #${b.id}`}
                  </span>
                  <span className="w-24 text-sm text-muted">
                    {b.shipment_count.toLocaleString()} parcel{b.shipment_count === 1 ? '' : 's'}
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      b.status === 'ready' ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-700',
                    )}
                  >
                    {b.status === 'ready' ? 'Ready' : b.status === 'awaiting_pdf' ? 'PDF pending' : 'Generating'}
                  </span>
                  <span className="text-xs text-muted">{fmtDateTime(b.created_at)}</span>
                  <span className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!b.pdf_media_url}
                      onClick={() =>
                        b.pdf_media_url &&
                        openUrl(b.pdf_media_url, `loadsheet-${b.courier_type}-${b.id}.pdf`)
                      }
                      title={b.pdf_media_url ? 'Courier loadsheet PDF' : 'The courier has not sent the PDF yet'}
                      className={cn(btn, 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100')}
                    >
                      <Download className="h-3 w-3" /> Loadsheet
                    </button>
                    <button
                      type="button"
                      disabled={busy === `${b.id}`}
                      onClick={() => aList(b)}
                      title="Dispatch list — one row per order, payment as at dispatch"
                      className={cn(btn, 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100')}
                    >
                      {busy === `${b.id}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <FileText className="h-3 w-3" />
                      )}
                      A-List
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
