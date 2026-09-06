'use client';

import { useMemo, useRef, useState } from 'react';
import {
  Truck,
  Loader2,
  AlertTriangle,
  PackageCheck,
  Undo2,
  ImagePlus,
  X,
} from 'lucide-react';
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
 * Book a replacement parcel (PostEx / Trax / …) for a support ticket. A
 * replacement is two-legged — deliver the new item AND pick up the old one — so
 * the form captures both the item SENT and the item TAKEN BACK (Trax requires
 * the latter + accepts a photo of it). Pre-filled from the linked order; reuses
 * the same courier adapters the fulfillment queue uses.
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
  const originalItems = prefill.contents.replace(/^replacement:\s*/i, '').trim();

  const defaultCourier =
    couriers.find((c) => c.serves)?.courierType ??
    couriers[0]?.courierType ??
    '';

  const [courierType, setCourierType] = useState(defaultCourier);
  // Deliver-to
  const [name, setName] = useState(prefill.name);
  const [phone, setPhone] = useState(prefill.phone);
  const [email, setEmail] = useState(prefill.email);
  const [city, setCity] = useState(prefill.city);
  const [address1, setAddress1] = useState(prefill.address1);
  const [address2, setAddress2] = useState(prefill.address2);
  // Item being sent
  const [contents, setContents] = useState(prefill.contents);
  // Item being taken back (return leg)
  const [returnDesc, setReturnDesc] = useState(originalItems);
  const [returnQty, setReturnQty] = useState('1');
  const [returnImage, setReturnImage] = useState<File | null>(null);
  const [imgPreview, setImgPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Payment
  const [codMode, setCodMode] = useState<CodMode>('free');
  const [customCod, setCustomCod] = useState('');
  const [busy, setBusy] = useState(false);

  const isTrax = courierType === 'trax';

  const codAmount = useMemo(() => {
    if (codMode === 'free') return 0;
    if (codMode === 'diff') return prefill.orderTotal ?? 0;
    const n = Number(customCod);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [codMode, customCod, prefill.orderTotal]);

  const selected = couriers.find((c) => c.courierType === courierType);
  const cityUnserved = !!courierType && selected && !selected.serves && !!city;
  const canSubmit =
    !!courierType &&
    !!name.trim() &&
    !!phone.trim() &&
    !!city.trim() &&
    !!address1.trim() &&
    !!contents.trim() &&
    (!isTrax || !!returnDesc.trim());

  const pickImage = (f: File | null) => {
    if (imgPreview) URL.revokeObjectURL(imgPreview);
    if (f && /^image\/(png|jpe?g)$/i.test(f.type)) {
      setReturnImage(f);
      setImgPreview(URL.createObjectURL(f));
    } else if (f) {
      toast.error('Use a PNG or JPEG image.');
    }
  };

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
        contents: contents.trim(),
        codAmount,
        email: email.trim() || undefined,
        returnItemDescription: returnDesc.trim() || undefined,
        returnItemQuantity: Number(returnQty) > 0 ? Number(returnQty) : 1,
        returnImage,
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
    <Modal open onClose={onClose} size="lg" title="Replacement shipment">
      <div className="p-5 space-y-5">
        <div className="flex items-start gap-2 text-xs bg-blue-50 text-blue-800 rounded-lg px-3 py-2">
          <Truck size={15} className="shrink-0 mt-0.5" />
          <span>
            A replacement is a <b>second parcel</b> for{' '}
            <b>{context.ticket.linkedOrderName || 'the order'}</b> — the courier
            delivers the new item and picks up the old one. It won&apos;t touch
            the original shipment or Shopify fulfillment.
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
            <Section title="Courier">
              <div className="flex flex-wrap gap-2">
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
                <p className="mt-1.5 text-[11px] text-amber-600">
                  {selected?.label} may not serve “{city}” for replacements —
                  booking will fail if the city isn&apos;t mapped for this
                  service. Pick another courier or fix the city.
                </p>
              )}
            </Section>

            {/* Two legs, side by side on wider screens */}
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="rounded-xl border border-gray-200 p-3.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-green-700 uppercase tracking-wide mb-2.5">
                  <PackageCheck size={14} /> Item being sent
                </div>
                <Field label="Contents">
                  <input
                    className={inp}
                    value={contents}
                    onChange={(e) => setContents(e.target.value)}
                    placeholder="Replacement item"
                  />
                </Field>
              </div>

              <div
                className={`rounded-xl border p-3.5 ${
                  isTrax ? 'border-amber-200 bg-amber-50/40' : 'border-gray-200'
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs font-bold text-amber-700 uppercase tracking-wide mb-2.5">
                  <Undo2 size={14} /> Item taken back
                  {isTrax && <span className="text-rose-500">*</span>}
                  {!isTrax && (
                    <span className="ml-1 text-[10px] font-medium text-gray-400 normal-case tracking-normal">
                      (Trax only)
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Field label="Description">
                      <input
                        className={inp}
                        value={returnDesc}
                        onChange={(e) => setReturnDesc(e.target.value)}
                        placeholder="The defective/old item"
                      />
                    </Field>
                  </div>
                  <div className="w-16">
                    <Field label="Qty">
                      <input
                        className={inp}
                        type="number"
                        min={1}
                        value={returnQty}
                        onChange={(e) => setReturnQty(e.target.value)}
                      />
                    </Field>
                  </div>
                </div>
                {/* Return-item photo */}
                <div className="mt-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg"
                    hidden
                    onChange={(e) => pickImage(e.target.files?.[0] ?? null)}
                  />
                  {imgPreview ? (
                    <div className="flex items-center gap-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={imgPreview}
                        alt="Return item"
                        className="w-12 h-12 rounded-lg object-cover border border-gray-200"
                      />
                      <span className="text-xs text-gray-500 truncate flex-1">
                        {returnImage?.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          pickImage(null);
                          setReturnImage(null);
                          if (imgPreview) URL.revokeObjectURL(imgPreview);
                          setImgPreview(null);
                          if (fileRef.current) fileRef.current.value = '';
                        }}
                        className="text-gray-400 hover:text-rose-600"
                        aria-label="Remove photo"
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 border border-dashed border-gray-300 rounded-lg px-3 py-1.5 hover:border-gray-400"
                    >
                      <ImagePlus size={14} /> Add photo of item
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Deliver to */}
            <Section title="Deliver to">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name">
                  <input className={inp} value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Phone">
                  <input className={inp} value={phone} onChange={(e) => setPhone(e.target.value)} />
                </Field>
                <Field label="City">
                  <input className={inp} value={city} onChange={(e) => setCity(e.target.value)} />
                </Field>
                <Field label="Email (optional)">
                  <input className={inp} value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
              </div>
              <div className="mt-3">
                <Field label="Address">
                  <input className={inp} value={address1} onChange={(e) => setAddress1(e.target.value)} placeholder="Street address" />
                </Field>
              </div>
              {(address2 || prefill.address2) && (
                <div className="mt-3">
                  <Field label="Address line 2 (optional)">
                    <input className={inp} value={address2} onChange={(e) => setAddress2(e.target.value)} />
                  </Field>
                </div>
              )}
            </Section>

            {/* COD */}
            <Section title="COD amount">
              <div className="flex gap-2">
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
              <p className="mt-1.5 text-[11px] text-gray-400">
                Collecting <b>{cur} {codAmount.toLocaleString()}</b> on delivery.
              </p>
            </Section>

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
            <p className="text-[11px] text-gray-400 text-center -mt-2">
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

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
