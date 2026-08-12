// Time-period presets for the Orders / Shipments date filter. Ranges are
// computed in the browser's LOCAL time (so "Today" means the user's today) and
// returned as UTC ISO strings for the API (which stores timestamps in UTC).

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

const startOfDay = (d: Date): Date => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const endOfDay = (d: Date): Date => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

/**
 * Resolve a period key (+ optional custom from/to `YYYY-MM-DD`) to a UTC ISO
 * range. `{}` means no bound (all time). Custom uses inclusive day boundaries.
 */
export function periodRange(
  key: PeriodKey,
  custom?: { from?: string; to?: string },
): { from?: string; to?: string } {
  const now = new Date();
  switch (key) {
    case 'today':
      return { from: startOfDay(now).toISOString(), to: endOfDay(now).toISOString() };
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: startOfDay(y).toISOString(), to: endOfDay(y).toISOString() };
    }
    case '7d': {
      const f = new Date(now);
      f.setDate(f.getDate() - 6); // last 7 days incl. today
      return { from: startOfDay(f).toISOString(), to: endOfDay(now).toISOString() };
    }
    case '30d': {
      const f = new Date(now);
      f.setDate(f.getDate() - 29);
      return { from: startOfDay(f).toISOString(), to: endOfDay(now).toISOString() };
    }
    case 'month': {
      const f = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: startOfDay(f).toISOString(), to: endOfDay(now).toISOString() };
    }
    case 'custom': {
      const out: { from?: string; to?: string } = {};
      if (custom?.from) out.from = startOfDay(new Date(`${custom.from}T00:00:00`)).toISOString();
      if (custom?.to) out.to = endOfDay(new Date(`${custom.to}T00:00:00`)).toISOString();
      return out;
    }
    case 'all':
    default:
      return {};
  }
}
