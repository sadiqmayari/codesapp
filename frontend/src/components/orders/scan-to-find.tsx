'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, ScanLine, X } from 'lucide-react';
import {
  BrowserMultiFormatReader,
  type IScannerControls,
} from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

/**
 * Scan a courier label and jump straight to its order.
 *
 * Feeds the decoded value into the board's existing search box rather than
 * inventing a second navigation path — the queue already searches by order
 * number, name, phone and city, and the backend already matches tracking
 * numbers, so a scan is just a very fast way of typing.
 *
 * Mirrors the RTO-receive scanner's tuning: restrict to the symbologies that
 * actually appear on Pakistani courier AWB labels so each frame decodes fast,
 * and poll aggressively.
 */
export default function ScanToFind({
  onScan,
  className,
}: {
  onScan: (code: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className}
        title="Scan a courier label to find its order"
      >
        <ScanLine size={14} /> Scan
      </button>
      {open && (
        <ScannerSheet
          onClose={() => setOpen(false)}
          onScan={(code) => {
            setOpen(false);
            onScan(code);
          }}
        />
      )}
    </>
  );
}

function ScannerSheet({
  onScan,
  onClose,
}: {
  onScan: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const doneRef = useRef(false);
  const [state, setState] = useState<'starting' | 'live' | 'error'>('starting');

  useEffect(() => {
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
      delayBetweenScanAttempts: 50,
      delayBetweenScanSuccess: 250,
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
          // First hit wins and closes the sheet — this is "find one parcel",
          // not the receive screen's continuous batch scan.
          if (!result || doneRef.current) return;
          doneRef.current = true;
          controlsRef.current?.stop();
          onScan(result.getText().trim());
        },
      )
      .then((controls) => {
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setState('live');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [onScan]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <span className="text-sm font-medium">Scan a courier label</span>
        <button onClick={onClose} aria-label="Close scanner" className="p-1">
          <X size={20} />
        </button>
      </div>
      <div className="relative flex-1">
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          muted
          playsInline
        />
        {state !== 'live' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white/80">
            {state === 'starting' ? (
              <>
                <Loader2 className="animate-spin" size={22} />
                Starting camera…
              </>
            ) : (
              <p className="max-w-xs px-6 text-center">
                Couldn&apos;t open the camera. Check the browser&apos;s camera
                permission for this site, then try again.
              </p>
            )}
          </div>
        )}
        {state === 'live' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-40 w-4/5 max-w-sm rounded-xl border-2 border-white/70" />
          </div>
        )}
      </div>
      <p className="px-6 pb-6 pt-3 text-center text-xs text-white/70">
        Point at the barcode or QR on the parcel label — the order opens as soon
        as it reads.
      </p>
    </div>
  );
}
