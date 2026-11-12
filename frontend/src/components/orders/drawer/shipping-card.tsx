'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, RotateCcw, Truck, Undo2 } from 'lucide-react';
import { cn, fmtDate, fmtDateTime } from '@/lib/utils';
import type { OrderDetail } from '@/lib/orders';
import {
  getTrackingHistory,
  STATUS_LABELS,
  type ShipmentStatus,
  type TrackingCheckpoint,
} from '@/lib/couriers';
import type { ContactOrder } from '@/lib/contact-orders';
import OrderTrackingModal from '@/components/inbox/order-tracking-modal';
import { ActionButton, CopyButton, Section } from './shared';
import { courierName } from './next-step';

/** Courier checkpoints for the order's shipment, newest first. Lazy + silent:
 *  no shipment / manual / unsupported courier / error → []. */
/** True when the shipment can be tracked (has a courier + tracking #). */
export function canTrackShipment(d: OrderDetail): boolean {
  const sh = d.shipment && d.shipment.status !== 'cancelled' ? d.shipment : null;
  return !!sh && sh.courierType !== 'manual' && !!sh.trackingNumber;
}

export function useTrackingScans(d: OrderDetail | null): {
  scans: TrackingCheckpoint[];
  loading: boolean;
} {
  const sh = d?.shipment;
  const id = sh && sh.courierType !== 'manual' && sh.trackingNumber ? sh.id : null;
  const [state, setState] = useState<{ id: number | null; scans: TrackingCheckpoint[]; loading: boolean }>(
    { id: null, scans: [], loading: false },
  );
  useEffect(() => {
    if (id == null) {
      setState({ id: null, scans: [], loading: false });
      return;
    }
    let alive = true;
    setState({ id, scans: [], loading: true });
    getTrackingHistory(id)
      .then((h) => {
        if (!alive) return;
        const list = [...(h.checkpoints ?? [])].sort(
          (a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime(),
        );
        setState({ id, scans: list, loading: false });
      })
      .catch(() => alive && setState({ id, scans: [], loading: false }));
    return () => {
      alive = false;
    };
  }, [id]);
  return { scans: state.scans, loading: state.loading };
}

/** Synthesize the ContactOrder shape the shared tracking modal expects. */
function toContactOrder(d: OrderDetail): ContactOrder {
  const o = d.order;
  const sh = d.shipment!;
  return {
    orderGid: o.orderGid,
    orderName: o.orderName,
    financialStatus: o.financialStatus,
    fulfillmentStatus: o.fulfillmentStatus,
    shipmentId: sh.id,
    shipmentStatus: sh.status,
    courierType: sh.courierType,
    trackingNumber: sh.trackingNumber ?? o.trackingNumber,
    trackingUrl: sh.trackingUrl,
    total: o.totalPrice,
    outstanding: o.totalOutstanding,
    currency: o.currency,
    createdAt: o.createdAt,
    itemsSummary: d.lineItemsSummary,
    cancelled: !!o.cancelledAt,
    archived: !!o.archivedAt,
  };
}

export function ShippingCard({
  d,
  scans,
  scansLoading,
  manualPanel,
  trackOpen,
  onTrackOpen,
}: {
  d: OrderDetail;
  scans: TrackingCheckpoint[];
  scansLoading: boolean;
  /** The "Fulfil manually" form, when the user opened it from the ⋯ menu. */
  manualPanel?: React.ReactNode;
  /** Full tracking modal — controlled so the next-step "Track" can open it. */
  trackOpen: boolean;
  onTrackOpen: (open: boolean) => void;
}) {
  const o = d.order;
  const sh = d.shipment && d.shipment.status !== 'cancelled' ? d.shipment : null;
  const tracking = o.trackingNumber ?? sh?.trackingNumber ?? null;
  const courier = sh ? courierName(sh.courierType) : o.trackingCompany;
  const statusLabel = sh
    ? STATUS_LABELS[sh.status as ShipmentStatus] ?? sh.status.replace(/_/g, ' ')
    : null;
  const canTrack = !!sh && sh.courierType !== 'manual' && !!sh.trackingNumber;

  return (
    <Section
      title="Shipping"
      icon={<Truck size={13} />}
      right={
        canTrack ? (
          <button
            type="button"
            onClick={() => onTrackOpen(true)}
            className="font-bold text-sky-700 hover:underline"
          >
            Full tracking ›
          </button>
        ) : null
      }
    >
      {!sh && !tracking ? (
        <p className="text-[13px] text-muted">
          {['fulfilled', 'partially_fulfilled'].includes((o.fulfillmentStatus ?? '').toLowerCase())
            ? 'Fulfilled outside CodesApp, so there is no local booking.'
            : 'Not booked yet.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Box label="Courier" value={courier ?? '—'} sub={statusLabel ?? undefined} />
          <Box
            label="Tracking #"
            value={
              tracking ? (
                <span className="flex min-w-0 items-center gap-0.5">
                  {sh?.trackingUrl ? (
                    <a
                      href={sh.trackingUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate font-mono text-[12.5px] text-sky-700 hover:underline"
                    >
                      {tracking}
                    </a>
                  ) : (
                    <span className="truncate font-mono text-[12.5px]">{tracking}</span>
                  )}
                  <CopyButton value={tracking} label="tracking number" />
                </span>
              ) : (
                '—'
              )
            }
            sub={
              sh?.bookedAt
                ? `Booked ${fmtDate(sh.bookedAt)}`
                : o.deliveredAt
                  ? `Delivered ${fmtDate(o.deliveredAt)}`
                  : undefined
            }
          />
        </div>
      )}

      {sh?.shipperAdviceRequiredAt && sh.status === 'attempted' && (
        <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[12.5px] font-semibold text-amber-800">
          <AlertTriangle size={15} className="mt-px shrink-0" />
          <span>
            <b className="font-extrabold">Awaiting shipper advice</b>
            {sh.shipperAdviceRequiredRaw ? ` · courier status “${sh.shipperAdviceRequiredRaw}”` : ''}
          </span>
        </div>
      )}
      {sh?.shipperAdvice && (
        <p className="mt-2 text-xs text-muted">
          Advice sent: <span className="font-semibold text-ink">{sh.shipperAdvice}</span>
        </p>
      )}

      {canTrack && (
        <ul className="mt-3 space-y-2">
          {scansLoading && <li className="text-xs text-muted">Loading courier scans…</li>}
          {!scansLoading && scans.length === 0 && sh?.lastStatusRaw && (
            <Scan first text={sh.lastStatusRaw} at={null} />
          )}
          {scans.slice(0, 3).map((c, i) => (
            <Scan key={i} first={i === 0} text={c.detail ? `${c.status} · ${c.detail}` : c.status} at={c.at ?? null} />
          ))}
        </ul>
      )}

      {manualPanel && <div className="mt-3 border-t border-line pt-3">{manualPanel}</div>}

      {trackOpen && sh && (
        <OrderTrackingModal order={toContactOrder(d)} onClose={() => onTrackOpen(false)} />
      )}
    </Section>
  );
}

function Box({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-sunken px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="min-w-0 text-[13.5px] font-extrabold text-ink">{value}</div>
      {sub && <div className="text-xs capitalize text-muted">{sub}</div>}
    </div>
  );
}

function Scan({ text, at, first }: { text: string; at: string | null; first?: boolean }) {
  return (
    <li className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-start gap-2 text-[12.5px]">
      <span
        className={cn(
          'mt-1 h-2.5 w-2.5 rounded-full',
          first ? 'bg-amber-500 ring-2 ring-amber-100' : 'bg-line',
        )}
      />
      <span className="text-ink min-w-0 break-words [word-break:break-word]">{text}</span>
      {at && <span className="whitespace-nowrap text-xs text-muted">{fmtDateTime(at)}</span>}
    </li>
  );
}

/** Inline confirm-with-remarks for posting shipper advice from the drawer. */
export function ShipperAdviceForm({
  action,
  courier,
  busy,
  onCancel,
  onSubmit,
}: {
  action: 'reattempt' | 'return';
  courier: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (remarks: string) => void;
}) {
  const [remarks, setRemarks] = useState(
    action === 'reattempt'
      ? 'Customer confirmed. Please re-attempt delivery.'
      : 'Please return the parcel to the shipper.',
  );
  return (
    <div className="space-y-2.5 rounded-2xl border border-line bg-surface p-3.5">
      <p className="text-[13px] font-bold text-ink">
        {action === 'reattempt' ? `Ask ${courier} to re-attempt delivery` : `Ask ${courier} to return the parcel`}
      </p>
      <label htmlFor="advice-remarks" className="block text-xs text-muted">
        Remarks for the courier
      </label>
      <textarea
        id="advice-remarks"
        value={remarks}
        onChange={(e) => setRemarks(e.target.value)}
        rows={2}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink"
      />
      <div className="flex justify-end gap-2">
        <ActionButton onClick={onCancel} disabled={busy}>
          Cancel
        </ActionButton>
        <ActionButton
          tone={action === 'reattempt' ? 'primary' : 'danger'}
          icon={action === 'reattempt' ? <RotateCcw size={13} /> : <Undo2 size={13} />}
          busy={busy}
          disabled={!remarks.trim()}
          onClick={() => onSubmit(remarks.trim())}
        >
          {action === 'reattempt' ? 'Send re-attempt' : 'Send return'}
        </ActionButton>
      </div>
    </div>
  );
}

