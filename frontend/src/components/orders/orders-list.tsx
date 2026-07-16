'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, ExternalLink, RefreshCw } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/utils';
import { cn } from '@/lib/utils';
import {
  listCreatedOrders,
  type CreatedOrderRow,
  type OrdersScope,
} from '@/lib/orders';

type Preset = 'today' | '7d' | '30d' | '90d';

const PRESETS: Array<{ key: Preset; label: string; days: number }> = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
];

function rangeFor(preset: Preset): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  if (preset === 'today') from.setHours(0, 0, 0, 0);
  else from.setDate(from.getDate() - PRESETS.find((p) => p.key === preset)!.days);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function OrdersList({ scope }: { scope: OrdersScope }) {
  const [preset, setPreset] = useState<Preset>('30d');
  const [rows, setRows] = useState<CreatedOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => rangeFor(preset), [preset]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listCreatedOrders(scope, range.from, range.to));
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [scope, range.from, range.to]);

  useEffect(() => {
    load();
  }, [load]);

  const lastCol = scope === 'ad' ? 'Ad source' : 'Agent';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              className={cn(
                'px-3 py-1.5 text-sm rounded-md transition-colors',
                preset === p.key
                  ? 'bg-green-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          {scope === 'ad'
            ? 'No orders attributed to an ad in this period.'
            : 'No agent-created orders in this period.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Order no.</th>
                <th className="px-4 py-3 font-medium">Date created</th>
                <th className="px-4 py-3 font-medium">Items</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">City</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">{lastCol}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.orderGid} className="hover:bg-gray-50 align-top">
                  <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                    {r.adminUrl ? (
                      <a
                        href={r.adminUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-green-700 hover:underline"
                      >
                        {r.orderNo || '—'}
                        <ExternalLink size={13} />
                      </a>
                    ) : (
                      r.orderNo || '—'
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {r.dateCreated ? fmtDate(r.dateCreated) : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600 max-w-[260px]">
                    {r.items.length ? (
                      <span className="line-clamp-2">
                        {r.items
                          .map((it) => `${it.quantity}× ${it.title}`)
                          .join(', ')}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {r.customerName || '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{r.city || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {r.contactEmail || '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {scope === 'ad'
                      ? r.adHeadline || r.adSourceType || 'Ad'
                      : r.agentName || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
