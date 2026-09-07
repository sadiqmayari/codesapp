'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Truck,
  Loader2,
  AlertTriangle,
  PackageCheck,
  Undo2,
  ImagePlus,
  X,
  Search,
  Plus,
} from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { apiFetch, ApiError } from '@/lib/api';
import {
  bookReplacementShipment,
  type BookedReplacement,
  type ReplacementContext,
  type ReplacementLineItem,
} from '@/lib/tickets';

type CodMode = 'free' | 'diff' | 'custom';

interface ProductVariant {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  price: string;
  sku: string | null;
  image: string | null;
  available: boolean;
}

interface Line {
  key: string;
  title: string;
  variantTitle: string | null;
  variantId: string | null;
  quantity: number;
}

const lineKey = (l: { variantId: string | null; title: string }) =>
  l.variantId || l.title;

const fromContext = (items: ReplacementLineItem[]): Line[] =>
  items.map((i) => ({
    key: lineKey(i),
    title: i.title,
    variantTitle:
      i.variantTitle && i.variantTitle !== 'Default Title' ? i.variantTitle : null,
    variantId: i.variantId,
    quantity: i.quantity,
  }));

const summarize = (items: Line[]): string =>
  items
    .map((i) => `${i.quantity}x ${i.title}${i.variantTitle ? ` (${i.variantTitle})` : ''}`)
    .join(', ');

const totalQty = (items: Line[]) => items.reduce((s, i) => s + i.quantity, 0);

