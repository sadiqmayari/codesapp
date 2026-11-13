import { zoneOffset } from './platforms/http';

export { zoneOffset };

/** "+05:00" → 300. */
export function offsetMinutes(offset: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Tenant-local calendar day (YYYY-MM-DD) of a UTC instant. */
export function localYmd(d: Date, offMin: number): string {
  return new Date(d.getTime() + offMin * 60_000).toISOString().slice(0, 10);
}

/** Every calendar day from..to inclusive (YYYY-MM-DD strings). */
export function dayList(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end && out.length < 1200; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** ISO week key ("2026-W45") of a YYYY-MM-DD day. */
export function isoWeek(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export const n = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === 'bigint') return Number(v);
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

export const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Canonical customer key: last 10 phone digits (PK-safe), else lower-cased email. */
export function customerKey(phone: string | null | undefined, email: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length >= 9) return `p:${digits.slice(-10)}`;
  const e = (email ?? '').trim().toLowerCase();
  return e ? `e:${e.slice(0, 240)}` : null;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
