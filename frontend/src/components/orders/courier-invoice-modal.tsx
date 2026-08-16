'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
  XCircle,
} from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { cn, fmtDate } from '@/lib/utils';
import {
  applyCourierInvoice,
  getCourierInvoice,
  supportedInvoiceCouriers,
  uploadCourierInvoice,
  COURIER_LABELS,
  type CourierInvoicePreview,
  type CourierInvoiceSummary,
  type CourierType,
} from '@/lib/couriers';

type Step = 'pick' | 'preview' | 'applying' | 'done';

/**
 * Upload a courier's own settlement statement, see exactly what reconciling it
 * would change, then apply it. Deliberately three steps — applying marks parcels
 * delivered and settles COD, so nothing happens until the numbers are on screen.
 */
export function CourierInvoiceModal({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  onApplied?: () => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState<Step>('pick');
  const [couriers, setCouriers] = useState<CourierType[]>([]);
  const [courier, setCourier] = useState<CourierType | ''>('');
  const [file, setFile] = useState<File | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<CourierInvoicePreview | null>(null);
  const [summary, setSummary] = useState<CourierInvoiceSummary | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    supportedInvoiceCouriers()
      .then((r) => {
        setCouriers(r.couriers);
        if (r.couriers.length === 1) setCourier(r.couriers[0]);
      })
      .catch(() => setCouriers([]));
  }, []);

  const money = (v: number | null | undefined) =>
    v == null ? '—' : `${preview?.currency ?? 'PKR'} ${Math.round(v).toLocaleString()}`;

  const doUpload = async () => {
    if (!courier || !file) return;
    setBusy(true);
    try {
      const res = await uploadCourierInvoice(courier, file, invoiceNo);
      setPreview(res);
      setSummary(res.summary);
      setStep('preview');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not read that statement');
    } finally {
      setBusy(false);
    }
  };

  // Poll the invoice row while the apply job drains.
  const poll = useCallback(
    async (id: number) => {
      try {
        const inv = await getCourierInvoice(id);
        setSummary(inv.summary);
        if (inv.status === 'applied') {
          setPdfUrl(inv.pdfUrl);
          setStep('done');
          onApplied?.();
          return true;
        }
      } catch {
        /* transient — keep polling */
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
      await applyCourierInvoice(preview.id);
      setStep('applying');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not apply the statement');
    } finally {
      setBusy(false);
    }
  };

  const tile = (label: string, value: string, tone?: 'green' | 'amber' | 'red') => (
    <div
      className={cn(
        'rounded-lg border px-3 py-2',
        tone === 'green'
          ? 'border-green-200 bg-green-50'
          : tone === 'amber'
            ? 'border-amber-200 bg-amber-50'
            : tone === 'red'
              ? 'border-red-200 bg-red-50'
              : 'border-gray-200 bg-gray-50',
      )}
    >
      <p className="text-[11px] text-gray-500">{label}</p>
      <p
        className={cn(
          'text-sm font-semibold',
          tone === 'green'
            ? 'text-green-700'
            : tone === 'amber'
              ? 'text-amber-700'
              : tone === 'red'
                ? 'text-red-700'
                : 'text-gray-800',
        )}
      >
        {value}
      </p>
    </div>
  );

  return (
    <Modal open title="Courier settlement statement" onClose={onClose}>
      {/* ── Step 1: pick courier + file ─────────────────────────────── */}
      {step === 'pick' && (
        <div className="space-y-4">
          <p className="text-xs leading-relaxed text-gray-500">
            Upload the settlement statement your courier sent. CodesApp reads it,
            matches every parcel to your orders, and shows you exactly what will
            change before anything is applied.
          </p>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Courier</label>
            <select
              value={courier}
              onChange={(e) => setCourier(e.target.value as CourierType)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">Select a courier…</option>
              {couriers.map((c) => (
                <option key={c} value={c}>
                  {COURIER_LABELS[c]}
                </option>
              ))}
            </select>
            {couriers.length > 0 && couriers.length < 4 && (
              <p className="mt-1 text-[11px] text-gray-400">
                Only couriers with a statement reader are listed — each formats its
                invoice differently. Send a sample to add another.
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={cn(
              'flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 transition-colors',
              file
                ? 'border-green-300 bg-green-50'
                : 'border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100',
            )}
          >
            <FileSpreadsheet className={cn('h-7 w-7', file ? 'text-green-600' : 'text-gray-400')} />
            <span className="text-sm font-medium text-gray-700">
              {file ? file.name : 'Choose the statement (.xlsx or .csv)'}
            </span>
            {file && (
              <span className="text-[11px] text-gray-500">
                {(file.size / 1024).toFixed(0)} KB — click to change
              </span>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Invoice / CPR number <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              type="text"
              value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
              placeholder="e.g. CPR-GQ01G905532"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
            />
            <p className="mt-1 text-[11px] text-gray-400">
              Only needed if the file has no number in it (e.g. a PostEx CSV export).
              Leave blank and the statement is de-duplicated by its contents.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={doUpload}
              disabled={!courier || !file || busy}
              className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Read statement
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: preview ─────────────────────────────────────────── */}
      {step === 'preview' && preview && summary && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold text-gray-800">
              {preview.courierName} · invoice {preview.invoiceNumber ?? '—'}
            </p>
            <p className="text-xs text-gray-500">
              {preview.reportDate ? fmtDate(preview.reportDate) : 'no statement date'}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {tile('COD collected', money(preview.totals.codCollected))}
            {tile('Deductions', `- ${money(preview.totals.deductions)}`, 'amber')}
            {tile('Net payable', money(preview.totals.netPayable), 'green')}
          </div>

          <div className="rounded-lg border border-gray-200">
            <p className="border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-700">
              What applying this will do
            </p>
            <dl className="divide-y divide-gray-50 text-xs">
              {[
                ['Parcels on the statement', String(summary.totalRows), ''],
                ['Matched to your orders', `${summary.matched} of ${summary.totalRows}`, summary.unmatched ? 'amber' : 'green'],
                ['Will be marked delivered', String(summary.toPromote), summary.toPromote ? 'green' : ''],
                ['Will be settled (COD reconciled)', String(summary.toSettle), 'green'],
                ['Will be marked paid + archived in Shopify', String(summary.toSettle), 'green'],
                ['Already settled', String(summary.alreadySettled), ''],
                ['COD amount discrepancies', String(summary.codMismatches), summary.codMismatches ? 'red' : ''],
                ['Not found in CodesApp', String(summary.unmatched), summary.unmatched ? 'amber' : ''],
              ].map(([k, v, tone]) => (
                <div key={k} className="flex items-center justify-between px-3 py-1.5">
                  <dt className="text-gray-600">{k}</dt>
                  <dd
                    className={cn(
                      'font-semibold',
                      tone === 'green'
                        ? 'text-green-700'
                        : tone === 'amber'
                          ? 'text-amber-700'
                          : tone === 'red'
                            ? 'text-red-700'
                            : 'text-gray-800',
                    )}
                  >
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {summary.promoteSamples.length > 0 && (
            <details className="rounded-lg border border-green-200 bg-green-50/40 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-green-800">
                {summary.toPromote} order{summary.toPromote === 1 ? '' : 's'} will be marked delivered
              </summary>
              <ul className="mt-2 space-y-0.5 text-green-900">
                {summary.promoteSamples.map((p) => (
                  <li key={p.trackingNumber}>
                    {p.orderName ?? p.trackingNumber} — currently {p.ourStatus ?? 'unknown'}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {summary.codMismatchSamples.length > 0 && (
            <details className="rounded-lg border border-red-200 bg-red-50/40 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-red-800">
                {summary.codMismatches} COD discrepanc{summary.codMismatches === 1 ? 'y' : 'ies'} — reported, not changed
              </summary>
              <ul className="mt-2 space-y-0.5 text-red-900">
                {summary.codMismatchSamples.map((m) => (
                  <li key={m.trackingNumber}>
                    {m.orderName ?? m.trackingNumber}: statement {money(m.invoiceCod)} vs expected{' '}
                    {money(m.expectedCod)}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {summary.unmatched > 0 && (
            <details className="rounded-lg border border-amber-200 bg-amber-50/40 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-amber-800">
                {summary.unmatched} not found in CodesApp — will be skipped
              </summary>
              <p className="mt-2 break-words text-amber-900">
                {summary.unmatchedTracking.slice(0, 40).join(', ')}
                {summary.unmatchedTracking.length > 40
                  ? ` … +${summary.unmatchedTracking.length - 40} more`
                  : ''}
              </p>
            </details>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={doApply}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Apply &amp; settle {summary.toSettle}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: applying ────────────────────────────────────────── */}
      {step === 'applying' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-gray-700">
            <Loader2 className="h-4 w-4 animate-spin text-green-600" />
            Applying the statement…
          </div>
          {(() => {
            const p = summary?.progress;
            const total = p?.total ?? summary?.paidRows ?? 0;
            const done = p?.processed ?? 0;
            const pct = total ? Math.round((done / total) * 100) : 0;
            return (
              <>
                <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-green-500 transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
                  <span className="font-mono tabular-nums">
                    {done}/{total}
                  </span>
                  <span className="text-green-700">{p?.settled ?? 0} settled</span>
                  <span>{p?.promoted ?? 0} marked delivered</span>
                  <span className="text-green-700">{p?.markedPaid ?? 0} paid in Shopify</span>
                  <span>{p?.archived ?? 0} archived</span>
                  {!!p?.failed && <span className="text-red-600">{p.failed} failed</span>}
                </div>
              </>
            );
          })()}
          <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-700">
            You can close this window — it keeps running in the background. The
            statement and its PDF will be waiting in the invoice history.
          </p>
          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* ── Step 4: done ────────────────────────────────────────────── */}
      {step === 'done' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" />
            <div className="text-sm text-green-800">
              <p className="font-semibold">Statement applied</p>
              <p className="text-xs">
                {summary?.progress?.settled ?? 0} parcels settled
                {summary?.progress?.promoted
                  ? `, ${summary.progress.promoted} marked delivered`
                  : ''}
                {summary?.progress?.markedPaid
                  ? `, ${summary.progress.markedPaid} marked paid in Shopify`
                  : ''}
                {summary?.progress?.archived
                  ? `, ${summary.progress.archived} archived`
                  : ''}
                .
              </p>
            </div>
          </div>

          {!!summary?.progress?.failed && (
            <div className="rounded-lg border border-red-200 bg-red-50/50 px-3 py-2 text-xs text-red-700">
              <p className="flex items-center gap-1 font-medium">
                <XCircle className="h-3.5 w-3.5" /> {summary.progress.failed} line
                {summary.progress.failed === 1 ? '' : 's'} failed
              </p>
              {summary.progress.errors?.slice(0, 5).map((e, i) => (
                <p key={i} className="mt-0.5 break-words">
                  {e}
                </p>
              ))}
            </div>
          )}

          {summary && summary.unmatched > 0 && (
            <p className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {summary.unmatched} parcel{summary.unmatched === 1 ? '' : 's'} on the
              statement had no match in CodesApp and were skipped — they&apos;re listed
              in the PDF.
            </p>
          )}

          <div className="flex justify-end gap-2">
            {pdfUrl && (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900"
              >
                <Download className="h-4 w-4" /> Download invoice
              </a>
            )}
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
