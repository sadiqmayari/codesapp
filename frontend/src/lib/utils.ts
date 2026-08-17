import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Backend serves media at {origin}/storage/media/... Resolve the origin at
 * RUNTIME from the browser — NEXT_PUBLIC_* is build-time inlined and the
 * build is produced off-host (same bug class as lib/api.ts). The /storage
 * mount is at the root origin, NOT under /api.
 */
export function mediaUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  // Local optimistic previews (object URLs / inline data) render as-is.
  if (/^(blob:|data:)/i.test(path)) return path;
  const origin =
    typeof window !== 'undefined'
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(
          /\/+$/,
          '',
        );
  return `${origin}${path.startsWith('/') ? '' : '/'}${path}`;
}

// dd-MMM-yyyy everywhere (e.g. "15-Aug-2026") — the canonical product
// date format. Intl can't produce dashed dd-MMM-yyyy in one pass, so we
// pull the parts and assemble manually.
//
// Timezone resolution: the AuthProvider calls `setActiveTimeZone(tz)`
// after /auth/me returns, passing the company's IANA timezone (or null).
// `fmtDate`/`fmtTime`/`fmtDateTime` use that tz so every timestamp shown
// in the app renders in the TENANT'S clock — not the agent or admin's
// browser clock. null = fall back to the viewer's browser timezone.
let activeTimeZone: string | undefined = undefined;
let TIME_FMT: Intl.DateTimeFormat;
let DATE_PARTS: Intl.DateTimeFormat;
let WEEKDAY_FMT: Intl.DateTimeFormat; // "Mon" — for the chat-list "this week" bucket
let DAYKEY_FMT: Intl.DateTimeFormat; // tz-aware YYYY-MM-DD for today/yesterday compare

function rebuildFormatters() {
  TIME_FMT = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: activeTimeZone,
  });
  DATE_PARTS = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short', // short month name (Jan, Feb, …, May, …)
    day: '2-digit', // zero-padded day (01, 02, …, 16, …)
    timeZone: activeTimeZone,
  });
  WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: activeTimeZone,
  });
  DAYKEY_FMT = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: activeTimeZone,
  });
}

rebuildFormatters();

/** Called by AuthProvider after /auth/me. Pass undefined/null to clear. */
export function setActiveTimeZone(tz: string | null | undefined): void {
  const next = tz ?? undefined;
  if (next === activeTimeZone) return;
  // Validate — Intl throws RangeError on a malformed IANA name. Silently
  // fall back to the browser default instead of breaking every render.
  if (next !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: next }).format(new Date());
    } catch {
      activeTimeZone = undefined;
      rebuildFormatters();
      return;
    }
  }
  activeTimeZone = next;
  rebuildFormatters();
}

export function getActiveTimeZone(): string | undefined {
  return activeTimeZone;
}

/**
 * The UTC instant of midnight (start of day) at `date`, measured in the
 * TENANT'S timezone (`activeTimeZone`, or the browser's when unset). This is
 * what makes "Today"/"Last 7 days" mean the tenant's calendar day — not the
 * UTC day. Without it, a Pakistan (UTC+5) tenant's "today" started at 05:00
 * local and their order counts for a range were off by the early-morning hours
 * that fall in the previous UTC day.
 */
export function zonedStartOfDay(date: Date = new Date()): Date {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: activeTimeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = dtf.formatToParts(date).reduce<Record<string, number>>((a, x) => {
    if (x.type !== 'literal') a[x.type] = Number(x.value);
    return a;
  }, {});
  // The tz's wall-clock time for `date`, re-read as a UTC instant. The gap
  // between that and the real instant is the tz offset at this moment (DST-safe).
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMs = asUtc - date.getTime();
  const startWallUtc = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  return new Date(startWallUtc - offsetMs);
}

/**
 * Timezone-aware date-range for the analytics/orders presets. Boundaries land on
 * the tenant's calendar-day start, so counts match what the tenant sees in
 * Shopify/their own clock. `to` is "now"; `from` is the start of the day
 * `days` days ago (days=0 → start of today).
 */
export function zonedPresetRange(days: number): { from: string; to: string } {
  const now = new Date();
  const todayStart = zonedStartOfDay(now);
  const from =
    days <= 0
      ? todayStart
      : new Date(todayStart.getTime() - days * 86_400_000);
  return { from: from.toISOString(), to: now.toISOString() };
}

function formatDDMMMYYYY(d: Date): string {
  const parts = DATE_PARTS.formatToParts(d);
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  return `${day}-${month}-${year}`;
}

export function fmtTime(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  return TIME_FMT.format(d);
}

export function fmtDate(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  return formatDDMMMYYYY(d);
}

export function fmtDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  // dd-MMM-yyyy · HH:MM
  return `${formatDDMMMYYYY(d)} · ${TIME_FMT.format(d)}`;
}

/**
 * WhatsApp-style chat-list timestamp: today → time (11:05 PM), yesterday →
 * "Yesterday", within the last 7 days → weekday ("Mon"), older → dd-MMM-yyyy.
 * All buckets are computed in the tenant's active timezone.
 */
export function fmtListTime(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const kd = DAYKEY_FMT.format(d);
  if (kd === DAYKEY_FMT.format(now)) return TIME_FMT.format(d);
  const yest = new Date(now.getTime() - 86_400_000);
  if (kd === DAYKEY_FMT.format(yest)) return 'Yesterday';
  if (now.getTime() - d.getTime() < 7 * 86_400_000) return WEEKDAY_FMT.format(d);
  return formatDDMMMYYYY(d);
}

/**
 * Day bucket key (YYYY-MM-DD) for grouping messages by date — computed in the
 * TENANT's timezone (DAYKEY_FMT, en-CA → "2026-08-17"), NOT UTC. Using
 * toISOString() here put a 04:00 PKT message on the previous UTC day, so its
 * divider read "Yesterday". Must match the tenant clock like every other stamp.
 */
export function dayKey(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  return DAYKEY_FMT.format(d);
}

export function dayLabel(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const today = new Date();
  const yest = new Date(today.getTime() - 86_400_000);
  if (dayKey(d) === dayKey(today)) return 'Today';
  if (dayKey(d) === dayKey(yest)) return 'Yesterday';
  return fmtDate(d);
}

/** Live countdown string for the 24-hour WhatsApp window. */
export function windowCountdown(
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): { open: boolean; label: string } {
  if (!expiresAt) return { open: false, label: 'No active window' };
  const ms = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(ms)) return { open: false, label: 'No active window' };
  if (ms <= 0) return { open: false, label: 'Window expired' };
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return { open: true, label: `${h}h ${m}m left` };
}
