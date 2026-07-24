'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  RefreshCw,
  Truck,
  AlertTriangle,
  FileText,
  Plus,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { fmtDate, cn } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import {
  listShipments,
  listLoadsheets,
  generateLoadsheet,
  resolveAddressIssue,
  redeliverShipment,
  bookShipment,
  COURIER_TYPES,
  COURIER_LABELS,
  STATUS_LABELS,
  type Shipment,
  type ShipmentStatus,
  type CourierType,
  type LoadsheetBatch,
} from '@/lib/couriers';

type Filter = 'all' | ShipmentStatus | 'needs_attention';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'booked', label: 'Booked' },
  { key: 'in_transit', label: 'In transit' },
  { key: 'out_for_delivery', label: 'Out for delivery' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'attempted', label: 'Attempted' },
  { key: 'failed', label: 'Failed' },
  { key: 'address_issue', label: 'Address issue' },
  { key: 'needs_attention', label: 'Needs attention' },
];

const STATUS_STYLES: Record<ShipmentStatus, string> = {
  booked: 'bg-blue-50 text-blue-700',
  in_transit: 'bg-indigo-50 text-indigo-700',
  out_for_delivery: 'bg-violet-50 text-violet-700',
  picked_up: 'bg-sky-50 text-sky-700',
  ready_for_pickup: 'bg-cyan-50 text-cyan-700',
  delivered: 'bg-green-50 text-green-700',
  attempted: 'bg-amber-50 text-amber-700',
  failed: 'bg-red-50 text-red-700',
  address_issue: 'bg-orange-50 text-orange-700',
  cancelled: 'bg-gray-100 text-gray-600',
  returned: 'bg-rose-50 text-rose-700',
};

