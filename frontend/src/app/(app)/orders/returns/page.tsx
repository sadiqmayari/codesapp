'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  PackageCheck,
  ScanLine,
  Download,
  Loader2,
  RotateCcw,
  Calendar,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { zonedMonthRange } from '@/lib/utils';
import {
  getReturnsHistory,
  returnsSheetUrl,
  COURIER_LABELS,
  type ReturnsHistory,
  type ReturnsHistoryDay,
  type CourierType,
} from '@/lib/couriers';

type PresetKey = 'month' | 'lastmonth' | 'custom';

const cmarkBg: Record<string, string> = {
  trax: '#5b62d1',
  leopards: '#cf4457',
  postex: '#2a9d5c',
  rocket: '#2f8fd6',
  mnp: '#c2782a',
};

export default function ReturnsHistoryPage() {
  const toast = useToast();
  const [preset, setPreset] = useState<PresetKey>('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState<ReturnsHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const range = useMemo(() => {
    if (preset === 'month') return zonedMonthRange(0);
    if (preset === 'lastmonth') return zonedMonthRange(-1);
    if (customFrom && customTo) {
      return {
        from: new Date(`${customFrom}T00:00:00`).toISOString(),
        to: new Date(`${customTo}T23:59:59.999`).toISOString(),
      };
    }
    return zonedMonthRange(0);
  }, [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getReturnsHistory(range));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load returns history');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  useEffect(() => {
    load();
  }, [load]);

  const download = async (
    format: 'pdf' | 'csv',
    scope: { from: string; to: string },
    key: string,
  ) => {
    setBusy(key);
    try {
      const { url } = await returnsSheetUrl({ format, from: scope.from, to: scope.to });
      window.open(url, '_blank', 'noreferrer');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not build the sheet');
    } finally {
      setBusy(null);
    }
  };

  const dayLabel = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <RotateCcw size={22} className="text-green-600" /> Returns received
          </h1>
          <p className="text-sm text-gray-500">
            A day-by-day record of parcels received back. Re-download any day&apos;s sheet anytime.
          </p>
        </div>
        <Link
          href="/orders/fulfillment/receive"
          className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-green-700"
        >
          <ScanLine size={15} /> Scan returns
        </Link>
      </div>

      {/* Period + whole-range download */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-gray-200 bg-white">
          {(
            [
              ['month', 'This month'],
              ['lastmonth', 'Last month'],
              ['custom', 'Custom'],
            ] as Array<[PresetKey, string]>
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setPreset(k)}
              className={
                'px-3 py-1.5 text-sm ' +
                (preset === k ? 'bg-green-600 text-white' : 'text-gray-600 hover:bg-gray-50')
              }
            >
              {label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
            />
            <span className="text-gray-400">→</span>
            <input
              type="date"
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
            />
          </div>
        )}
        {(data?.totalParcels ?? 0) > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-gray-500">
              {data!.totalParcels.toLocaleString()} parcel{data!.totalParcels === 1 ? '' : 's'} · whole range:
            </span>
            <DlBtn label="PDF" busy={busy === 'range-pdf'} onClick={() => download('pdf', range, 'range-pdf')} />
            <DlBtn label="CSV" busy={busy === 'range-csv'} onClick={() => download('csv', range, 'range-csv')} />
          </div>
        )}
      </div>

      {/* Day list */}
      <div className="space-y-2">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-7 w-7 animate-spin text-green-500" />
          </div>
        ) : (data?.days.length ?? 0) === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-200 bg-white py-16 text-center text-gray-400">
            <PackageCheck size={28} />
            <p className="text-sm">No returns received in this period.</p>
            <Link href="/orders/fulfillment/receive" className="text-sm font-medium text-green-700 hover:underline">
              Scan some returns →
            </Link>
          </div>
        ) : (
          data!.days.map((d: ReturnsHistoryDay) => (
            <div
              key={d.day}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-gray-200 bg-white px-4 py-3"
            >
              <span className="flex items-center gap-2">
                <Calendar size={15} className="text-gray-400" />
                <span className="font-semibold text-gray-800">{dayLabel(d.from)}</span>
              </span>
              <span className="text-sm text-gray-500">
                <b className="font-semibold text-gray-700 tabular-nums">{d.parcels}</b> parcel
                {d.parcels === 1 ? '' : 's'}
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                {d.couriers.map((c) => (
                  <span
                    key={c.courier}
                    className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-600"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: cmarkBg[courierKey(c.courier)] ?? '#9ca3af' }}
                    />
                    {c.courier} {c.count}
                  </span>
                ))}
              </span>
              <span className="ml-auto flex items-center gap-2">
                <DlBtn label="PDF" busy={busy === `${d.day}-pdf`} onClick={() => download('pdf', d, `${d.day}-pdf`)} />
                <DlBtn label="CSV" busy={busy === `${d.day}-csv`} onClick={() => download('csv', d, `${d.day}-csv`)} />
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Map a courier DISPLAY name back to its key for the dot colour (best-effort).
function courierKey(display: string): string {
  const entry = Object.entries(COURIER_LABELS).find(([, label]) => label === display);
  return (entry?.[0] as CourierType) ?? display.toLowerCase();
}

function DlBtn({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
      {label}
    </button>
  );
}
