'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, Send, Truck } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { cn, fmtDateTime } from '@/lib/utils';
import {
  getTrackingHistory,
  COURIER_LABELS,
  STATUS_LABELS,
  type CourierType,
  type ShipmentStatus,
  type TrackingCheckpoint,
} from '@/lib/couriers';
import type { ContactOrder } from '@/lib/contact-orders';

function courierLabel(t: string | null): string {
  if (!t) return 'Courier';
  return COURIER_LABELS[t as CourierType] ?? t;
}

function statusLabel(s: string | null): string {
  if (!s) return '';
  return STATUS_LABELS[s as ShipmentStatus] ?? s;
}

/** Build the structured tracking message sent to the customer in chat. */
function buildTrackingMessage(
  order: ContactOrder,
  checkpoints: TrackingCheckpoint[],
): string {
  const lines: string[] = [];
  lines.push(`📦 *Order ${order.orderName ?? ''}*`.trim());
  lines.push('');
  lines.push(`🚚 Courier: ${courierLabel(order.courierType)}`);
  if (order.trackingNumber) lines.push(`🔖 Tracking #: ${order.trackingNumber}`);
  const status = statusLabel(order.shipmentStatus);
  if (status) lines.push(`📍 Status: ${status}`);

  // Most recent few checkpoints, newest first.
  const recent = [...checkpoints].reverse().slice(0, 5);
  if (recent.length) {
    lines.push('');
    lines.push('*Recent updates:*');
    for (const c of recent) {
      const when = c.at ? ` — ${fmtDateTime(c.at)}` : '';
      lines.push(`• ${c.status}${when}`);
    }
  }

  if (order.trackingUrl) {
    lines.push('');
    lines.push(`🔗 Track live: ${order.trackingUrl}`);
  }
  return lines.join('\n');
}

/**
 * Shows a contact-order's courier tracking as a NATIVE checkpoint timeline
 * (identical to the Orders tab), plus a "Send tracking info" button that pushes
 * a structured tracking summary straight to the customer in the chat. Reused by
 * the inbox header order chip / contact panel for fulfilled, non-archived orders.
 */
export default function OrderTrackingModal({
  order,
  onClose,
  onSend,
}: {
  order: ContactOrder;
  onClose: () => void;
  /** Sends the given text to the customer; resolves when accepted. */
  onSend: (text: string) => Promise<void>;
}) {
  const shipmentId = order.shipmentId!;
  const [loading, setLoading] = useState(true);
  const [checkpoints, setCheckpoints] = useState<TrackingCheckpoint[] | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getTrackingHistory(shipmentId)
      .then((res) => {
        if (alive) setCheckpoints(res.supported ? res.checkpoints : null);
      })
      .catch(() => {
        if (alive) setCheckpoints(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [shipmentId]);

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      await onSend(buildTrackingMessage(order, checkpoints ?? []));
      onClose();
    } catch {
      // Parent surfaces the toast; keep the modal open so the agent can retry.
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${courierLabel(order.courierType)} tracking — ${order.orderName ?? 'order'}`}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 font-mono text-xs text-gray-500">
            <Truck size={13} className="text-gray-400" />
            {order.trackingNumber ?? '—'}
          </span>
          {order.trackingUrl && (
            <a
              href={order.trackingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-gray-50"
            >
              <ExternalLink size={12} /> Open on courier portal
            </a>
          )}
        </div>

        {loading ? (
          <div className="flex h-40 items-center justify-center text-gray-400">
            <Loader2 size={22} className="animate-spin" />
          </div>
        ) : checkpoints && checkpoints.length ? (
          // Courier APIs return oldest → newest; show newest first.
          <ol className="relative ml-1 space-y-4 border-l border-gray-200 pl-5">
            {[...checkpoints].reverse().map((c, i) => (
              <li key={i} className="relative">
                <span
                  className={cn(
                    'absolute -left-[23px] top-1 h-2.5 w-2.5 rounded-full',
                    i === 0 ? 'bg-green-600 ring-2 ring-green-100' : 'bg-gray-300',
                  )}
                />
                <div className="text-sm font-medium text-gray-800">{c.status}</div>
                {c.detail && <div className="text-xs text-gray-500">{c.detail}</div>}
                {c.at && (
                  <div className="text-[11px] text-gray-400">{fmtDateTime(c.at)}</div>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
            No tracking history available yet
            {order.trackingUrl ? ' — use “Open on courier portal”.' : '.'}
          </div>
        )}

        <div className="flex justify-end border-t border-gray-100 pt-3">
          <button
            type="button"
            onClick={send}
            disabled={sending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
          >
            {sending ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Send size={15} />
            )}
            Send tracking info
          </button>
        </div>
      </div>
    </Modal>
  );
}