/**
 * Book a replacement parcel (PostEx / Trax / …) for a support ticket. Two legs —
 * the item(s) SENT and the item(s) TAKEN BACK — both filled from the Shopify
 * order's line items (no typing); the sending leg can also search Shopify for an
 * exchange. Trax requires the return leg + accepts a photo of it.
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
  const { prefill, couriers, orderLineItems } = context;

  const defaultCourier =
    couriers.find((c) => c.serves)?.courierType ?? couriers[0]?.courierType ?? '';

  const [courierType, setCourierType] = useState(defaultCourier);
  // Legs — both default to the order's line items.
  const [sentItems, setSentItems] = useState<Line[]>(() => fromContext(orderLineItems));
  const [returnItems, setReturnItems] = useState<Line[]>(() => fromContext(orderLineItems));
  // Deliver-to
  const [name, setName] = useState(prefill.name);
  const [phone, setPhone] = useState(prefill.phone);
  const [email, setEmail] = useState(prefill.email);
  const [city, setCity] = useState(prefill.city);
  const [address1, setAddress1] = useState(prefill.address1);
  const [address2, setAddress2] = useState(prefill.address2);
  // Return-item photo
  const [returnImage, setReturnImage] = useState<File | null>(null);
  const [imgPreview, setImgPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Payment
  const [codMode, setCodMode] = useState<CodMode>('free');
  const [customCod, setCustomCod] = useState('');
  const [busy, setBusy] = useState(false);
  // Product search (sending leg)
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductVariant[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isTrax = courierType === 'trax';

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await apiFetch<ProductVariant[]>('/shopify/products', {
        params: { query: q },
      });
      setResults(Array.isArray(res) ? res : []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => runSearch(query.trim()), 350);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, runSearch]);

  const addFromSearch = (v: ProductVariant) => {
    const vt = v.variantTitle && v.variantTitle !== 'Default Title' ? v.variantTitle : null;
    setSentItems((cur) => {
      const i = cur.findIndex((x) => x.variantId === v.variantId);
      if (i >= 0)
        return cur.map((x, idx) => (idx === i ? { ...x, quantity: x.quantity + 1 } : x));
      return [
        ...cur,
        { key: v.variantId, title: v.productTitle, variantTitle: vt, variantId: v.variantId, quantity: 1 },
      ];
    });
    setQuery('');
    setResults([]);
    setSearchOpen(false);
  };

  const bump = (setter: typeof setSentItems, key: string, delta: number) =>
    setter((cur) =>
      cur
        .map((i) => (i.key === key ? { ...i, quantity: i.quantity + delta } : i))
        .filter((i) => i.quantity > 0),
    );

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
    sentItems.length > 0 &&
    (!isTrax || returnItems.length > 0);

  const pickImage = (f: File | null) => {
    if (imgPreview) URL.revokeObjectURL(imgPreview);
    if (f && /^image\/(png|jpe?g)$/i.test(f.type)) {
      setReturnImage(f);
      setImgPreview(URL.createObjectURL(f));
    } else if (f) {
      toast.error('Use a PNG or JPEG image.');
    } else {
      setReturnImage(null);
      setImgPreview(null);
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
        contents: summarize(sentItems) || 'Replacement item',
        sentQuantity: totalQty(sentItems) || 1,
        codAmount,
        email: email.trim() || undefined,
        returnItemDescription: returnItems.length ? summarize(returnItems) : undefined,
        returnItemQuantity: totalQty(returnItems) || undefined,
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
      toast.error(e instanceof ApiError ? e.userMessage : 'Booking failed — try again.');
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
            delivers the new item and picks up the old one. Items are pulled from
            Shopify; adjust or add below.
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
                      <span className="ml-1 text-[10px] font-medium text-amber-600">· city?</span>
                    )}
                  </button>
                ))}
              </div>
              {cityUnserved && (
                <p className="mt-1.5 text-[11px] text-amber-600">
                  {selected?.label} may not serve “{city}” for replacements — pick
                  another courier or fix the city.
                </p>
              )}
            </Section>

            {/* Legs */}
            <div className="grid sm:grid-cols-2 gap-4">
              {/* Sending */}
              <div className="rounded-xl border border-gray-200 p-3.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-green-700 uppercase tracking-wide mb-2.5">
                  <PackageCheck size={14} /> Sending to customer
                </div>
                {sentItems.map((it) => (
                  <ItemRow
                    key={it.key}
                    item={it}
                    onDelta={(d) => bump(setSentItems, it.key, d)}
                  />
                ))}
                {sentItems.length === 0 && (
                  <p className="text-[11px] text-gray-400 mb-1">Add at least one item.</p>
                )}
                {/* Product search */}
                <div className="relative mt-1">
                  <div className="flex items-center gap-2 border border-dashed border-gray-300 rounded-lg px-2.5 py-1.5">
                    <Search size={13} className="text-gray-400" />
                    <input
                      value={query}
                      onFocus={() => setSearchOpen(true)}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setSearchOpen(true);
                      }}
                      placeholder="Search products to add / swap…"
                      className="flex-1 text-xs outline-none bg-transparent"
                    />
                    {searching && <Loader2 size={12} className="animate-spin text-gray-400" />}
                  </div>
                  {searchOpen && results.length > 0 && (
                    <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                      {results.map((v) => (
                        <button
                          key={v.variantId}
                          type="button"
                          onClick={() => addFromSearch(v)}
                          className="w-full text-left px-2.5 py-1.5 hover:bg-gray-50 flex items-center gap-1.5 text-xs"
                        >
                          <Plus size={12} className="text-green-600 shrink-0" />
                          <span className="truncate flex-1">
                            {v.productTitle}
                            {v.variantTitle && v.variantTitle !== 'Default Title' ? ` — ${v.variantTitle}` : ''}
                          </span>
                          <span className="text-gray-400">{v.price}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Taking back */}
              <div className={`rounded-xl border p-3.5 ${isTrax ? 'border-amber-200 bg-amber-50/40' : 'border-gray-200'}`}>
                <div className="flex items-center gap-1.5 text-xs font-bold text-amber-700 uppercase tracking-wide mb-2.5">
                  <Undo2 size={14} /> Taking back
                  {isTrax && <span className="text-rose-500">*</span>}
                  {!isTrax && (
                    <span className="ml-1 text-[10px] font-medium text-gray-400 normal-case tracking-normal">
                      (Trax only)
                    </span>
                  )}
                </div>
                {returnItems.map((it) => (
                  <ItemRow
                    key={it.key}
                    item={it}
                    onDelta={(d) => bump(setReturnItems, it.key, d)}
                  />
                ))}
                {returnItems.length === 0 && (
                  <p className="text-[11px] text-gray-400 mb-1">Nothing to collect.</p>
                )}
                {/* Photo */}
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
                      <img src={imgPreview} alt="Return item" className="w-10 h-10 rounded-lg object-cover border border-gray-200" />
                      <span className="text-[11px] text-gray-500 truncate flex-1">{returnImage?.name}</span>
                      <button
                        type="button"
                        onClick={() => {
                          pickImage(null);
                          if (fileRef.current) fileRef.current.value = '';
                        }}
                        className="text-gray-400 hover:text-rose-600"
                        aria-label="Remove photo"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="inline-flex items-center gap-1.5 text-[11px] font-medium text-gray-600 border border-dashed border-gray-300 rounded-lg px-3 py-1.5 hover:border-gray-400"
                    >
                      <ImagePlus size={13} /> Add photo of item
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Deliver to */}
            <Section title="Deliver to">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name"><input className={inp} value={name} onChange={(e) => setName(e.target.value)} /></Field>
                <Field label="Phone"><input className={inp} value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
                <Field label="City"><input className={inp} value={city} onChange={(e) => setCity(e.target.value)} /></Field>
                <Field label="Email (optional)"><input className={inp} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              </div>
              <div className="mt-3">
                <Field label="Address"><input className={inp} value={address1} onChange={(e) => setAddress1(e.target.value)} placeholder="Street address" /></Field>
              </div>
              {(address2 || prefill.address2) && (
                <div className="mt-3">
                  <Field label="Address line 2 (optional)"><input className={inp} value={address2} onChange={(e) => setAddress2(e.target.value)} /></Field>
                </div>
              )}
            </Section>

            {/* COD */}
            <Section title="COD amount">
              <div className="flex gap-2">
                <CodOpt on={codMode === 'free'} onClick={() => setCodMode('free')}>Free · 0</CodOpt>
                <CodOpt on={codMode === 'diff'} onClick={() => setCodMode('diff')} disabled={prefill.orderTotal == null}>
                  Order total{prefill.orderTotal != null ? ` · ${cur} ${prefill.orderTotal.toLocaleString()}` : ''}
                </CodOpt>
                <CodOpt on={codMode === 'custom'} onClick={() => setCodMode('custom')}>Custom</CodOpt>
              </div>
              {codMode === 'custom' && (
                <input className={`${inp} mt-2`} type="number" min={0} value={customCod} onChange={(e) => setCustomCod(e.target.value)} placeholder={`Amount in ${cur}`} />
              )}
              <p className="mt-1.5 text-[11px] text-gray-400">Collecting <b>{cur} {codAmount.toLocaleString()}</b> on delivery.</p>
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
              <button onClick={onClose} disabled={busy} className="px-4 py-2.5 text-sm text-gray-600 rounded-lg border border-gray-200 hover:bg-gray-50">
                Cancel
              </button>
            </div>
            <p className="text-[11px] text-gray-400 text-center -mt-2">
              On success: tracking # saved to the ticket + auto-sent to the customer on WhatsApp.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

const inp =
  'block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:ring-1 focus:ring-green-400 outline-none';

function ItemRow({ item, onDelta }: { item: Line; onDelta: (d: number) => void }) {
  return (
    <div className="flex items-center gap-2 bg-white border border-gray-100 rounded-lg px-2 py-1.5 mb-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-gray-800 truncate">{item.title}</div>
        {item.variantTitle && <div className="text-[11px] text-gray-500 truncate">{item.variantTitle}</div>}
      </div>
      <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden shrink-0">
        <button type="button" onClick={() => onDelta(-1)} className="w-6 h-6 bg-gray-50 text-gray-500 font-bold">−</button>
        <span className="w-7 text-center text-xs font-bold tabular-nums">{item.quantity}</span>
        <button type="button" onClick={() => onDelta(1)} className="w-6 h-6 bg-gray-50 text-gray-500 font-bold">+</button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">{title}</div>
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
        on ? 'border-green-600 bg-green-50 text-green-800' : 'border-gray-200 text-gray-600 hover:border-gray-300'
      }`}
    >
      {children}
    </button>
  );
}
