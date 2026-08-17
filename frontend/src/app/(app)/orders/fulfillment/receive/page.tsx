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
  confirmScannedReturns,
  COURIER_LABELS,
  type CourierType,
} from '@/lib/couriers';

type ScanRow = {
  tracking: string;
  orderName: string | null;
  courier: CourierType | null;
  customerName: string | null;
  pending: boolean;
  notFound: boolean;
  alreadyReceived: boolean;
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
        orderName: null,
        courier: null,
        customerName: null,
        pending: true,
        notFound: false,
        alreadyReceived: false,
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
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.QR_CODE,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.EAN_13,
      BarcodeFormat.ITF,
      BarcodeFormat.CODABAR,
      BarcodeFormat.DATA_MATRIX,
    ]);
    const reader = new BrowserMultiFormatReader(hints, {
      delayBetweenScanAttempts: 50, // rapid: ~20 decode attempts/sec
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

  const confirm = async () => {
    if (!rows.length || submitting) return;
    const trackingNumbers = rows.map((r) => r.tracking);
    setSubmitting(true);
    try {
      const res = await confirmScannedReturns(trackingNumbers);
      toast.success(
        `${res.queued} parcel${res.queued === 1 ? '' : 's'} marked received — processing in the background.`,
      );
      seenRef.current.clear();
      setRows([]);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not confirm returns');
    } finally {
      setSubmitting(false);
    }
  };

  const resolved = rows.filter((r) => !r.notFound && !r.pending).length;

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
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center text-gray-400">
                <PackageCheck size={28} />
                <p className="text-sm">
                  Point the camera at a parcel&apos;s AWB barcode. Each scan is
                  added here; confirm when you&apos;re done.
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
                        <span className="truncate font-medium text-gray-800">
                          {r.orderName ?? (r.pending ? 'Looking up…' : 'Unknown order')}
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

          <div className="shrink-0 border-t border-gray-200 p-3">
            <button
              onClick={confirm}
              disabled={rows.length === 0 || submitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <PackageCheck size={16} />
              )}
              Confirm return ({rows.length})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
