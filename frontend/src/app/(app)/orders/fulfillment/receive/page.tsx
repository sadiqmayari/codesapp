'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ScanLine,
  PackageCheck,
  Plus,
  Keyboard,
  Download,
  FileText,
  X,
} from 'lucide-react';
import {
  BrowserMultiFormatReader,
  IScannerControls,
} from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import {
  lookupByTracking,
  lookupByOrder,
  confirmScannedReturns,
  returnsSheetUrl,
  COURIER_LABELS,
  type CourierType,
} from '@/lib/couriers';

type ScanRow = {
  tracking: string; // the AWB (scanned) or a synthetic key for a manual add
  shipmentId: number | null;
  orderName: string | null;
  courier: CourierType | null;
  customerName: string | null;
  pending: boolean;
  notFound: boolean;
  alreadyReceived: boolean;
  manual: boolean; // added by order number (damaged barcode)
};

/** Short WebAudio beep — no asset needed. High = new scan, low = dup/not-found. */
function beep(freq: number, ms = 90) {
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.value = 0.07;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      void ctx.close();
    }, ms);
  } catch {
    /* audio is best-effort */
  }
}

export default function ReceiveScanPage() {
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [camState, setCamState] = useState<'starting' | 'live' | 'error'>('starting');
  const [submitting, setSubmitting] = useState(false);
  // Manual add (damaged barcode → type the order number).
  const [manualInput, setManualInput] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  // Download state: the just-confirmed batch, and the by-date picker.
  const [lastBatch, setLastBatch] = useState<{ ids: number[]; count: number } | null>(null);
  const [sheetBusy, setSheetBusy] = useState<string | null>(null);
  const [dateVal, setDateVal] = useState(() => new Date().toISOString().slice(0, 10));

  // Handle a decoded barcode: dedupe, beep, resolve the order (best-effort).
  const onDecode = useCallback((raw: string) => {
    const tracking = (raw || '').trim();
    if (!tracking) return;
    if (seenRef.current.has(tracking)) {
      beep(320, 70); // duplicate — already in the list
      return;
    }
    seenRef.current.add(tracking);
    beep(880, 90);
    setRows((prev) => [
      {
        tracking,
        shipmentId: null,
        orderName: null,
        courier: null,
        customerName: null,
        pending: true,
        notFound: false,
        alreadyReceived: false,
        manual: false,
      },
      ...prev,
    ]);
    // Resolve the tracking number → order (flags "not found" if it misses).
    lookupByTracking(tracking)
      .then((hit) => {
        setRows((prev) =>
          prev.map((r) =>
            r.tracking === tracking
              ? {
                  ...r,
                  pending: false,
                  notFound: !hit,
                  shipmentId: hit?.shipmentId ?? null,
                  orderName: hit?.orderName ?? null,
                  courier: hit?.courier ?? null,
                  customerName: hit?.customerName ?? null,
                  alreadyReceived: !!hit?.receivedAt,
                }
              : r,
          ),
        );
        if (!hit) beep(320, 70);
      })
      .catch(() => {
        setRows((prev) =>
          prev.map((r) =>
            r.tracking === tracking ? { ...r, pending: false, notFound: true } : r,
          ),
        );
      });
  }, []);

  useEffect(() => {
    // Speed tuning: restrict to the symbologies that actually appear on courier
    // AWB labels (QR + the common 1D barcodes) so each frame decodes fast instead
    // of the reader trying every format; and poll aggressively (short delay
    // between attempts) for rapid, whole-frame scanning.
    const hints = new Map<DecodeHintType, unknown>();
    // Trimmed to the symbologies that actually appear on Pakistani courier AWB
    // labels (CODE_128 dominates; QR + DataMatrix on some). Fewer formats = the
    // decoder does far less work per frame, so a scan resolves faster. The
    // retail-only formats (EAN-13 / ITF / Codabar) were dropped — they never
    // appear on a courier label and were slowing every frame.
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_128,
      BarcodeFormat.QR_CODE,
      BarcodeFormat.CODE_39,
      BarcodeFormat.DATA_MATRIX,
    ]);
    // Don't spend extra CPU on the exhaustive TRY_HARDER pass — a courier label
    // held at reading distance decodes on the fast path.
    hints.set(DecodeHintType.TRY_HARDER, false);
    const reader = new BrowserMultiFormatReader(hints, {
      delayBetweenScanAttempts: 25, // rapid polling for a quick resolve
      delayBetweenScanSuccess: 250, // brief settle after a hit, then keep going
    });
    let cancelled = false;
    reader
      .decodeFromConstraints(
        {
          video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        videoRef.current ?? undefined,
        (result) => {
          if (result) onDecode(result.getText());
        },
      )
      .then((controls) => {
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setCamState('live');
      })
      .catch(() => {
        if (!cancelled) setCamState('error');
      });
    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [onDecode]);

  const removeRow = (tracking: string) => {
    seenRef.current.delete(tracking);
    setRows((prev) => prev.filter((r) => r.tracking !== tracking));
  };

  // Manual add by order number — for parcels whose barcode/QR is too damaged to
  // scan. Resolves the order → shipment and drops it into the same list.
  const addByOrder = async () => {
    const raw = manualInput.trim();
    const digits = raw.replace(/[^0-9]/g, '');
    if (!digits || manualBusy) return;
    const key = `#${digits}`;
    if (seenRef.current.has(key)) {
      toast.info(`Order ${key} is already in the list.`);
      setManualInput('');
      return;
    }
    setManualBusy(true);
    try {
      const hit = await lookupByOrder(digits);
      if (!hit) {
        beep(320, 70);
        toast.error(`No parcel found for order ${key}.`);
        return;
      }
      // Prefer keying by the real AWB so a later scan of the same parcel dedupes.
      const rowKey = hit.tracking || key;
      if (seenRef.current.has(rowKey)) {
        toast.info(`${hit.orderName ?? key} is already in the list.`);
        return;
      }
      seenRef.current.add(rowKey);
      seenRef.current.add(key);
      beep(880, 90);
      setRows((prev) => [
        {
          tracking: rowKey,
          shipmentId: hit.shipmentId,
          orderName: hit.orderName,
          courier: hit.courier,
          customerName: hit.customerName,
          pending: false,
          notFound: false,
          alreadyReceived: !!hit.receivedAt,
          manual: true,
        },
        ...prev,
      ]);
      setManualInput('');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not look up that order');
    } finally {
      setManualBusy(false);
    }
  };

  const openSheet = async (
    format: 'pdf' | 'csv',
    scope: { shipmentIds?: number[]; date?: string },
    busyKey: string,
  ) => {
    setSheetBusy(busyKey);
    try {
      const opts: Parameters<typeof returnsSheetUrl>[0] = { format };
      if (scope.shipmentIds) opts.shipmentIds = scope.shipmentIds;
      if (scope.date) {
        opts.from = new Date(`${scope.date}T00:00:00`).toISOString();
        opts.to = new Date(`${scope.date}T23:59:59.999`).toISOString();
      }
      const { url } = await returnsSheetUrl(opts);
      window.open(url, '_blank', 'noreferrer');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not build the sheet');
    } finally {
      setSheetBusy(null);
    }
  };

  const confirm = async () => {
    if (!rows.length || submitting) return;
    // Scanned parcels confirm by their AWB; manual adds by shipment id.
    const trackingNumbers = rows.filter((r) => !r.manual).map((r) => r.tracking);
    const shipmentIds = rows
      .filter((r) => r.manual && r.shipmentId != null)
      .map((r) => r.shipmentId as number);
    const batchIds = rows
      .filter((r) => r.shipmentId != null)
      .map((r) => r.shipmentId as number);
    setSubmitting(true);
    try {
      const res = await confirmScannedReturns({ trackingNumbers, shipmentIds });
      toast.success(
        `${res.queued} parcel${res.queued === 1 ? '' : 's'} marked received — processing in the background.`,
      );
      setLastBatch(batchIds.length ? { ids: batchIds, count: batchIds.length } : null);
      seenRef.current.clear();
      setRows([]);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not confirm returns');
    } finally {
      setSubmitting(false);
    }
  };

  const resolved = rows.filter((r) => !r.notFound && !r.pending).length;
  const resolvedIds = rows
    .filter((r) => r.shipmentId != null)
    .map((r) => r.shipmentId as number);

  return (
    // h-full (NOT 100dvh): this renders inside the app shell's <main>, which is
    // already sized to the viewport minus the navbar. 100dvh here overflowed by
    // the navbar height and pushed the Confirm button out of alignment.
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-4 py-3">
        <Link
          href="/orders/fulfillment"
          className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100"
          title="Back to fulfillment"
        >
          <ArrowLeft size={18} />
        </Link>
        <ScanLine size={18} className="text-green-600" />
        <h1 className="text-sm font-semibold text-gray-800">Scan returns</h1>
        <span className="ml-auto text-xs text-gray-500">
          {rows.length} scanned{resolved !== rows.length ? ` · ${resolved} matched` : ''}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Scanner — the WHOLE frame is the scan area (barcode or QR, anywhere).
            shrink-0 so the camera keeps its height and the list below it takes
            the remaining space + scrolls (keeps the Confirm button pinned). */}
        <div className="relative flex h-[42vh] shrink-0 items-center justify-center overflow-hidden bg-black md:h-auto md:w-1/2 md:shrink">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            playsInline
            muted
            className="h-full w-full object-cover"
          />
          {camState === 'live' && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] font-medium text-white">
              Aim anywhere — barcode or QR
            </div>
          )}
          {camState !== 'live' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 px-6 text-center text-white">
              {camState === 'starting' ? (
                <>
                  <Loader2 className="animate-spin" size={24} />
                  <span className="text-sm">Starting camera…</span>
                </>
              ) : (
                <>
                  <AlertTriangle size={24} className="text-amber-400" />
                  <span className="text-sm">
                    Could not open the camera. Grant camera permission and reload —
                    a rear camera on a phone works best.
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Pileup list */}
        <div className="flex min-h-0 flex-1 flex-col border-t border-gray-200 md:border-l md:border-t-0">
          {/* Manual add — for parcels whose barcode/QR is damaged and won't scan */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void addByOrder();
            }}
            className="flex shrink-0 items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2.5"
          >
            <Keyboard size={16} className="shrink-0 text-gray-400" />
            <input
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              inputMode="numeric"
              enterKeyHint="done"
              placeholder="Barcode won't scan? Add order #"
              className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
            />
            <button
              type="submit"
              disabled={!manualInput.trim() || manualBusy}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-2 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
            >
              {manualBusy ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Plus size={15} />
              )}
              Add
            </button>
          </form>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center text-gray-400">
                <PackageCheck size={28} />
                <p className="text-sm">
                  Point the camera at a parcel&apos;s AWB barcode. Each scan is
                  added here; confirm when you&apos;re done.
                </p>
                <p className="text-xs text-gray-400">
                  Barcode damaged? Type the order number above to add it.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <li key={r.tracking} className="flex items-start gap-2 px-3 py-2.5 text-sm">
                    <span className="mt-0.5 shrink-0">
                      {r.pending ? (
                        <Loader2 size={16} className="animate-spin text-gray-400" />
                      ) : r.notFound ? (
                        <AlertTriangle size={16} className="text-red-500" />
                      ) : (
                        <CheckCircle2 size={16} className="text-green-600" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium text-gray-800">
                            {r.orderName ?? (r.pending ? 'Looking up…' : 'Unknown order')}
                          </span>
                          {r.manual && (
                            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                              <Keyboard size={9} /> typed
                            </span>
                          )}
                        </span>
                        {r.courier && (
                          <span className="shrink-0 text-xs text-gray-500">
                            {COURIER_LABELS[r.courier]}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-gray-500">
                        {r.tracking}
                        {r.customerName ? ` · ${r.customerName}` : ''}
                      </div>
                      {r.notFound && (
                        <p className="mt-0.5 text-xs text-red-500">
                          Not found — verify this label. It&apos;ll be skipped on confirm.
                        </p>
                      )}
                      {r.alreadyReceived && (
                        <p className="mt-0.5 text-xs text-amber-600">
                          Already marked received — confirming again is harmless.
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => removeRow(r.tracking)}
                      title="Remove"
                      className="mt-0.5 shrink-0 text-gray-300 hover:text-red-500"
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="shrink-0 space-y-2.5 border-t border-gray-200 p-3">
            {/* Just-confirmed batch — download its returns sheet */}
            {lastBatch && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
                <CheckCircle2 size={15} className="shrink-0 text-green-600" />
                <span className="text-xs font-medium text-green-800">
                  {lastBatch.count} received — download sheet:
                </span>
                <div className="ml-auto flex gap-1.5">
                  <SheetBtn
                    label="PDF"
                    busy={sheetBusy === 'batch-pdf'}
                    onClick={() => openSheet('pdf', { shipmentIds: lastBatch.ids }, 'batch-pdf')}
                  />
                  <SheetBtn
                    label="CSV"
                    busy={sheetBusy === 'batch-csv'}
                    onClick={() => openSheet('csv', { shipmentIds: lastBatch.ids }, 'batch-csv')}
                  />
                </div>
                <button
                  onClick={() => setLastBatch(null)}
                  title="Dismiss"
                  className="shrink-0 text-green-700/60 hover:text-green-800"
                >
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Confirm + download-this-scan */}
            {rows.length > 0 && (
              <>
                <button
                  onClick={confirm}
                  disabled={submitting}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {submitting ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <PackageCheck size={16} />
                  )}
                  Confirm return ({rows.length})
                </button>
                {resolvedIds.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-gray-500">
                      Download this scan ({resolvedIds.length}):
                    </span>
                    <SheetBtn
                      label="PDF"
                      busy={sheetBusy === 'scan-pdf'}
                      onClick={() => openSheet('pdf', { shipmentIds: resolvedIds }, 'scan-pdf')}
                    />
                    <SheetBtn
                      label="CSV"
                      busy={sheetBusy === 'scan-csv'}
                      onClick={() => openSheet('csv', { shipmentIds: resolvedIds }, 'scan-csv')}
                    />
                  </div>
                )}
              </>
            )}

            {/* Download returns received on a past day */}
            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2.5">
              <FileText size={14} className="shrink-0 text-gray-400" />
              <span className="text-xs text-gray-500">Returns received on</span>
              <input
                type="date"
                value={dateVal}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setDateVal(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs focus:border-green-500 focus:outline-none"
              />
              <SheetBtn
                label="PDF"
                busy={sheetBusy === 'date-pdf'}
                onClick={() => openSheet('pdf', { date: dateVal }, 'date-pdf')}
              />
              <SheetBtn
                label="CSV"
                busy={sheetBusy === 'date-csv'}
                onClick={() => openSheet('csv', { date: dateVal }, 'date-csv')}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Small PDF/CSV download button used across the returns-sheet controls. */
function SheetBtn({
  label,
  busy,
  onClick,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
    >
      {busy ? (
        <Loader2 size={13} className="animate-spin" />
      ) : (
        <Download size={13} />
      )}
      {label}
    </button>
  );
}
