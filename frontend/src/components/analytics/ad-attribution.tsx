'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Megaphone } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { fmtDate } from '@/lib/utils';

interface AdRow {
  sourceId: string;
  headline: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  chats: number;
  contacts: number;
  orders: number;
  firstAt: string | null;
  lastAt: string | null;
}

/**
 * Click-to-WhatsApp ad attribution: chats / contacts / orders per ad or post
 * that drove conversations (grouped by the referral captured first-touch).
 */
export default function AdAttribution() {
  const [rows, setRows] = useState<AdRow[] | null>(null);

  useEffect(() => {
    apiFetch<AdRow[]>('/analytics/ad-attribution')
      .then((r) => setRows(Array.isArray(r) ? r : []))
      .catch(() => setRows([]));
  }, []);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Megaphone size={18} className="text-indigo-500" />
        <h3 className="font-semibold text-gray-900">Ad attribution</h3>
        <span className="text-xs text-gray-400">
          Chats that started from a WhatsApp ad or post
        </span>
      </div>

      {rows === null ? (
        <div className="py-10 flex justify-center">
          <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400">
          No ad-attributed chats yet. When a customer messages you from a
          Click-to-WhatsApp ad or a Facebook/Instagram post, it appears here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                <th className="py-2 pr-3 font-medium">Ad / Post</th>
                <th className="py-2 px-3 font-medium text-right">Chats</th>
                <th className="py-2 px-3 font-medium text-right">Contacts</th>
                <th className="py-2 px-3 font-medium text-right">Orders</th>
                <th className="py-2 px-3 font-medium text-right">Conv. rate</th>
                <th className="py-2 pl-3 font-medium">Last</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rate =
                  r.chats > 0 ? Math.round((r.orders / r.chats) * 100) : 0;
                return (
                  <tr
                    key={r.sourceId}
                    className="border-b border-gray-50 last:border-0"
                  >
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={
                            'shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded ' +
                            ((r.sourceType || '').toLowerCase() === 'ad'
                              ? 'bg-indigo-50 text-indigo-600'
                              : 'bg-gray-100 text-gray-500')
                          }
                        >
                          {(r.sourceType || 'ad').toUpperCase()}
                        </span>
                        <span className="truncate text-gray-900">
                          {r.headline || `#${r.sourceId}`}
                        </span>
                        {r.sourceUrl && (
                          <a
                            href={r.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-indigo-500 hover:text-indigo-700"
                            title="Open the ad/post"
                          >
                            <ExternalLink size={13} />
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums">
                      {r.chats}
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums">
                      {r.contacts}
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums font-medium text-gray-900">
                      {r.orders}
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums text-gray-500">
                      {rate}%
                    </td>
                    <td className="py-2.5 pl-3 text-xs text-gray-400 whitespace-nowrap">
                      {r.lastAt ? fmtDate(r.lastAt) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
