'use client';

import { ApiError } from '@/lib/api';
import { STATUS_META, type AttendanceCell, type AttendanceStatus } from '@/lib/attendance';
import { cn } from '@/lib/utils';

export const errMsg = (e: unknown, fallback = 'Something went wrong') =>
  e instanceof ApiError ? e.userMessage : fallback;

export const inputCls =
  'h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40';

export function StatusChip({ status, className }: { status: AttendanceStatus; className?: string }) {
  const m = STATUS_META[status];
  return <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-semibold', m.cls, className)}>{m.label}</span>;
}

/** Short cell label for the daily grid (P / L / A / ½ / H) with an accessible name. */
export function cellCode(c: AttendanceCell | undefined, off: boolean) {
  if (!c) return off ? { code: '·', cls: 'text-muted', name: 'Day off' } : { code: '', cls: '', name: 'Not marked' };
  if (c.status === 'present' && c.isLate) return { code: 'L', cls: 'bg-amber-50 text-amber-800', name: 'Present, late' };
  if (c.status === 'present') return { code: 'P', cls: 'bg-emerald-50 text-emerald-700', name: 'Present' };
  if (c.status === 'half_day') return { code: '½', cls: 'bg-violet-50 text-violet-700', name: 'Half day' };
  if (c.status === 'leave') return { code: 'Lv', cls: 'bg-sky-50 text-sky-700', name: 'Leave' };
  if (c.status === 'holiday') return { code: 'H', cls: 'bg-gray-100 text-gray-600', name: 'Holiday' };
  return { code: 'A', cls: 'bg-red-50 text-red-700', name: 'Absent' };
}

export function MonthInput({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  // Native <input type=month> falls back to text on some browsers — a select of
  // the last 18 months always works.
  const opts: string[] = [];
  const [y, m] = value.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1 + 2, 1));
  for (let i = 0; i < 18; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1));
    opts.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={cn(inputCls, 'w-auto')} aria-label="Month">
      {opts.map((o) => (
        <option key={o} value={o}>
          {new Date(`${o}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}
        </option>
      ))}
    </select>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      aria-hidden
      className={cn('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white', className)}
      style={{ background: `hsl(${h} 45% 45%)` }}
    >
      {initials || '?'}
    </span>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-semibold text-muted">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
