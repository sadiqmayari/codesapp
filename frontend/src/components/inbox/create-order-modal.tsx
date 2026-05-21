'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Minus, Plus, Search, Trash2, X } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { COUNTRIES } from '@/lib/countries';

interface ProductVariant {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  price: string;
  sku: string | null;
  image: string | null;
  available: boolean;
}

interface LineItem {
  variantId: string;
  label: string;
  price: string; // unit price, store currency, as returned by Shopify
  quantity: number;
}

interface CreatedOrder {
  orderId: string;
  orderName: string;
  adminUrl: string;
}

/**
 * Agent-driven "Create Shopify order" popup, opened from a chat. Products,
 * variants and prices are fetched live from the merchant's store (needs the
 * Admin token's read_products scope). Quantity is a +/- stepper. Customer
 * name/phone are prefilled from the contact; the assigned agent's name is
 * pre-added as an order tag. Supports COD (payment pending) and prepaid.
 */
export default function CreateOrderModal({
  contactName,
  contactPhone,
  assignedAgentName,
  onClose,
}: {
  contactName?: string | null;
  contactPhone?: string | null;
  assignedAgentName?: string | null;
  onClose: () => void;
}) {
  const toast = useToast();

  // Product search
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductVariant[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Order
  const [items, setItems] = useState<LineItem[]>([]);
  const [customerName, setCustomerName] = useState(contactName ?? '');
  const [phone, setPhone] = useState(contactPhone ?? '');
  const [email, setEmail] = useState('');
  const [address1, setAddress1] = useState('');
  const [city, setCity] = useState('');
  const [countryCode, setCountryCode] = useState('PK');
  const [note, setNote] = useState('');
  const [prepaid, setPrepaid] = useState(false);
  const [tags, setTags] = useState<string[]>(
    assignedAgentName ? [assignedAgentName] : [],
  );
  const [tagInput, setTagInput] = useState('');

  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedOrder | null>(null);

  const runSearch = useCallback(
    async (q: string) => {
      setSearching(true);
      setSearchError(null);
      try {
        const res = await apiFetch<ProductVariant[]>('/shopify/products', {
          params: { query: q },
        });
        setResults(Array.isArray(res) ? res : []);
      } catch (e) {
        setResults([]);
        setSearchError(
          e instanceof ApiError ? e.userMessage : 'Product search failed',
        );
      } finally {
        setSearching(false);
      }
    },
    [],
  );

  // Debounced search (also loads the first products on open with empty query).
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => runSearch(query.trim()), 350);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, runSearch]);

  const addVariant = (v: ProductVariant) => {
    setItems((cur) => {
      const i = cur.findIndex((it) => it.variantId === v.variantId);
      if (i !== -1) {
        return cur.map((it, idx) =>
          idx === i ? { ...it, quantity: it.quantity + 1 } : it,
        );
      }
      const label = [v.productTitle, v.variantTitle].filter(Boolean).join(' · ');
      return [
        ...cur,
        { variantId: v.variantId, label, price: v.price, quantity: 1 },
      ];
    });
  };

  const setQty = (variantId: string, delta: number) =>
    setItems((cur) =>
      cur
        .map((it) =>
          it.variantId === variantId
            ? { ...it, quantity: it.quantity + delta }
            : it,
        )
        .filter((it) => it.quantity > 0),
    );

  const removeItem = (variantId: string) =>
    setItems((cur) => cur.filter((it) => it.variantId !== variantId));

  const addTag = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    setTags((cur) => (cur.includes(t) ? cur : [...cur, t]));
    setTagInput('');
  };
  const removeTag = (t: string) =>
    setTags((cur) => cur.filter((x) => x !== t));

  const subtotal = items.reduce(
    (s, it) => s + (parseFloat(it.price) || 0) * it.quantity,
    0,
  );
  const canSubmit = items.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = await apiFetch<CreatedOrder>('/shopify/orders', {
        method: 'POST',
        body: {
          lineItems: items.map((it) => ({
            variantId: it.variantId,
            quantity: it.quantity,
          })),
          customerName: customerName.trim() || undefined,
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          address1: address1.trim() || undefined,
          city: city.trim() || undefined,
          countryCode: countryCode || undefined,
          note: note.trim() || undefined,
          tags: tags.length ? tags : undefined,
          prepaid,
        },
      });
      setCreated(res);
      toast.success(`Order ${res.orderName} created in Shopify`);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to create order',
      );
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Modal open onClose={onClose} title="Order created">
        <div className="space-y-3 text-sm">
          <p className="text-gray-700">
            Shopify order{' '}
            <span className="font-semibold">{created.orderName}</span> was
            created ({prepaid ? 'prepaid — marked paid' : 'payment pending'}).
          </p>
          <a
            href={created.adminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-green-700 underline"
          >
            Open in Shopify admin
          </a>
          <div className="pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700"
            >
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Create Shopify order"
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create order'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Product search */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Add products from your store
          </label>
          <div className="relative">
            <Search
              size={16}
              className="absolute left-3 top-2.5 text-gray-400"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search products…"
              className="w-full pl-9 pr-9 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            {searching && (
              <Loader2
                size={16}
                className="absolute right-3 top-2.5 text-gray-400 animate-spin"
              />
            )}
          </div>

          {searchError ? (
            <p className="mt-1 text-xs text-red-500">{searchError}</p>
          ) : (
            <div className="mt-1 border border-gray-200 rounded-lg max-h-44 overflow-y-auto divide-y divide-gray-100">
              {results.length === 0 && !searching ? (
                <p className="px-3 py-3 text-xs text-gray-400">
                  No products found.
                </p>
              ) : (
                results.map((v) => (
                  <button
                    key={v.variantId}
                    type="button"
                    onClick={() => addVariant(v)}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-3"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {v.image ? (
                      <img
                        src={v.image}
                        alt=""
                        className="w-9 h-9 rounded object-cover bg-gray-50 border border-gray-200 shrink-0"
                      />
                    ) : (
                      <span className="w-9 h-9 rounded bg-gray-100 shrink-0" />
                    )}
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-gray-900 truncate">
                        {[v.productTitle, v.variantTitle]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {v.sku && (
                        <span className="block text-[11px] text-gray-400 truncate">
                          SKU {v.sku}
                        </span>
                      )}
                    </span>
                    <span className="text-sm text-gray-700 shrink-0">
                      {v.price}
                    </span>
                    <Plus size={16} className="text-green-600 shrink-0" />
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Selected line items */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Order items
          </label>
          {items.length === 0 ? (
            <p className="text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg px-3 py-3">
              No items yet — search above and tap a product to add it.
            </p>
          ) : (
            <div className="space-y-2">
              {items.map((it) => (
                <div
                  key={it.variantId}
                  className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-gray-900 truncate">
                      {it.label}
                    </span>
                    <span className="block text-[11px] text-gray-400">
                      {it.price} each
                    </span>
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => setQty(it.variantId, -1)}
                      className="w-7 h-7 rounded border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50"
                      aria-label="Decrease quantity"
                    >
                      <Minus size={14} />
                    </button>
                    <span className="w-8 text-center text-sm font-medium">
                      {it.quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() => setQty(it.variantId, 1)}
                      className="w-7 h-7 rounded border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50"
                      aria-label="Increase quantity"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeItem(it.variantId)}
                    className="p-1.5 text-gray-400 hover:text-red-600 shrink-0"
                    aria-label="Remove item"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              <p className="text-right text-sm text-gray-600">
                Subtotal:{' '}
                <span className="font-semibold">{subtotal.toFixed(2)}</span>
              </p>
            </div>
          )}
        </div>

        {/* Payment type */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Payment
          </label>
          <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm">
            <button
              type="button"
              onClick={() => setPrepaid(false)}
              className={cn(
                'px-4 py-1.5',
                !prepaid
                  ? 'bg-green-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50',
              )}
            >
              COD
            </button>
            <button
              type="button"
              onClick={() => setPrepaid(true)}
              className={cn(
                'px-4 py-1.5 border-l border-gray-300',
                prepaid
                  ? 'bg-green-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50',
              )}
            >
              Prepaid (mark paid)
            </button>
          </div>
        </div>

        {/* Customer + shipping */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Customer name" value={customerName} onChange={setCustomerName} />
          <Field label="Phone" value={phone} onChange={setPhone} />
          <Field label="Email" value={email} onChange={setEmail} type="email" />
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Country
            </label>
            <select
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <Field label="City" value={city} onChange={setCity} />
          <div className="sm:col-span-2">
            <Field label="Address" value={address1} onChange={setAddress1} />
          </div>
        </div>

        {/* Tags */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Tags
          </label>
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 bg-gray-100 text-gray-700 text-xs rounded-full px-2 py-0.5"
              >
                {t}
                <button
                  type="button"
                  onClick={() => removeTag(t)}
                  className="text-gray-400 hover:text-red-500"
                  aria-label={`Remove tag ${t}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag(tagInput);
              }
            }}
            onBlur={() => addTag(tagInput)}
            placeholder="Add a tag and press Enter"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>

        {/* Note */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Note (optional)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Internal note on the order"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>
        <p className="text-[11px] text-gray-400">
          Creates a {prepaid ? 'prepaid (marked paid)' : 'payment-pending (COD)'}{' '}
          order in your connected Shopify store.
        </p>
      </div>
    </Modal>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
      />
    </div>
  );
}
