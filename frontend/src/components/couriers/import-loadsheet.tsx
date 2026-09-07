'use client';

import { useState } from 'react';
import { DownloadCloud, Loader2, ChevronDown } from 'lucide-react';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import {
  importLoadsheet,
  COURIER_LABELS,
  COURIER_TYPES,
  type CourierType,
} from '@/lib/couriers';

/**
 * Recover an already-generated courier loadsheet by its id — for when the
 * courier created one (e.g. on their portal, or an attempt whose response we
 * lost) but it isn't in CodesApp. Downloads the PDF + attaches the matching
 * parcels so it shows in Manifests. Only couriers with a download-by-id API
 * (Leopards) accept it; others return a clear message.
 */
export function ImportLoadsheet({ onImported }: { onImported?: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [courier, setCourier] = useState<CourierType>('leopards');
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!id.trim()) return;
    setBusy(true);
    try {
      const r = await importLoadsheet(courier, id.trim());
      toast.success(
        `Imported ${COURIER_LABELS[courier]} loadsheet ${r.loadsheetId} — ` +
          `${r.matched}/${r.onLoadsheet} parcels matched` +
          (r.unmatched ? ` (${r.unmatched} not in CodesApp)` : '') +
          (r.pdf ? ', PDF attached.' : ', no PDF returned.'),
      );
      setId('');
      setOpen(false);
      onImported?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-semibold text-gray-700"
      >
        <DownloadCloud size={16} className="text-gray-400" />
        Import a loadsheet from the courier (by load-sheet #)
        <ChevronDown
          size={16}
          className={`ml-auto text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="border-t border-gray-100 p-4 space-y-3">
          <p className="text-xs text-gray-500">
            Use this when a courier already generated a loadsheet (on their portal,
            or one CodesApp lost mid-way) — it downloads the PDF and links the
            matching parcels so it appears in Manifests.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">
                Courier
              </label>
              <select
                value={courier}
                onChange={(e) => setCourier(e.target.value as CourierType)}
                className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
              >
                {COURIER_TYPES.map((c) => (
                  <option key={c} value={c}>
                    {COURIER_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">
                Load-sheet #
              </label>
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && run()}
                placeholder="e.g. 7779628"
                className="block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
            </div>
            <button
              onClick={run}
              disabled={busy || !id.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
