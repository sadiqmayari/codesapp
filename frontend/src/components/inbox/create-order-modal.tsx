'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Clock,
  Loader2,
  Minus,
  Percent,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Truck,
  X,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { aiDraftOrder } from '@/lib/ai';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { COUNTRIES } from '@/lib/countries';
import type { AbandonedCartItem } from '@/lib/orders';
import { normalizePhone } from '@/lib/phone';
import { DraggableShell } from './draggable-shell';

interface ProductVariant {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  price: string;
  sku: string | null;
  image: string | null;
  available: boolean;
}

type DiscountType = 'percentage' | 'fixed';

interface LineItem {
  variantId: string;
  label: string;
  price: string; // unit price, store currency, as returned by Shopify
  quantity: number;
  discType: DiscountType;
  discValue: string; // empty / 0 = no discount
}

interface ShippingRate {
  handle: string;
  title: string;
  amount: string;
  currencyCode: string;
}

const sameRate = (a: ShippingRate | null, b: ShippingRate) =>
  !!a && a.handle === b.handle && a.title === b.title && a.amount === b.amount;

interface CreatedOrder {
  orderId: string;
  orderName: string;
  adminUrl: string;
}

/**
 * Agent-driven "Create Shopify order" popup, opened from a chat. Floats over
 * the inbox in a DRAGGABLE, backdrop-less window so the agent can still select
 * and copy text (address, etc.) from the chat behind it. It only closes via
 * its own close/cancel button (no close-on-outside-click).
 *
 * Customer lookup is temporarily deferred (the search API is being reworked);
 * the order still auto-creates/links a Shopify customer server-side from the
 * name/phone/email/address entered here.
 */
