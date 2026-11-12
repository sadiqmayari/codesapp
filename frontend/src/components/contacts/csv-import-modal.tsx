'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, FileUp, Loader2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import {
  CsvImportJob,
  CsvImportSummary,
  getImportJob,
  importContactsCsv,
  looksLikePhone,
} from '@/lib/contacts';

type Target = 'name' | 'phone' | 'email' | 'city' | 'address' | 'tags' | 'custom' | 'skip';

interface ParsedCsv {
  headers: string[];
  rows: string[][];
  delimiter: ',' | ';';
}

const MAX_BYTES = 5 * 1024 * 1024;
const TARGETS: { value: Target; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'city', label: 'City' },
  { value: 'address', label: 'Address' },
  { value: 'tags', label: 'Tags' },
  { value: 'custom', label: 'Custom field' },
  { value: 'skip', label: "Don't import" },
];

const SAMPLE = 'name,phone,email,city,tags,custom.skin_type\nAyesha Khan,03001234567,ayesha@example.com,Lahore,"VIP, Repeat",Combination\n';

/** RFC-4180-ish parser (quotes, escaped quotes, CRLF) with `,`/`;` auto-detect. */
function parseCsv(raw: string): ParsedCsv {
  const text = raw.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter: ',' | ';' =
    (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
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
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((v) => v.trim() !== '')) rows.push(row);
  }
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows, delimiter };
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
function guess(h: string): Target {
  const k = norm(h);
  if (/^(phone|phonenumber|mobile|mobilenumber|whatsapp|whatsappnumber|cell|contactnumber|number|msisdn)$/.test(k))
    return 'phone';
  if (/^(name|fullname|customername|contactname)$/.test(k)) return 'name';
  if (/^(email|emailaddress|mail)$/.test(k)) return 'email';
  if (/^(city|town)$/.test(k)) return 'city';
  if (/^(address|streetaddress|shippingaddress|address1)$/.test(k)) return 'address';
  if (/^(tags|tag|labels|segment)$/.test(k)) return 'tags';
  if (/^custom/.test(k)) return 'custom';
  return 'skip';
}
const customKey = (h: string) =>
  h.replace(/^custom[._\s-]*/i, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 64) ||
  'field';

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function isJob(r: CsvImportSummary | CsvImportJob): r is CsvImportJob {
  return 'jobId' in r;
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
  const toast = useToast();
  const [step, setStep] = useState<'upload' | 'map' | 'running' | 'done'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [customNames, setCustomNames] = useState<string[]>([]);
  const [mode, setMode] = useState<'skip' | 'update'>('update');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [job, setJob] = useState<CsvImportJob | null>(null);
  const [summary, setSummary] = useState<CsvImportSummary | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const imported = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep('upload');
    setFile(null);
    setParsed(null);
    setTargets([]);
    setCustomNames([]);
    setMode('update');
    setError('');
    setJob(null);
    setSummary(null);
    imported.current = false;
  }, [open]);

  // Poll a background job.
  useEffect(() => {
    if (step !== 'running' || !job?.jobId) return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const j = await getImportJob(job.jobId);
        if (!alive) return;
        setJob(j);
        if (j.status === 'done' && j.summary) {
          setSummary(j.summary);
          setStep('done');
        } else if (j.status === 'failed') {
          setError(j.error ?? 'Import stopped');
          setStep('done');
        }
      } catch {
        /* transient — keep polling */
      }
    }, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [step, job?.jobId]);

  // Any close after an import refreshes the list (not only the footer button).
  const close = () => {
    if (imported.current) onImported();
    onClose();
  };

  const pick = async (f: File | null | undefined) => {
    setError('');
    if (!f) return;
    if (!/\.(csv|txt)$/i.test(f.name)) return setError('Choose a .csv file (Excel: File → Save As → CSV UTF-8).');
    if (f.size > MAX_BYTES) return setError('That file is over 5 MB. Split it into smaller files.');
    const p = parseCsv(await f.text());
    if (!p.headers.length || !p.rows.length) return setError('The file has no rows under the header.');
    const t = p.headers.map(guess);
    setFile(f);
    setParsed(p);
    setTargets(t);
    setCustomNames(p.headers.map(customKey));
    setStep('map');
  };

  const phoneCol = targets.indexOf('phone');
  const dupPhone = targets.filter((t) => t === 'phone').length > 1;
  const nameCol = targets.indexOf('name');
  const preflight = (() => {
    if (!parsed || phoneCol < 0) return { ok: 0, bad: [] as number[], dup: 0 };
    const seen = new Set<string>();
    let ok = 0;
    let dup = 0;
    const bad: number[] = [];
    parsed.rows.forEach((r, i) => {
      const raw = r[phoneCol] ?? '';
      const d = raw.replace(/\D/g, '');
      if (!looksLikePhone(raw)) bad.push(i + 2);
      else if (seen.has(d.slice(-10))) dup++;
      else {
        seen.add(d.slice(-10));
        ok++;
      }
    });
    return { ok, bad, dup };
  })();

  const runImport = async () => {
    if (!parsed || !file) return;
    if (phoneCol < 0) return setError('Map one column to Phone.');
    if (dupPhone) return setError('Only one column can be Phone.');
    setError('');
    // Re-export a normalized CSV with canonical headers (server accepts aliases too).
    const cols: { idx: number; header: string; join?: boolean }[] = [];
    targets.forEach((t, idx) => {
      if (t === 'skip') return;
      if (t === 'custom') cols.push({ idx, header: `custom.${customNames[idx] || 'field'}` });
      else if (t === 'tags') cols.push({ idx, header: 'tags', join: true });
      else if (!cols.some((c) => c.header === t)) cols.push({ idx, header: t });
    });
    // Several Tags columns → one combined tags column.
    const tagIdx = targets.map((t, i) => (t === 'tags' ? i : -1)).filter((i) => i >= 0);
    const outCols = cols.filter((c) => !c.join);
    if (tagIdx.length) outCols.push({ idx: -1, header: 'tags' });
    const lines = [outCols.map((c) => cell(c.header)).join(',')];
    for (const r of parsed.rows) {
      lines.push(
        outCols
          .map((c) =>
            c.idx === -1
              ? cell(tagIdx.map((i) => (r[i] ?? '').trim()).filter(Boolean).join(','))
              : cell((r[c.idx] ?? '').trim()),
          )
          .join(','),
      );
    }
    const normalized = new File([lines.join('\n')], file.name.replace(/\.\w+$/, '') + '.csv', {
      type: 'text/csv',
    });
    setSubmitting(true);
    try {
      const res = await importContactsCsv(normalized, mode);
      imported.current = true;
      if (isJob(res)) {
        setJob(res);
        setStep('running');
      } else {
        setSummary(res);
        setStep('done');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Import failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const copyErrors = async () => {
    if (!summary?.errors.length) return;
    try {
      await navigator.clipboard.writeText(
        ['row,reason', ...summary.errors.map((e) => `${e.row},${cell(e.reason)}`)].join('\n'),
      );
      toast.success('Error list copied');
    } catch {
      toast.error('Could not copy');
    }
  };

  const sampleHref = `data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE)}`;

  const footer =
    step === 'map' ? (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={() => setStep('upload')}>
          Back
        </Button>
        <Button onClick={runImport} loading={submitting} disabled={phoneCol < 0 || dupPhone}>
          Import {preflight.ok.toLocaleString()} contact{preflight.ok === 1 ? '' : 's'}
        </Button>
      </div>
    ) : step === 'done' ? (
      <div className="flex justify-end">
        <Button onClick={close}>Done</Button>
      </div>
    ) : undefined;

  return (
    <Modal
      open={open}
      onClose={step === 'running' ? () => undefined : close}
      title="Import contacts"
      size="xl"
      footer={footer}
    >
      {error && (
        <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {step === 'upload' && (
        <div className="space-y-3">
          <label
            htmlFor="csv-file"
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void pick(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-colors',
              dragging ? 'border-brand-500 bg-brand-50' : 'border-line hover:bg-sunken',
            )}
          >
            <FileUp size={28} className="text-brand-600" />
            <span className="text-sm font-semibold text-ink">Drop a CSV here or click to choose</span>
            <span className="text-xs text-muted">
              Comma or semicolon separated · up to 5 MB · Excel “CSV UTF-8” works
            </span>
            <input
              ref={inputRef}
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
          </label>
          <p className="text-xs text-muted">
            Needs a phone column. Numbers like <span className="font-mono">0300-1234567</span> are converted to
            international format automatically.{' '}
            <a href={sampleHref} download="contacts-sample.csv" className="font-semibold text-brand-700 hover:underline">
              Download a sample file
            </a>
          </p>
        </div>
      )}

      {step === 'map' && parsed && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <p className="text-sm text-ink mb-2">
              <span className="font-semibold">{file?.name}</span>{' '}
              <span className="text-muted">
                · {parsed.rows.length.toLocaleString()} rows · separator “{parsed.delimiter}”
              </span>
            </p>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-sm">
                <thead className="bg-sunken text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Column in file</th>
                    <th className="px-3 py-2 text-left font-semibold">Example</th>
                    <th className="px-3 py-2 text-left font-semibold">Import as</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.headers.map((h, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="px-3 py-2 font-medium text-ink">{h || `Column ${i + 1}`}</td>
                      <td className="px-3 py-2 text-muted max-w-[10rem] truncate">{parsed.rows[0]?.[i] ?? ''}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1.5">
                          <select
                            aria-label={`Import ${h || `column ${i + 1}`} as`}
                            value={targets[i]}
                            onChange={(e) =>
                              setTargets((cur) => cur.map((t, j) => (j === i ? (e.target.value as Target) : t)))
                            }
                            className="h-8 rounded-lg border border-line bg-surface px-2 text-sm text-ink"
                          >
                            {TARGETS.map((t) => (
                              <option key={t.value} value={t.value}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                          {targets[i] === 'custom' && (
                            <input
                              aria-label={`Custom field name for ${h}`}
                              value={customNames[i] ?? ''}
                              onChange={(e) =>
                                setCustomNames((cur) => cur.map((n, j) => (j === i ? e.target.value : n)))
                              }
                              className="h-8 w-32 rounded-lg border border-line bg-surface px-2 text-sm text-ink"
                              placeholder="field_name"
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {nameCol < 0 && phoneCol >= 0 && (
              <p className="text-xs text-muted mt-2">No name column — the number will be used as the name until they message you.</p>
            )}
          </div>

          <div className="space-y-4">
            <fieldset>
              <legend className="text-xs font-semibold text-ink mb-2">If the number already exists</legend>
              {(
                [
                  ['update', 'Update it', 'Fill empty fields and add the new tags. Existing names are kept.'],
                  ['skip', 'Skip it', 'Leave existing contacts unchanged.'],
                ] as const
              ).map(([v, title, desc]) => (
                <label
                  key={v}
                  className={cn(
                    'flex gap-2.5 rounded-lg border p-3 mb-2 cursor-pointer',
                    mode === v ? 'border-brand-500 bg-brand-50' : 'border-line',
                  )}
                >
                  <input
                    type="radio"
                    name="import-mode"
                    value={v}
                    checked={mode === v}
                    onChange={() => setMode(v)}
                    className="mt-0.5 accent-brand-600"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-ink">{title}</span>
                    <span className="block text-xs text-muted">{desc}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div>
              <p className="text-xs font-semibold text-ink mb-2">Pre-check</p>
              {phoneCol < 0 ? (
                <p className="text-sm text-red-600">Map one column to Phone to continue.</p>
              ) : dupPhone ? (
                <p className="text-sm text-red-600">Only one column can be Phone.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone="success">{preflight.ok.toLocaleString()} ready</Badge>
                  {preflight.dup > 0 && <Badge tone="warn">{preflight.dup} repeated in file</Badge>}
                  {preflight.bad.length > 0 && <Badge tone="danger">{preflight.bad.length} invalid numbers</Badge>}
                </div>
              )}
              {preflight.bad.length > 0 && (
                <p className="text-xs text-muted mt-2">
                  Rows {preflight.bad.slice(0, 8).join(', ')}
                  {preflight.bad.length > 8 ? '…' : ''} will be skipped.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {step === 'running' && (
        <div className="py-10 text-center space-y-3" aria-live="polite">
          <Loader2 size={28} className="mx-auto animate-spin text-brand-600" />
          <p className="text-sm font-semibold text-ink">Importing in the background…</p>
          <p className="text-xs text-muted tabular-nums">
            {(job?.processed ?? 0).toLocaleString()} of {(job?.total ?? 0).toLocaleString()} rows
          </p>
          <div className="mx-auto h-2 max-w-sm overflow-hidden rounded-full bg-sunken">
            <div
              className="h-full bg-brand-600 transition-all"
              style={{ width: `${job?.total ? Math.round((job.processed / job.total) * 100) : 0}%` }}
            />
          </div>
          <p className="text-xs text-muted">You can keep this open; large files take a minute.</p>
        </div>
      )}

      {step === 'done' && summary && (
        <div className="space-y-4" aria-live="polite">
          <div className="flex items-center gap-2 text-ink">
            <CheckCircle2 className="text-brand-600" size={20} />
            <span className="text-sm font-semibold">Import finished</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(
              [
                ['Added', summary.created, 'text-brand-700'],
                ['Updated', summary.updated, 'text-ink'],
                ['Already existed', summary.skipped, 'text-muted'],
                ['Not imported', summary.invalid, summary.invalid ? 'text-red-600' : 'text-muted'],
              ] as const
            ).map(([l, v, c]) => (
              <div key={l} className="rounded-lg border border-line p-3">
                <div className="text-xs text-muted">{l}</div>
                <div className={cn('text-xl font-bold tabular-nums', c)}>{v.toLocaleString()}</div>
              </div>
            ))}
          </div>
          {summary.capped && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Your plan’s contact limit was reached, so the rest of the file wasn’t imported.
            </div>
          )}
          {summary.errors.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-semibold text-ink">Rows that need attention ({summary.errors.length})</p>
                <Button variant="ghost" size="sm" onClick={copyErrors}>
                  <Copy size={13} /> Copy list
                </Button>
              </div>
              <ul className="max-h-56 overflow-auto rounded-lg border border-line divide-y divide-line text-sm">
                {summary.errors.map((e, i) => (
                  <li key={i} className="flex gap-3 px-3 py-1.5">
                    <span className="w-16 shrink-0 text-muted tabular-nums">Row {e.row}</span>
                    <span className="text-ink">{e.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