export default function FulfillmentPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Shipment[] | null>(null);
  const [batches, setBatches] = useState<LoadsheetBatch[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [bookOpen, setBookOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [shipments, loadsheetBatches] = await Promise.all([
        listShipments(),
        listLoadsheets().catch(() => []),
      ]);
      setRows(shipments);
      setBatches(loadsheetBatches);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load shipments',
      );
      setRows([]);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    if (!rows) return [];
    if (filter === 'all') return rows;
    // "Needs attention" surfaces rows whose courier sent a status we couldn't
    // map (the n8n Switch nodes silently dropped these) or that failed to book.
    if (filter === 'needs_attention') {
      return rows.filter(
        (r) =>
          (r.last_courier_status_raw && r.status === 'booked') || !!r.booking_error,
      );
    }
    return rows.filter((r) => r.status === filter);
  }, [rows, filter]);

  const runLoadsheet = async (courierType: CourierType) => {
    try {
      await generateLoadsheet(courierType);
      toast.success(`${COURIER_LABELS[courierType]} loadsheet queued`);
      load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to generate loadsheet',
      );
    }
  };

  const act = async (id: number, fn: () => Promise<unknown>, msg: string) => {
    setBusyId(id);
    try {
      await fn();
      toast.success(msg);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'px-3 py-1.5 text-xs rounded-lg border',
                filter === f.key
                  ? 'bg-green-600 border-green-600 text-white'
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setBookOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-green-600 text-white hover:bg-green-700"
          >
            <Plus className="w-3.5 h-3.5" /> Book shipment
          </button>
          <button
            onClick={load}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-1.5">
          <FileText className="w-4 h-4" /> Loadsheets
        </h3>
        <div className="flex flex-wrap gap-2 mb-3">
          {COURIER_TYPES.map((c) => (
            <button
              key={c}
              onClick={() => runLoadsheet(c)}
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
            >
              Generate {COURIER_LABELS[c]}
            </button>
          ))}
        </div>
        {batches.length === 0 ? (
          <p className="text-xs text-gray-400">No loadsheets generated yet.</p>
        ) : (
          <div className="space-y-1">
            {batches.slice(0, 5).map((b) => (
              <div
                key={b.id}
                className="flex items-center gap-3 text-xs text-gray-600"
              >
                <span className="font-medium">{COURIER_LABELS[b.courier_type]}</span>
                <span>{b.shipment_count} shipments</span>
                <span
                  className={cn(
                    'px-1.5 py-0.5 rounded',
                    b.status === 'ready'
                      ? 'bg-green-50 text-green-700'
                      : b.status === 'failed'
                        ? 'bg-red-50 text-red-700'
                        : 'bg-gray-100 text-gray-600',
                  )}
                >
                  {b.status}
                </span>
                {b.pdf_media_url && (
                  <a
                    href={b.pdf_media_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-green-700 hover:underline"
                  >
                    PDF
                  </a>
                )}
                <span className="text-gray-400">{fmtDate(b.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {rows === null ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
          <Truck className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No shipments in this view.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Order</th>
                  <th className="text-left px-4 py-2 font-medium">Courier</th>
                  <th className="text-left px-4 py-2 font-medium">Tracking</th>
                  <th className="text-left px-4 py-2 font-medium">City</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="text-left px-4 py-2 font-medium">Created</th>
                  <th className="text-right px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium text-gray-800">
                      {s.shopify_order_name || '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {COURIER_LABELS[s.courier_type]}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {s.courier_tracking_number || '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {s.destination_city || '—'}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={cn(
                          'px-2 py-0.5 rounded-full text-xs',
                          STATUS_STYLES[s.status],
                        )}
                      >
                        {STATUS_LABELS[s.status]}
                      </span>
                      {s.address_issue_reason && (
                        <p className="text-[11px] text-orange-600 mt-1 flex items-start gap-1">
                          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                          {s.address_issue_reason}
                        </p>
                      )}
                      {s.booking_error && (
                        <p className="text-[11px] text-red-600 mt-1">
                          {s.booking_error}
                        </p>
                      )}
                      {s.last_courier_status_raw && s.status === 'booked' && (
                        <p className="text-[11px] text-amber-600 mt-1">
                          Unmapped courier status: {s.last_courier_status_raw}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-400 text-xs">
                      {fmtDate(s.created_at)}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {s.status === 'address_issue' && (
                        <button
                          disabled={busyId === s.id}
                          onClick={() =>
                            act(
                              s.id,
                              () => resolveAddressIssue(s.id),
                              'Address confirmed — booking queued',
                            )
                          }
                          className="text-xs text-green-700 hover:underline disabled:opacity-50"
                        >
                          Mark resolved &amp; book
                        </button>
                      )}
                      {(s.status === 'attempted' || s.status === 'failed') &&
                        s.courier_type === 'postex' && (
                          <button
                            disabled={busyId === s.id}
                            onClick={() =>
                              act(
                                s.id,
                                () => redeliverShipment(s.id),
                                'Redelivery requested',
                              )
                            }
                            className="text-xs text-green-700 hover:underline disabled:opacity-50 ml-3"
                          >
                            Request redelivery
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {bookOpen && (
        <BookShipmentModal
          onClose={() => setBookOpen(false)}
          onBooked={() => {
            setBookOpen(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function BookShipmentModal({
  onClose,
  onBooked,
}: {
  onClose: () => void;
  onBooked: () => void;
}) {
  const toast = useToast();
  const [orderName, setOrderName] = useState('');
  const [courierType, setCourierType] = useState<CourierType | ''>('');
  const [busy, setBusy] = useState(false);

  const submit = async (overrideAddressIssue = false) => {
    if (!orderName.trim()) {
      toast.error('Enter a Shopify order number');
      return;
    }
    setBusy(true);
    try {
      const shipment = await bookShipment({
        shopifyOrderName: orderName.trim(),
        courierType: courierType || undefined,
        overrideAddressIssue,
      });
      if (shipment.status === 'address_issue') {
        toast.info(
          `Address issue flagged: ${shipment.address_issue_reason ?? 'incomplete address'}. Review it in the Address issue tab.`,
        );
      } else {
        toast.success('Shipment booking queued');
      }
      onBooked();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to book shipment');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Book shipment">
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Shopify order number
          </label>
          <input
            value={orderName}
            onChange={(e) => setOrderName(e.target.value)}
            placeholder="#14017"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Courier</label>
          <select
            value={courierType}
            onChange={(e) => setCourierType(e.target.value as CourierType | '')}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Auto-suggest from destination city</option>
            {COURIER_TYPES.map((c) => (
              <option key={c} value={c}>
                {COURIER_LABELS[c]}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-gray-500 mt-1">
            Leave on auto to pick the courier that serves the order&apos;s city.
          </p>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={() => submit(false)}
            disabled={busy}
            className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? 'Booking…' : 'Book shipment'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