export default function CreateOrderModal({
  contactName,
  contactPhone,
  contactEmail,
  assignedAgentName,
  conversationId,
  aiEnabled,
  extraTags,
  orderSource,
  prefillItems,
  onCreated,
  onClose,
}: {
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  assignedAgentName?: string | null;
  /** Enables the "Draft from chat" AI button (reads this conversation). */
  conversationId?: number;
  aiEnabled?: boolean;
  /** Extra tags seeded onto the order (e.g. ['Abandoned Checkout']). */
  extraTags?: string[];
  /** Where the order originated, for separated analytics. */
  orderSource?: 'abandoned_cart' | 'inbox';
  /** Cart lines to open the order with (abandoned-cart recovery). */
  prefillItems?: AbandonedCartItem[];
  /** Called after the order is created (before the user closes the modal). */
  onCreated?: (order: CreatedOrder) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [drafting, setDrafting] = useState(false);

  // Product search
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductVariant[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Order. Seeded from `prefillItems` (abandoned-cart recovery opens with the
  // shopper's exact cart already in the order). Only lines Shopify gave us a
  // variant for are pre-fillable; custom/deleted products are skipped.
  const [items, setItems] = useState<LineItem[]>(() =>
    (prefillItems ?? [])
      .filter((it) => !!it.variantId)
      .map((it) => ({
        variantId: it.variantId as string,
        label: it.variantTitle ? `${it.title} — ${it.variantTitle}` : it.title,
        price: it.price ?? '0',
        quantity: it.quantity || 1,
        discType: 'percentage' as DiscountType,
        discValue: '',
      })),
  );
  // Which line items have their discount editor expanded (collapsed by default).
  const [openDisc, setOpenDisc] = useState<Record<string, boolean>>({});
  const [customerName, setCustomerName] = useState(contactName ?? '');
  const [phone, setPhone] = useState(contactPhone ?? '');
  const [email, setEmail] = useState(contactEmail ?? '');
  const [address1, setAddress1] = useState('');
  const [city, setCity] = useState('');
  const [countryCode, setCountryCode] = useState('PK');
  const [note, setNote] = useState('');
  const [prepaid, setPrepaid] = useState(false);
  const [tags, setTags] = useState<string[]>(() => {
    const base = assignedAgentName
      ? [assignedAgentName, 'CodesApp']
      : ['CodesApp'];
    // Prepend any caller-supplied tags (e.g. 'Abandoned Checkout'), de-duped.
    const seed = [...(extraTags ?? []), ...base];
    return Array.from(new Set(seed.map((t) => t.trim()).filter(Boolean)));
  });
  const [tagInput, setTagInput] = useState('');
  // Order-level manual discount.
  const [orderDiscType, setOrderDiscType] = useState<DiscountType>('percentage');
  const [orderDiscValue, setOrderDiscValue] = useState('');

  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedOrder | null>(null);

  // Shipping — rates calculated live from the store's shipping zones.
  const [shippingRates, setShippingRates] = useState<ShippingRate[]>([]);
  const [loadingRates, setLoadingRates] = useState(false);
  const [ratesError, setRatesError] = useState<string | null>(null);
  const [selectedRate, setSelectedRate] = useState<ShippingRate | null>(null);
  const ratesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (q: string) => {
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
  }, []);

  // Debounced search (also loads the first products on open with empty query).
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => runSearch(query.trim()), 350);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, runSearch]);

  // Recalculate Shopify shipping rates whenever the cart or destination
  // changes (debounced). Auto-selects the first rate so an order always has a
  // shipping line when the store offers one.
  useEffect(() => {
    if (ratesTimer.current) clearTimeout(ratesTimer.current);
    if (items.length === 0 || !countryCode) {
      setShippingRates([]);
      setSelectedRate(null);
      setRatesError(null);
      setLoadingRates(false);
      return;
    }
    setLoadingRates(true);
    setRatesError(null);
    const snapshot = items.map((it) => ({
      variantId: it.variantId,
      quantity: it.quantity,
    }));
    ratesTimer.current = setTimeout(async () => {
      try {
        const rates = await apiFetch<ShippingRate[]>('/shopify/shipping-rates', {
          method: 'POST',
          body: {
            lineItems: snapshot,
            address1: address1.trim() || undefined,
            city: city.trim() || undefined,
            countryCode: countryCode || undefined,
          },
        });
        const list = Array.isArray(rates) ? rates : [];
        setShippingRates(list);
        setSelectedRate((cur) =>
          cur && list.some((r) => sameRate(cur, r)) ? cur : list[0] ?? null,
        );
      } catch (e) {
        setShippingRates([]);
        setSelectedRate(null);
        setRatesError(
          e instanceof ApiError ? e.userMessage : 'Could not load shipping rates',
        );
      } finally {
        setLoadingRates(false);
      }
    }, 600);
    return () => {
      if (ratesTimer.current) clearTimeout(ratesTimer.current);
    };
  }, [items, address1, city, countryCode]);

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
        {
          variantId: v.variantId,
          label,
          price: v.price,
          quantity: 1,
          discType: 'percentage' as DiscountType,
          discValue: '',
        },
      ];
    });
  };

  const setItemDisc = (variantId: string, patch: Partial<LineItem>) =>
    setItems((cur) =>
      cur.map((it) => (it.variantId === variantId ? { ...it, ...patch } : it)),
    );

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

  // AI: read the conversation and pre-fill this form. The AI never creates the
  // order — it only fills the fields; the agent reviews and clicks Create.
  // Product names come back as free-text queries which we resolve to real
  // variants through the existing product search.
  const draftFromChat = async () => {
    if (drafting || !conversationId) return;
    setDrafting(true);
    try {
      const draft = await aiDraftOrder(conversationId);

      // Resolve each product query to its top variant (live price from store).
      const resolved: LineItem[] = [];
      const unmatched: string[] = [];
      for (const want of draft.items) {
        try {
          const hits = await apiFetch<ProductVariant[]>('/shopify/products', {
            params: { query: want.productQuery },
          });
          const v = Array.isArray(hits) ? hits[0] : undefined;
          if (!v) {
            unmatched.push(want.productQuery);
            continue;
          }
          const label = [v.productTitle, v.variantTitle]
            .filter(Boolean)
            .join(' · ');
          const existing = resolved.find((r) => r.variantId === v.variantId);
          if (existing) existing.quantity += want.quantity;
          else
            resolved.push({
              variantId: v.variantId,
              label,
              price: v.price,
              quantity: want.quantity,
              discType: 'percentage',
              discValue: '',
            });
        } catch {
          unmatched.push(want.productQuery);
        }
      }
      if (resolved.length) setItems(resolved);

      // Resolve the destination country first (drives phone normalization).
      const draftCountry =
        draft.customer.countryCode &&
        COUNTRIES.some((c) => c.code === draft.customer.countryCode)
          ? draft.customer.countryCode
          : countryCode;
      if (draftCountry !== countryCode) setCountryCode(draftCountry);

      // Name + phone come from what the customer states in THIS chat for the
      // order — that's the real recipient, which is usually more accurate than
      // the auto-filled WhatsApp profile name/number — so they take precedence.
      // The phone is normalized to +E.164 (local "0317…" → "+92317…").
      if (draft.customer.name) setCustomerName(draft.customer.name);
      if (draft.customer.phone)
        setPhone(normalizePhone(draft.customer.phone, draftCountry));

      // Email stated in the chat takes precedence over a blank field (but don't
      // clobber an email already prefilled from the contact / typed by the agent).
      if (draft.customer.email && !email.trim()) setEmail(draft.customer.email);

      // Address fields start empty — fill when the draft has them.
      if (draft.customer.address1 && !address1.trim())
        setAddress1(draft.customer.address1);
      if (draft.customer.city && !city.trim()) setCity(draft.customer.city);
      if (draft.paymentMethod) setPrepaid(draft.paymentMethod === 'prepaid');
      if (draft.note && !note.trim()) setNote(draft.note);

      // Tell the agent what to double-check.
      const bits: string[] = [];
      bits.push(
        resolved.length
          ? `${resolved.length} product${resolved.length > 1 ? 's' : ''} added`
          : 'no products matched',
      );
      if (unmatched.length)
        bits.push(`couldn't match: ${unmatched.join(', ')}`);
      if (draft.confidence === 'low' || draft.missing.length)
        bits.push('please review before creating');
      if (resolved.length) toast.success(`Draft ready — ${bits.join(' · ')}`);
      else toast.info(`Draft from chat — ${bits.join(' · ')}`);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Could not draft from chat',
      );
    } finally {
      setDrafting(false);
    }
  };

  const addTag = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    setTags((cur) => (cur.includes(t) ? cur : [...cur, t]));
    setTagInput('');
  };
  const removeTag = (t: string) => setTags((cur) => cur.filter((x) => x !== t));

  // Per-line + order-level discount maths (mirrors what Shopify applies, so the
  // totals the agent sees match the created order).
  const lineAmounts = (it: LineItem) => {
    const gross = (parseFloat(it.price) || 0) * it.quantity;
    const v = parseFloat(it.discValue) || 0;
    const disc =
      v > 0
        ? it.discType === 'percentage'
          ? (gross * Math.min(v, 100)) / 100
          : Math.min(v, gross)
        : 0;
    return { gross, disc, net: gross - disc };
  };

  const subtotal = items.reduce((s, it) => s + lineAmounts(it).gross, 0);
  const itemDiscTotal = items.reduce((s, it) => s + lineAmounts(it).disc, 0);
  const afterItemDisc = subtotal - itemDiscTotal;
  const orderDiscNum = parseFloat(orderDiscValue) || 0;
  const orderDiscAmt =
    orderDiscNum > 0
      ? orderDiscType === 'percentage'
        ? (afterItemDisc * Math.min(orderDiscNum, 100)) / 100
        : Math.min(orderDiscNum, afterItemDisc)
      : 0;
  const shippingAmt = selectedRate ? parseFloat(selectedRate.amount) || 0 : 0;
  const total = Math.max(0, afterItemDisc - orderDiscAmt + shippingAmt);
  const currency = selectedRate?.currencyCode ?? '';
  const money = (n: number) =>
    `${n.toFixed(2)}${currency ? ` ${currency}` : ''}`;

  const addressOk = address1.trim().length > 0 && city.trim().length > 0;
  const canSubmit = items.length > 0 && addressOk && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = await apiFetch<CreatedOrder>('/shopify/orders', {
        method: 'POST',
        body: {
          lineItems: items.map((it) => {
            const dv = parseFloat(it.discValue);
            return {
              variantId: it.variantId,
              quantity: it.quantity,
              discount:
                Number.isFinite(dv) && dv > 0
                  ? { type: it.discType, value: dv }
                  : undefined,
            };
          }),
          customerName: customerName.trim() || undefined,
          // Normalize to +E.164 (handles locally-typed numbers like "0317…").
          phone: phone.trim()
            ? normalizePhone(phone, countryCode)
            : undefined,
          email: email.trim() || undefined,
          address1: address1.trim() || undefined,
          city: city.trim() || undefined,
          countryCode: countryCode || undefined,
          note: note.trim() || undefined,
          tags: tags.length ? tags : undefined,
          prepaid,
          shippingLine: selectedRate
            ? { title: selectedRate.title, price: shippingAmt }
            : undefined,
          orderDiscount:
            parseFloat(orderDiscValue) > 0
              ? { type: orderDiscType, value: parseFloat(orderDiscValue) }
              : undefined,
          source: orderSource,
        },
      });
      setCreated(res);
      onCreated?.(res);
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
      <DraggableShell title="Order created" onClose={onClose}>
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
      </DraggableShell>
    );
  }

  return (
    <DraggableShell
      title="Create Shopify order"
      onClose={onClose}
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
        {/* AI: draft the whole order from the conversation */}
        {aiEnabled && conversationId != null && (
          <button
            type="button"
            onClick={draftFromChat}
            disabled={drafting || busy}
            className="w-full flex items-center justify-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
          >
            {drafting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Sparkles size={16} />
            )}
            {drafting ? 'Reading the chat…' : 'Draft order from chat'}
          </button>
        )}

        {/* Product search */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Add products from your store
          </label>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search products…"
              type="search"
              name="shopify-product-search"
              autoComplete="off"
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
                  className="border border-gray-200 rounded-lg px-3 py-2"
                >
                  <div className="flex items-center gap-2">
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
                      onClick={() =>
                        setOpenDisc((o) => ({
                          ...o,
                          [it.variantId]: !o[it.variantId],
                        }))
                      }
                      title="Add discount"
                      aria-label="Add discount"
                      className={cn(
                        'p-1.5 shrink-0 rounded hover:bg-gray-50',
                        parseFloat(it.discValue) > 0
                          ? 'text-green-600'
                          : 'text-gray-400 hover:text-gray-600',
                      )}
                    >
                      <Percent size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeItem(it.variantId)}
                      className="p-1.5 text-gray-400 hover:text-red-600 shrink-0"
                      aria-label="Remove item"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  {/* Per-line discount — only when toggled open via the % icon */}
                  {openDisc[it.variantId] && (
                    <div className="mt-2 pt-2 border-t border-gray-100 flex items-center justify-between gap-2">
                      <span className="text-xs text-gray-500 shrink-0">
                        Discount
                      </span>
                      <DiscountInput
                        value={it.discValue}
                        onValue={(v) =>
                          setItemDisc(it.variantId, { discValue: v })
                        }
                        type={it.discType}
                        onType={(t) => setItemDisc(it.variantId, { discType: t })}
                      />
                    </div>
                  )}
                  {(() => {
                    const a = lineAmounts(it);
                    return a.disc > 0 ? (
                      <div className="mt-1 text-right text-[11px]">
                        <span className="text-gray-400 line-through mr-1.5">
                          {money(a.gross)}
                        </span>
                        <span className="text-green-700 font-medium">
                          {money(a.net)}
                        </span>
                      </div>
                    ) : null;
                  })()}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Shipping */}
        <div>
          <label className="text-xs font-medium text-gray-600 mb-1.5 flex items-center gap-1.5">
            <Truck size={14} className="text-gray-400" />
            Shipping
            {loadingRates && (
              <Loader2 size={13} className="animate-spin text-gray-400" />
            )}
          </label>
          {items.length === 0 ? (
            <p className="text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg px-3 py-2.5">
              Add items to see shipping rates.
            </p>
          ) : ratesError ? (
            <p className="text-xs text-red-500">{ratesError}</p>
          ) : shippingRates.length === 0 && !loadingRates ? (
            <p className="text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg px-3 py-2.5">
              No shipping rates for this destination — the order will have no
              shipping line.
            </p>
          ) : (
            <div className="space-y-1.5">
              {shippingRates.map((r) => {
                const active = sameRate(selectedRate, r);
                return (
                  <button
                    key={`${r.handle}-${r.title}-${r.amount}`}
                    type="button"
                    onClick={() => setSelectedRate(r)}
                    className={cn(
                      'w-full flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors text-left',
                      active
                        ? 'border-green-500 bg-green-50 ring-1 ring-green-500'
                        : 'border-gray-200 hover:bg-gray-50',
                    )}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <span
                        className={cn(
                          'w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center',
                          active ? 'border-green-600' : 'border-gray-300',
                        )}
                      >
                        {active && (
                          <span className="w-2 h-2 rounded-full bg-green-600" />
                        )}
                      </span>
                      <span className="text-gray-800 truncate">{r.title}</span>
                    </span>
                    <span className="font-medium text-gray-800 shrink-0">
                      {r.amount} {r.currencyCode}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Order summary — subtotal, discounts, shipping, total (below the
            shipping selector so shipping sits above the totals). */}
        {items.length > 0 && (
          <div className="rounded-xl bg-gray-50 border border-gray-200 px-3 py-3 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500">Subtotal</span>
              <span className="font-medium text-gray-800">{money(subtotal)}</span>
            </div>
            {itemDiscTotal > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">Item discounts</span>
                <span className="font-medium text-green-700">
                  −{money(itemDiscTotal)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-gray-500 shrink-0">
                Order discount
              </span>
              <DiscountInput
                value={orderDiscValue}
                onValue={setOrderDiscValue}
                type={orderDiscType}
                onType={setOrderDiscType}
              />
            </div>
            {orderDiscAmt > 0 && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400">Order discount applied</span>
                <span className="font-medium text-green-700">
                  −{money(orderDiscAmt)}
                </span>
              </div>
            )}
            {selectedRate && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">Shipping</span>
                <span className="font-medium text-gray-800">
                  {money(shippingAmt)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between pt-2 mt-1 border-t border-gray-200">
              <span className="text-base font-semibold text-gray-900">Total</span>
              <span className="text-base font-semibold text-gray-900">
                {money(total)}
              </span>
            </div>
          </div>
        )}

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

        {/* Customer details (used to auto-create the Shopify customer) */}
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field
              label="Customer name"
              value={customerName}
              onChange={setCustomerName}
              autoComplete="name"
            />
            <Field
              label="Phone"
              value={phone}
              onChange={setPhone}
              type="tel"
              autoComplete="tel"
            />
          </div>
          <Field
            label="Email"
            value={email}
            onChange={setEmail}
            type="email"
            autoComplete="email"
          />
          <Field
            label="Address"
            value={address1}
            onChange={setAddress1}
            required
            autoComplete="address-line1"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field
              label="City"
              value={city}
              onChange={setCity}
              required
              autoComplete="address-level2"
            />
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Country
              </label>
              <select
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Customer lookup deferred — small notice */}
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
            <Clock size={15} className="text-amber-500 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-700 leading-relaxed">
              <span className="font-medium">Customer lookup is under development.</span>{' '}
              For now the order automatically creates (or reuses) a Shopify
              customer from the details above.
            </p>
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
        {items.length > 0 && !addressOk && (
          <p className="text-[11px] text-red-500">
            Address and City are required to create the order.
          </p>
        )}
        <p className="text-[11px] text-gray-400">
          Creates a {prepaid ? 'prepaid (marked paid)' : 'payment-pending (COD)'}{' '}
          order in your connected Shopify store.
        </p>
      </div>
    </DraggableShell>
  );
}

/** A discount value input paired with a %/flat segmented toggle. */
function DiscountInput({
  value,
  onValue,
  type,
  onType,
}: {
  value: string;
  onValue: (v: string) => void;
  type: DiscountType;
  onType: (t: DiscountType) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        value={value}
        onChange={(e) => onValue(e.target.value.replace(/[^0-9.]/g, ''))}
        inputMode="decimal"
        placeholder="0"
        className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-green-500"
      />
      <div className="inline-flex rounded-lg bg-gray-100 p-0.5 text-xs font-medium">
        <button
          type="button"
          onClick={() => onType('percentage')}
          className={cn(
            'px-2.5 py-1 rounded-md transition-colors',
            type === 'percentage'
              ? 'bg-white text-green-700 shadow-sm'
              : 'text-gray-500 hover:text-gray-700',
          )}
          aria-pressed={type === 'percentage'}
        >
          %
        </button>
        <button
          type="button"
          onClick={() => onType('fixed')}
          className={cn(
            'px-2.5 py-1 rounded-md transition-colors',
            type === 'fixed'
              ? 'bg-white text-green-700 shadow-sm'
              : 'text-gray-500 hover:text-gray-700',
          )}
          aria-pressed={type === 'fixed'}
        >
          flat
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  required = false,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  const empty = required && value.trim().length === 0;
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className={cn(
          'w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500',
          empty ? 'border-red-300' : 'border-gray-300',
        )}
      />
    </div>
  );
}
