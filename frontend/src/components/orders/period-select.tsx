'use client';

import { PERIOD_OPTIONS, PeriodKey } from '@/lib/date-period';

/**
 * Time-period selector used on the Orders board and Shipments tab: preset chips
 * (All time / Today / Yesterday / Last 7 / Last 30 / This month) + a Custom
 * range with two date inputs. Controlled by the parent (period + custom dates).
 */
export function PeriodSelect({
  period,
  customFrom,
  customTo,
  onChange,
}: {
  period: PeriodKey;
  customFrom: string;
  customTo: string;
  onChange: (next: { period: PeriodKey; customFrom: string; customTo: string }) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PERIOD_OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange({ period: o.key, customFrom, customTo })}
          className={
            'rounded-full px-3 py-1 text-xs font-medium transition ' +
            (period === o.key
              ? 'bg-gray-900 text-white'
              : 'border border-gray-200 text-gray-600 hover:bg-gray-50')
          }
        >
          {o.label}
        </button>
      ))}
      {period === 'custom' && (
        <span className="inline-flex items-center gap-1.5">
          <input
            type="date"
            value={customFrom}
            max={customTo || undefined}
            onChange={(e) =>
              onChange({ period: 'custom', customFrom: e.target.value, customTo })
            }
            className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-700"
          />
          <span className="text-xs text-gray-400">→</span>
          <input
            type="date"
            value={customTo}
            min={customFrom || undefined}
            onChange={(e) =>
              onChange({ period: 'custom', customFrom, customTo: e.target.value })
            }
            className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-700"
          />
        </span>
      )}
    </div>
  );
}
