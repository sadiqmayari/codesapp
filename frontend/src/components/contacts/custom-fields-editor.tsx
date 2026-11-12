'use client';

import { Plus, X } from 'lucide-react';

export interface FieldRow {
  key: string;
  value: string;
}

export function rowsFromFields(fields: Record<string, unknown> | null | undefined): FieldRow[] {
  return Object.entries(fields ?? {}).map(([key, v]) => ({
    key,
    value: typeof v === 'string' ? v : JSON.stringify(v),
  }));
}

/**
 * Rows → object. Returns `{ error }` when two rows share a key (case-insensitive)
 * instead of silently keeping the last one.
 */
export function fieldsFromRows(rows: FieldRow[]): { fields: Record<string, string> } | { error: string } {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    if (seen.has(k.toLowerCase())) return { error: `Field "${k}" appears twice` };
    seen.add(k.toLowerCase());
    out[k] = r.value;
  }
  return { fields: out };
}

/** Shared key/value editor for contact custom fields (form + Contact 360). */
export function CustomFieldsEditor({
  rows,
  onChange,
  disabled = false,
}: {
  rows: FieldRow[];
  onChange: (rows: FieldRow[]) => void;
  disabled?: boolean;
}) {
  const set = (i: number, patch: Partial<FieldRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-2">
          <input
            value={r.key}
            disabled={disabled}
            onChange={(e) => set(i, { key: e.target.value })}
            placeholder="Field (e.g. skin_type)"
            aria-label={`Field ${i + 1} name`}
            maxLength={64}
            className="h-9 min-w-0 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink focus:border-brand-500 focus:outline-none"
          />
          <input
            value={r.value}
            disabled={disabled}
            onChange={(e) => set(i, { value: e.target.value })}
            placeholder="Value"
            aria-label={`Field ${i + 1} value`}
            maxLength={1000}
            className="h-9 min-w-0 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink focus:border-brand-500 focus:outline-none"
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            aria-label={`Remove field ${r.key || i + 1}`}
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-muted hover:text-red-600 hover:bg-sunken"
          >
            <X size={15} />
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled || rows.length >= 50}
        onClick={() => onChange([...rows, { key: '', value: '' }])}
        className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline disabled:opacity-50"
      >
        <Plus size={13} /> Add field
      </button>
    </div>
  );
}
