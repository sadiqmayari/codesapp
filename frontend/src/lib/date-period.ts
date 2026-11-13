// Time-period presets for the Orders / Shipments / Attendance date filters.
// Ranges are computed on the TENANT's clock (`lib/utils` zoned helpers, driven
// by `companies.timezone`) — NOT the browser's — so "Today" means the shop's
// today even when the viewer's laptop is set to another zone. Returned as UTC
// ISO strings for the API.

import {
  zonedDayRange,
  zonedMonthRange,
  zonedPresetRange,
  zonedTodayRange,
  zonedYesterdayRange,
  zonedYMDString as toTenantYMD,
} from './utils';

export type PeriodKey =
  | 'all'
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | 'month'
  | 'custom';

export const PERIOD_OPTIONS: { key: PeriodKey; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'custom', label: 'Custom' },
];

/**
 * Resolve a period key (+ optional custom from/to `YYYY-MM-DD`) to a UTC ISO
 * range. `{}` means no bound (all time). Custom uses inclusive tenant-day
 * boundaries.
 */
export function periodRange(
  key: PeriodKey,
  custom?: { from?: string; to?: string },
): { from?: string; to?: string } {
  switch (key) {
    case 'today':
      return zonedTodayRange();
    case 'yesterday':
      return zonedYesterdayRange();
    case '7d':
      return zonedPresetRange(6); // last 7 days incl. today
    case '30d':
      return zonedPresetRange(29);
    case 'month':
      return zonedMonthRange(0);
    case 'custom':
      return zonedDayRange(custom?.from, custom?.to);
    case 'all':
    default:
      return {};
  }
}

/** Tenant-zone `YYYY-MM-DD` bounds of a period (for APIs that take bare days). */
export function periodDays(
  key: PeriodKey,
  custom?: { from?: string; to?: string },
): { from?: string; to?: string } {
  if (key === 'custom') return { from: custom?.from, to: custom?.to };
  const r = periodRange(key);
  const ymd = (iso?: string) => (iso ? toTenantYMD(new Date(iso)) : undefined);
  return { from: ymd(r.from), to: ymd(r.to) };
}
