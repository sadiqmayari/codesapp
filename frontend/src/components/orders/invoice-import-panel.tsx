'use client';

import { useRef, useState } from 'react';
import { Upload, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useAuth } from '@/context/auth-context';
import { importInvoiceStatements, type InvoiceImportResult } from '@/lib/invoice-import';

/**
 * Invoice-import uploader — lives under Orders → Courier payments → "Invoice
 * import" (owner/admin, and only when the super-admin has enabled the feature).
 * Upload one or more courier statements → the invoice number is stamped onto
 * matching orders by order number.
 */
export function InvoiceImportPanel() {
  const toast = useToast();
  const { user } = useAuth();
  const configured = !!user?.company?.invoiceImportConfigured;
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InvoiceImportResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!configured) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
        <p className="font-semibold">Invoice import isn&apos;t set up for your file format yet.</p>
        <p className="mt-1">
          Upload your courier / accounting statements to auto-fill the invoice number on your orders
          (matched by order number). Because every business&apos;s file is a different format, we
          configure the parser for you. <b>Contact CodesApp to enable it for your account.</b>
        </p>
      </div>
    );
  }

  const pick = (list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
    setResult(null);
  };
  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  const upload = async () => {
    if (!files.length) return;
    setBusy(true);
    try {
      const res = await importInvoiceStatements(files);
      setResult(res);
      toast.success(`${res.totalStamped} order${res.totalStamped === 1 ? '' : 's'} stamped`);
      setFiles([]);
      if (inputRef.current) inputRef.current.value = '';
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Invoice import</h2>
        <p className="mt-1 text-sm text-gray-500">
          Upload one or more courier statements. We read the invoice number for each order and stamp
          it onto the matching order (by order number). Accepts .xls, .xlsx and CSV.
        </p>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pick(e.dataTransfer.files);
        }}
        className="rounded-xl border-2 border-dashed border-gray-300 p-6 text-center"
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".xls,.xlsx,.csv"
          onChange={(e) => pick(e.target.files)}
          className="hidden"
          id="inv-files"
        />
        <label htmlFor="inv-files" className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
          <Upload size={16} /> Choose files
        </label>
        <p className="mt-2 text-xs text-gray-400">or drag &amp; drop the statement files here</p>
      </div>

      {files.length > 0 && (
        <div className="space-y-1.5">
          {files.map((f, i) => (
            <div key={`${f.name}-${i}`} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm">
              <span className="min-w-0 truncate text-gray-700">{f.name}</span>
              <button onClick={() => removeFile(i)} className="ml-2 text-gray-400 hover:text-rose-600">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <button
            onClick={upload}
            disabled={busy}
            className="mt-2 inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? 'Importing…' : `Import ${files.length} file${files.length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}

      {result && (
        <div className="rounded-xl border border-gray-200 p-4 text-sm">
          <p className="font-semibold text-gray-800">
            {result.totalStamped} of {result.totalParsed} stamped
            {result.unmatched.length > 0 && ` · ${result.unmatched.length} unmatched`}
          </p>
          <div className="mt-2 space-y-1 text-xs text-gray-600">
            {result.perFile.map((f, i) => (
              <div key={i} className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium text-gray-700">{f.file}</span>
                {f.error ? (
                  <span className="text-rose-600">{f.error}</span>
                ) : (
                  <span>
                    {f.courier ? `${f.courier} · ` : ''}
                    {f.stamped}/{f.parsed} stamped{f.unmatched ? `, ${f.unmatched} unmatched` : ''}
                  </span>
                )}
              </div>
            ))}
          </div>
          {result.unmatched.length > 0 && (
            <p className="mt-2 text-[11px] text-gray-400">
              Unmatched (no order found): {result.unmatched.slice(0, 40).join(', ')}
              {result.unmatched.length > 40 ? '…' : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
