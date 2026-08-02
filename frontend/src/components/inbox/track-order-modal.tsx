'use client';

import { useState } from 'react';
import { ExternalLink, Loader2, PackageSearch, Search, Truck } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { fmtDateTime } from '@/lib/utils';
import { DraggableShell } from './draggable-shell';

interface OrderStatusResult {
  found: boolean;
  error?: boolean;
  name?: string;
  fulfillmentStatus?: string;
  shipmentStatus?: string;
  financialStatus?: string;
  statusUpdatedAt?: string | null;
  tracking?: Array<{ url: string | null; number: string | null; company: string | null }>;
  adminUrl?: string;
}

/**
 * Agent-driven "Track order" popup, opened from the composer's + menu (same
 * floating-window pattern as Create Shopify order). Looks up any order number
 * in the tenant's Shopify store — not scoped to the current chat's contact,
 * consistent with product/customer search elsewhere in this menu — and lets
 * the agent drop a ready-made status message into the composer to review and
 * send (never auto-sent).
 */
export default function TrackOrderModal({
  onInsertMessage,
  onClose,
}: {
  onInsertMessage: (text: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [orderNumber, setOrderNumber] = useState('');
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<OrderStatusResult | null>(null);

  const track = async () => {
    const q = orderNumber.trim();
    if (!q || searching) return;
    setSearching(true);
    setResult(null);
    try {
      const res = await apiFetch<OrderStatusResult>(
        `/shopify/order-status?orderNumber=${encodeURIComponent(q)}`,
      );
      setResult(res);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Could not look up the order',
      );
      setResult({ found: false, error: true });
    } finally {
      setSearching(false);
    }
  };

  const statusLabel = result?.shipmentStatus || result?.fulfillmentStatus;

  const insert = () => {
    if (!result?.found) return;
    const lines = [
      `Your order ${result.name} is currently ${statusLabel ?? 'being processed'}.`,
    ];
    const t = (result.tracking ?? []).find((x) => x.url || x.number);
    if (t) {
      const parts = [t.company, t.number].filter(Boolean).join(' ');
      lines.push(
        t.url
          ? `Track ${parts ? `(${parts}) ` : ''}here: ${t.url}`
          : `Tracking: ${parts}`,
      );
    }
    onInsertMessage(lines.join('\n'));
    onClose();
  };

  return (
    <DraggableShell title="Track order" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex gap-2">
          <input
            autoFocus
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') track();
            }}
            placeholder="#1001"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <button
            type="button"
            onClick={track}
            disabled={!orderNumber.trim() || searching}
            className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {searching ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Search size={14} />
            )}
            Track
          </button>
        </div>

        {result && !result.found && (
          <div className="text-sm text-gray-500 flex items-center gap-2 py-6 justify-center">
            <PackageSearch size={18} className="text-gray-300" />
            {result.error
              ? 'Could not look up the order right now. Try again shortly.'
              : 'No order found with that number.'}
          </div>
        )}

        {result?.found && (
          <div className="border border-gray-200 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-gray-900">{result.name}</span>
              {result.adminUrl && (
                <a
                  href={result.adminUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-green-700 underline inline-flex items-center gap-1"
                >
                  Open in Shopify admin <ExternalLink size={12} />
                </a>
              )}
            </div>

            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Truck size={16} className="text-gray-400 shrink-0" />
              <span className="capitalize">{statusLabel ?? 'Status unavailable'}</span>
            </div>

            {(result.tracking ?? []).length > 0 && (
              <div className="space-y-1.5">
                {(result.tracking ?? []).map((t, i) => (
                  <div key={i} className="text-sm text-gray-600 flex items-center gap-2">
                    {t.company && <span className="font-medium">{t.company}</span>}
                    {t.number && <span>{t.number}</span>}
                    {t.url && (
                      <a
                        href={t.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-green-700 underline"
                      >
                        Track
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}

            {result.statusUpdatedAt && (
              <p className="text-xs text-gray-400">
                Last updated {fmtDateTime(result.statusUpdatedAt)}
              </p>
            )}

            <div className="pt-1">
              <button
                type="button"
                onClick={insert}
                className="w-full px-4 py-2 text-sm rounded-lg border border-green-600 text-green-700 font-medium hover:bg-green-50"
              >
                Insert into composer
              </button>
            </div>
          </div>
        )}
      </div>
    </DraggableShell>
  );
}
