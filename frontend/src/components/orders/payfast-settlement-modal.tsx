'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
  XCircle,
  X,
} from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { cn, fmtDate } from '@/lib/utils';
import {
  applyPayfastSettlement,
  getPayfastSettlement,
  uploadPayfastSettlement,
  type PayfastPreview,
  type PayfastSummary,
} from '@/lib/payfast';

type Step = 'pick' | 'preview' | 'applying' | 'done';

/**
 * Upload PayFast's transaction export (+ optional settlement summary), see the
 * settlement breakdown + what reconciling will change, then apply. Three steps —
 * applying marks each matched order's gateway payout reconciled.
 */
export function PayfastSettlementModal({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  onApplied?: () => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState<Step>('pick');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PayfastPreview | null>(null);
  const [summary, setSummary] = useState<PayfastSummary | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const cur = preview?.currency ?? 'PKR';
  const money = (v: number | null | undefined) =>
    v == null ? '—' : `${cur} ${Math.round(v).toLocaleString()}`;

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (next.length >= 2) break;
      if (!next.some((x) => x.name === f.name)) next.push(f);
    }
    setFiles(next);
  };

  const doUpload = async () => {
    if (!files.length) return;
    setBusy(true);
    try {
      const res = await uploadPayfastSettlement(files);
      setPreview(res);
      setSummary(res.summary);
      setStep('preview');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not read those files');
    } finally {
      setBusy(false);
    }
  };

  const poll = useCallback(
    async (id: number) => {
      try {
        const s = await getPayfastSettlement(id);
        setSummary(s.summary);
        if (s.status === 'applied') {
          setPdfUrl(s.pdfUrl);
          setStep('done');
          onApplied?.();
          return true;
        }
      } catch {
        /* transient */
      }
      return false;
    },
    [onApplied],
  );

  useEffect(() => {
    if (step !== 'applying' || !preview) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const done = await poll(preview.id);
      if (!alive || done) return;
      timer = setTimeout(tick, 1500);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [step, preview, poll]);

  const doApply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await applyPayfastSettlement(preview.id);
      setStep('applying');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not apply the settlement');
    } finally {
      setBusy(false);
    }
  };

  const tile = (label: string, value: string, tone?: 'green' | 'red') => (
    <div
      className={cn(
        'rounded-lg border px-3 py-2',
        tone === 'green'
          ? 'border-green-200 bg-green-50'
          : tone === 'red'
            ? 'border-red-200 bg-red-50'
            : 'border-gray-200 bg-gray-50',
      )}
    >
      <p className="text-[11px] text-gray-500">{label}</p>
      <p
        className={cn(
          'text-sm font-semibold',
          tone === 'green' ? 'text-green-700' : tone === 'red' ? 'text-red-700' : 'text-gray-800',
        )}
      >
        {value}
      </p>
    </div>
  );

  return (
    <Modal open title="PayFast settlement" onClose={onClose}>
      {/* ── Step 1: pick files ─────────────────────────────────────────── */}
      {step === 'pick' && (
        <div className="space-y-4">
          <p className="text-xs leading-relaxed text-gray-500">
            Upload PayFast&apos;s <span className="font-medium">transaction export</span> (the
            file with an <code>Order_Id</code> column). Optionally add the{' '}
            <span className="font-medium">settlement summary</span> too — CodesApp uses it to
            label each payout&apos;s bank and cross-check the totals. Every transaction is matched
            to its Shopify order.
          </p>

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={cn(
              'flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 transition-colors',
              files.length
                ? 'border-green-300 bg-green-50'
                : 'border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100',
            )}
          >
            <FileSpreadsheet className={cn('h-7 w-7', files.length ? 'text-green-600' : 'text-gray-400')} />
            <span className="text-sm font-medium text-gray-700">
              {files.length ? `${files.length} file${files.length === 1 ? '' : 's'} selected` : 'Choose the CSV file(s)'}
            </span>
            <span className="text-[11px] text-gray-500">Up to 2 files · .csv</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />

          {files.length > 0 && (
            <ul className="space-y-1">
              {files.map((f) => (
                <li key={f.name} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-1.5 text-xs">
                  <span className="truncate text-gray-700">{f.name}</span>
                  <button
                    onClick={() => setFiles(files.filter((x) => x.name !== f.name))}
                    className="ml-2 text-gray-400 hover:text-red-600"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
            <button
              onClick={doUpload}
              disabled={!files.length || busy}
              className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Read files
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: preview ────────────────────────────────────────────── */}
      {step === 'preview' && preview && summary && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold text-gray-800">
              PayFast · merchant {preview.merchantId ?? '—'}
            </p>
            <p className="text-xs text-gray-500">
              {preview.periodStart ? fmtDate(preview.periodStart) : '?'} →{' '}
              {preview.periodEnd ? fmtDate(preview.periodEnd) : '?'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {tile('Gross collected', money(summary.grandGross))}
            {tile('Fee (MDR+GST)', `- ${money(summary.grandFees)}`, 'red')}
            {tile('Tax (WHT+ST)', `- ${money(summary.grandWhtSt)}`, 'red')}
            {tile('Net received', money(summary.grandReceived), 'green')}
          </div>

          <div className="rounded-lg border border-gray-200">
            <p className="border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-700">
              What applying this will do
            </p>
            <dl className="divide-y divide-gray-50 text-xs">
              {[
                ['Transactions in the file', String(summary.totalTxns), ''],
                ['Matched to your orders', `${summary.matchedTxns} of ${summary.totalTxns}`, summary.unmatchedTxns ? 'amber' : 'green'],
                ['Settlements (payout batches)', String(summary.batches), ''],
                ['Will be marked reconciled', String(summary.matchedTxns), 'green'],
                ['Not found in CodesApp', String(summary.unmatchedTxns), summary.unmatchedTxns ? 'amber' : ''],
              ].map(([k, v, tone]) => (
                <div key={k} className="flex items-center justify-between px-3 py-1.5">
                  <dt className="text-gray-600">{k}</dt>
                  <dd
                    className={cn(
                      'font-semibold',
                      tone === 'green' ? 'text-green-700' : tone === 'amber' ? 'text-amber-700' : 'text-gray-800',
                    )}
                  >
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {summary.unmatchedSamples.length > 0 && (
            <details className="rounded-lg border border-amber-200 bg-amber-50/40 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-amber-800">
                {summary.unmatchedTxns} not matched to an order — will be skipped
              </summary>
              <ul className="mt-2 space-y-0.5 break-words text-amber-900">
                {summary.unmatchedSamples.map((u) => (
                  <li key={u.paymentId}>
                    {u.paymentId} · {u.issuer} · {money(u.amount)}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-amber-700">
                These are usually orders paid before the payment-reference capture, or paid on a
                storefront not synced here. Re-running after a wider backfill picks most of them up.
              </p>
            </details>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
            <button
              onClick={doApply}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Apply &amp; reconcile {summary.matchedTxns}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: applying ───────────────────────────────────────────── */}
      {step === 'applying' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-gray-700">
            <Loader2 className="h-4 w-4 animate-spin text-green-600" />
            Reconciling the settlement…
          </div>
          {(() => {
            const p = summary?.progress;
            const total = p?.total ?? summary?.matchedTxns ?? 0;
            const done = p?.processed ?? 0;
            const pct = total ? Math.round((done / total) * 100) : 0;
            return (
              <>
                <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                  <div className="h-full rounded-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
                  <span className="font-mono tabular-nums">{done}/{total}</span>
                  <span className="text-green-700">{p?.reconciled ?? 0} reconciled</span>
                  {!!p?.markedPaid && <span>{p.markedPaid} marked paid</span>}
                  {!!p?.failed && <span className="text-red-600">{p.failed} failed</span>}
                </div>
              </>
            );
          })()}
          <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-700">
            You can close this — it keeps running. The statement and its PDF will be in the
            settlement history.
          </p>
          <div className="flex justify-end">
            <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
              Close
            </button>
          </div>
        </div>
      )}

      {/* ── Step 4: done ───────────────────────────────────────────────── */}
      {step === 'done' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" />
            <div className="text-sm text-green-800">
              <p className="font-semibold">Settlement applied</p>
              <p className="text-xs">
                {summary?.progress?.reconciled ?? 0} orders reconciled
                {summary?.progress?.markedPaid ? `, ${summary.progress.markedPaid} marked paid` : ''}.
              </p>
            </div>
          </div>

          {!!summary?.progress?.failed && (
            <div className="rounded-lg border border-red-200 bg-red-50/50 px-3 py-2 text-xs text-red-700">
              <p className="flex items-center gap-1 font-medium">
                <XCircle className="h-3.5 w-3.5" /> {summary.progress.failed} failed
              </p>
              {summary.progress.errors?.slice(0, 5).map((e, i) => (
                <p key={i} className="mt-0.5 break-words">{e}</p>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2">
            {pdfUrl && (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900"
              >
                <Download className="h-4 w-4" /> Download statement
              </a>
            )}
            <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
