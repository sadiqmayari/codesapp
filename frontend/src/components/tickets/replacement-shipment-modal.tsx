'use client';

import { useMemo, useState } from 'react';
import { Truck, Loader2, AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import {
  bookReplacementShipment,
  type BookedReplacement,
  type ReplacementContext,
} from '@/lib/tickets';

type CodMode = 'free' | 'diff' | 'custom';

/**
 * Book a replacement parcel (PostEx / Trax / …) for a support ticket. Pre-filled
 * from the linked order; reuses the same courier adapters the fulfillment queue
 * uses. On success the tracking number is saved to the ticket and auto-sent to
 * the customer on WhatsApp (server-side).
 */
export function ReplacementShipmentModal({
  ticketId,
  context,
  onClose,
  onBooked,
}: {
  ticketId: number;
  context: ReplacementContext;
  onClose: () => void;
  onBooked: (r: BookedReplacement) => void;
}) {
  const toast = useToast();
  const { prefill, couriers } = context;

  // Default courier: first that serves the city, else the first active one.
  const defaultCourier =
    couriers.find((c) => c.serves)?.courierType ??
    couriers[0]?.courierType ??
    '';

  const [courierType, setCourierType] = useState(defaultCourier);
  const [name, setName] = useState(prefill.name);
  const [phone, setPhone] = useState(prefill.phone);
  const [email, setEmail] = useState(prefill.email);
  const [city, setCity] = useState(prefill.city);
  const [address1, setAddress1] = useState(prefill.address1);
  const [address2, setAddress2] = useState(prefill.address2);
  const [contents, setContents] = useState(prefill.contents);
  const [codMode, setCodMode] = useState<CodMode>('free');
  const [customCod, setCustomCod] = useState('');
  const [busy, setBusy] = useState(false);

  const codAmount = useMemo(() => {
    if (codMode === 'free') return 0;
    if (codMode === 'diff') return prefill.orderTotal ?? 0;
    const n = Number(customCod);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [codMode, customCod, prefill.orderTotal]);

  const selected = couriers.find((c) => c.courierType === courierType);
  const cityUnserved = !!courierType && selected && !selected.serves && !!city;
  const canSubmit =
    !!courierType && !!name.trim() && !!phone.trim() && !!city.trim() && !!address1.trim();

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const { shipment } = await bookReplacementShipment({
        ticketId,
        courierType,
        name: name.trim(),
        phone: phone.trim(),
        city: city.trim(),
        address1: address1.trim(),
        address2: address2.trim() || undefined,
        contents: contents.trim() || 'Replacement item',
        codAmount,
        email: email.trim() || undefined,
      });
      toast.success(
        shipment.trackingNumber
          ? `Replacement booked — CN ${shipment.trackingNumber}`
          : 'Replacement booked',
      );
      onBooked(shipment);
      onClose();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Booking failed — try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const cur = prefill.currency || 'PKR';

  return (
    <Modal open onClose={onClose} size="md" title="Replacement shipment">
      <div className="p-5 space-y-4">
        <div className="flex items-start gap-2 text-xs bg-blue-50 text-blue-800 rounded-lg px-3 py-2">
          <Truck size={15} className="shrink-0 mt-0.5" />
          <span>
            Pre-filled from{' '}
            <b>{context.ticket.linkedOrderName || 'the linked order'}</b> — edit
            anything the customer corrected on chat. A replacement is a{' '}
            <b>second parcel</b>; it won&apos;t touch the original shipment or
            Shopify fulfillment.
          </span>
        </div>

        {couriers.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-3">
            <AlertTriangle size={16} /> No courier is configured. Add one in
            Settings → Courier first.
          </div>
        ) : (
          <>
            {/* Courier */}
            <div>
              <label className="text-xs font-semibold text-gray-500">Courier</label>
              <div className="mt-1 flex flex-wrap gap-2">
                {couriers.map((c) => (
                  <button
                    key={c.courierType}
                    type="button"
                    onClick={() => setCourierType(c.courierType)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-semibold border transition ${
                      courierType === c.courierType
                        ? 'border-green-600 bg-green-50 text-green-800'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {c.label}
                    {!c.serves && (
                      <span className="ml-1 text-[10px] font-medium text-amber-600">
                        · city?
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {cityUnserved && (
                <p className="mt-1 text-[11px] text-amber-600">
                  {selected?.label} may not serve “{city}”. Booking will fail if
                  the city isn&apos;t mapped — pick another courier or fix the
                  city.
                </p>
              )}
            </div>

            {/* Consignee */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">
                <input className={inp} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Phone">
                <input className={inp} value={phone} onChange={(e) => setPhone(e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="City">
                <input className={inp} value={city} onChange={(e) => setCity(e.target.value)} />
              </Field>
              <Field label="Email (optional)">
                <input className={inp} value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
            </div>
            <Field label="Address">
              <input className={inp} value={address1} onChange={(e) => setAddress1(e.target.value)} placeholder="Street address" />
            </Field>
            {(address2 || prefill.address2) && (
              <Field label="Address line 2 (optional)">
                <input className={inp} value={address2} onChange={(e) => setAddress2(e.target.value)} />
              </Field>
            )}
            <Field label="Contents">
              <input className={inp} value={contents} onChange={(e) => setContents(e.target.value)} />
            </Field>

            {/* COD */}
            <div>
              <label className="text-xs font-semibold text-gray-500">COD amount</label>
              <div className="mt-1 flex gap-2">
                <CodOpt on={codMode === 'free'} onClick={() => setCodMode('free')}>
                  Free · 0
                </CodOpt>
                <CodOpt
                  on={codMode === 'diff'}
                  onClick={() => setCodMode('diff')}
                  disabled={prefill.orderTotal == null}
                >
                  Order total{prefill.orderTotal != null ? ` · ${cur} ${prefill.orderTotal.toLocaleString()}` : ''}
                </CodOpt>
                <CodOpt on={codMode === 'custom'} onClick={() => setCodMode('custom')}>
                  Custom
                </CodOpt>
              </div>
              {codMode === 'custom' && (
                <input
                  className={`${inp} mt-2`}
                  type="number"
                  min={0}
                  value={customCod}
                  onChange={(e) => setCustomCod(e.target.value)}
                  placeholder={`Amount in ${cur}`}
                />
              )}
              <p className="mt-1 text-[11px] text-gray-400">
                Collecting <b>{cur} {codAmount.toLocaleString()}</b> on delivery.
              </p>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={submit}
                disabled={!canSubmit || busy}
                className="flex-1 inline-flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
              >
                {busy && <Loader2 size={15} className="animate-spin" />}
                {busy ? 'Booking…' : `Book on ${selected?.label || 'courier'}`}
              </button>
              <button
                onClick={onClose}
                disabled={busy}
                className="px-4 py-2.5 text-sm text-gray-600 rounded-lg border border-gray-200 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
            <p className="text-[11px] text-gray-400 text-center -mt-1">
              On success: tracking # saved to the ticket + auto-sent to the
              customer on WhatsApp.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

const inp =
  'block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:ring-1 focus:ring-green-400 outline-none';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-semibold text-gray-500">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function CodOpt({
  on,
  onClick,
  disabled,
  children,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 text-center rounded-lg border px-2 py-2 text-xs font-semibold transition disabled:opacity-40 ${
        on
          ? 'border-green-600 bg-green-50 text-green-800'
          : 'border-gray-200 text-gray-600 hover:border-gray-300'
      }`}
    >
      {children}
    </button>
  );
}
