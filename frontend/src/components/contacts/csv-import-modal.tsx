'use client';

import { useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Modal } from '@/components/ui/modal';

type FieldMap = 'name' | 'phone' | 'email' | 'tag' | 'skip';

interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

const MAX_BYTES = 5 * 1024 * 1024;

// Minimal RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF). Good enough
// for header detection + a normalized re-export; the server does the real
// ingest. No new dependency (papaparse is not installed).
function parseCsv(text: string): ParsedCsv {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((v) => v.trim() !== '')) rows.push(row);
  }
  const headers = rows.shift() ?? [];
  return { headers, rows };
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

interface Summary {
  created: number;
  skipped: number;
  invalid: number;
  capped: boolean;
}

export function CsvImportModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<FieldMap[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);

  const resetAll = () => {
    setStep(1);
    setParsed(null);
    setMapping([]);
    setError('');
    setSummary(null);
    setBusy(false);
  };

  const close = () => {
    resetAll();
    onClose();
  };

  const onFile = async (file: File | undefined) => {
    setError('');
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Only .csv files are accepted.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File exceeds the 5MB limit.');
      return;
    }
    const text = await file.text();
    const p = parseCsv(text);
    if (p.headers.length === 0) {
      setError('Could not read a header row from this file.');
      return;
    }
    setParsed(p);
    setMapping(
      p.headers.map((h) => {
        const l = h.trim().toLowerCase();
        if (l === 'phone' || l === 'mobile' || l === 'number') return 'phone';
        if (l === 'name' || l === 'full name') return 'name';
        if (l === 'email' || l === 'e-mail') return 'email';
        if (l === 'tag' || l === 'tags') return 'tag';
        return 'skip';
      }),
    );
    setStep(2);
  };

  const hasPhone = mapping.includes('phone');

  const doImport = async () => {
    if (!parsed) return;
    setBusy(true);
    setError('');
    // Re-export a normalized CSV with the column names the backend importer
    // expects (phone,name,email,tags). The server accepts ONLY a file —
    // there is no mapping DTO — so the mapping is applied here.
    const out: string[] = ['phone,name,email,tags'];
    for (const r of parsed.rows) {
      let phone = '';
      let name = '';
      let email = '';
      const tagParts: string[] = [];
      mapping.forEach((m, idx) => {
        const val = (r[idx] ?? '').trim();
        if (!val) return;
        if (m === 'phone') phone = val;
        else if (m === 'name') name = val;
        else if (m === 'email') email = val;
        else if (m === 'tag')
          tagParts.push(
            ...val
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean),
          );
      });
      out.push(
        [phone, name, email, tagParts.join(',')].map(csvCell).join(','),
      );
    }
    const blob = new Blob([out.join('\n')], { type: 'text/csv' });
    const fd = new FormData();
    fd.append('file', blob, 'import.csv');
    try {
      const res = await apiFetch<Summary>('/contacts/import', {
        method: 'POST',
        body: fd,
      });
      setSummary(res);
      setStep(3);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.userMessage : 'Import failed. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Import contacts from CSV"
      size="lg"
      footer={
        step === 1 ? (
          <button
            onClick={close}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
        ) : step === 2 ? (
          <>
            <button
              onClick={() => {
                setStep(1);
                setParsed(null);
              }}
              className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Back
            </button>
            <button
              onClick={doImport}
              disabled={busy || !hasPhone}
              title={!hasPhone ? 'Map a column to "phone" first' : undefined}
              className="px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50"
            >
              {busy ? 'Importing…' : 'Import'}
            </button>
          </>
        ) : (
          <button
            onClick={() => {
              onImported();
              close();
            }}
            className="px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium"
          >
            Close
          </button>
        )
      }
    >
      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {step === 1 && (
        <div>
          <p className="text-sm text-gray-600 mb-4">
            Upload a .csv file (max 5MB). The first row must be a header row.
            You will map columns in the next step.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => onFile(e.target.files?.[0])}
            className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-lg file:border-0 file:bg-green-600 file:px-4 file:py-2 file:text-white hover:file:bg-green-700"
          />
        </div>
      )}

      {step === 2 && parsed && (
        <div>
          <p className="text-sm text-gray-600 mb-3">
            Map each CSV column. A <strong>phone</strong> column is required.
            Multiple columns mapped to <strong>tag</strong> are merged
            (comma-separated values become individual tags). Unmapped data is
            skipped. Custom fields are not supported by the importer.
          </p>
          <div className="space-y-2 mb-5">
            {parsed.headers.map((h, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="w-1/2 truncate text-sm font-medium text-gray-800">
                  {h || `(column ${i + 1})`}
                </span>
                <select
                  value={mapping[i]}
                  onChange={(e) =>
                    setMapping((m) =>
                      m.map((v, j) =>
                        j === i ? (e.target.value as FieldMap) : v,
                      ),
                    )
                  }
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="skip">Skip</option>
                  <option value="name">Name</option>
                  <option value="phone">Phone</option>
                  <option value="email">Email</option>
                  <option value="tag">Tag</option>
                </select>
              </div>
            ))}
          </div>
          {!hasPhone && (
            <p className="text-sm text-amber-600 mb-3">
              Map one column to <strong>Phone</strong> to continue.
            </p>
          )}
          <p className="text-xs font-medium text-gray-500 mb-1">
            Preview (first 5 rows)
          </p>
          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  {parsed.headers.map((h, i) => (
                    <th
                      key={i}
                      className="px-3 py-2 text-left font-medium text-gray-600 whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {parsed.rows.slice(0, 5).map((r, ri) => (
                  <tr key={ri}>
                    {parsed.headers.map((_, ci) => (
                      <td
                        key={ci}
                        className="px-3 py-2 text-gray-700 whitespace-nowrap"
                      >
                        {r[ci] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {step === 3 && summary && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <SummaryStat label="Imported" value={summary.created} good />
            <SummaryStat label="Skipped (dupes)" value={summary.skipped} />
            <SummaryStat label="Invalid rows" value={summary.invalid} />
          </div>
          {summary.capped && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
              Your plan&apos;s contact limit was reached during import.
              Remaining rows were not imported — upgrade your plan to import
              the rest, then run the import again.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function SummaryStat({
  label,
  value,
  good = false,
}: {
  label: string;
  value: number;
  good?: boolean;
}) {
  return (
    <div
      className={`rounded-lg p-4 text-center border ${good ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'}`}
    >
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{label}</p>
    </div>
  );
}
