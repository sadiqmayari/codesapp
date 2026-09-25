'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Minus, Package, Percent, Plus, Search, Trash2 } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { getOrderEditable, editOrderItems, type EditableLineItem } from '@/lib/couriers';

/**
 * The ONE item editor — shared by the fulfillment queue's `EditItemsModal` and
 * the order drawer's `EditOrderModal` Items tab, so the two can never drift
 * again. It renders the line list, product search, live subtotal diff and its
 * own Close / Save action row (the host just provides the Modal chrome).
 */

type DiscType = 'percentage' | 'fixed';

interface ProductVariant {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  price: string;
  sku: string | null;
  image: string | null;
  available: boolean;
}

interface WorkingLine {
  variantId: string | null;
  title: string;
  variantTitle: string | null;
  price: string | null;
  image: string | null;
  quantity: number;
  originalQuantity: number; // 0 for newly-added lines
  isNew: boolean;
  discType: DiscType;
  discValue: string; // '' / 0 = no discount
}

export function OrderItemsEditor({
  orderGid,
  currency = 'Rs',
  prepaid = false,
  onClose,
  onSaved,
}: {
  orderGid: string;
  currency?: string;
  /** Order is already paid (outstanding 0) — editing creates a balance/refund. */
  prepaid?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const money = (v: number) => `${currency} ${Math.round(v).toLocaleString()}`;

  const [loading, setLoading] = useState(true);
  const [editable, setEditable] = useState(true);
  const [lines, setLines] = useState<WorkingLine[]>([]);
  const [saving, setSaving] = useState(false);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductVariant[]>([]);
  const [searching, setSearching] = useState(false);
  const [openDisc, setOpenDisc] = useState<Record<number, boolean>>({});
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await getOrderEditable(orderGid);
        setEditable(res.editable);
        setLines(
          res.items.map((i: EditableLineItem) => ({
            variantId: i.variantId,
            title: i.title,
            variantTitle: i.variantTitle,
            price: i.price,
            image: i.image,
            quantity: i.quantity,
            originalQuantity: i.quantity,
            isNew: false,
            discType: 'percentage' as DiscType,
            discValue: '',
          })),
        );
      } catch (e) {
        toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load items');
        setEditable(false);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderGid]);

  // Item-edit search deliberately includes draft/unlisted products (all=1): a
  // human agent is editing an order and may legitimately add a product that
  // isn't published to the online store. The AI auto-order keeps the strict
  // ACTIVE+listed gate (it calls /shopify/products WITHOUT all=1).
  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await apiFetch<ProductVariant[]>('/shopify/products', {
        params: { query: q, all: '1' },
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
    searchTimer.current = setTimeout(() => runSearch(query), 350);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, runSearch]);

  const setQty = (idx: number, qty: number) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, quantity: Math.max(0, qty) } : l)));
  const setLineDisc = (idx: number, patch: Partial<WorkingLine>) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const lineNet = (l: WorkingLine) => {
    const gross = (Number(l.price) || 0) * l.quantity;
    const v = parseFloat(l.discValue) || 0;
    if (!(v > 0)) return gross;
    const d = l.discType === 'percentage' ? (gross * Math.min(v, 100)) / 100 : Math.min(v, gross);
    return Math.max(0, gross - d);
  };
  const hasDisc = (l: WorkingLine) => (parseFloat(l.discValue) || 0) > 0;

  const addVariant = (v: ProductVariant) => {
    setLines((prev) => {
      const existing = prev.findIndex((l) => l.variantId === v.variantId);
      if (existing >= 0)
        return prev.map((l, i) => (i === existing ? { ...l, quantity: l.quantity + 1 } : l));
      return [
        ...prev,
        {
          variantId: v.variantId,
          title: v.productTitle,
          variantTitle: v.variantTitle,
          price: v.price,
          image: v.image,
          quantity: 1,
          originalQuantity: 0,
          isNew: true,
          discType: 'percentage' as DiscType,
          discValue: '',
        },
      ];
    });
    setQuery('');
    setResults([]);
  };

  const origTotal = useMemo(
    () => lines.reduce((s, l) => s + (Number(l.price) || 0) * l.originalQuantity, 0),
    [lines],
  );
  const newTotal = useMemo(() => lines.reduce((s, l) => s + lineNet(l), 0), [lines]);
  const addedN = lines.filter((l) => l.isNew && l.quantity > 0).length;
  const removedN = lines.filter((l) => !l.isNew && l.quantity === 0).length;
  const qtyChg = lines.some((l) => !l.isNew && l.quantity > 0 && l.quantity !== l.originalQuantity);
  const discChg = lines.some(hasDisc);
  const dirty = addedN > 0 || removedN > 0 || qtyChg || discChg;

  const save = async () => {
    const discOf = (l: WorkingLine) =>
      hasDisc(l) ? { type: l.discType, value: parseFloat(l.discValue) } : undefined;
    const updates = lines
      .filter((l) => !l.isNew && (l.quantity !== l.originalQuantity || hasDisc(l)))
      .map((l) => ({ variantId: l.variantId, title: l.title, quantity: l.quantity, discount: discOf(l) }));
    const adds = lines
      .filter((l) => l.isNew && l.quantity > 0 && l.variantId)
      .map((l) => ({ variantId: l.variantId as string, quantity: l.quantity, discount: discOf(l) }));
    if (!updates.length && !adds.length) return;
    setSaving(true);
    try {
      await editOrderItems(orderGid, { updates, adds });
      toast.success('Order items updated in Shopify');
      onSaved();
    } catch (e) {
      // The backend now surfaces per-step Shopify errors (e.g. out-of-stock
      // variant) instead of silently reporting success — show them verbatim.
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to update items');
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className="flex items-center justify-center py-12 text-gray-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );

  if (!editable)
    return (
      <div className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
        This order is already fulfilled — its items can no longer be edited.
      </div>
    );

  return (
    <div className="space-y-3">
      {prepaid && (
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-[11px] text-blue-700">
          This order is already paid — changing its items creates a balance or refund on the Shopify
          order that you&apos;ll need to settle there.
        </p>
      )}

      <div className="space-y-2">
        {lines.length === 0 && <p className="text-sm text-gray-500">No items on this order.</p>}
        {lines.map((l, idx) => (
          <div
            key={`${l.variantId ?? l.title}-${idx}`}
            className={cn(
              'rounded-lg border p-2 transition-colors',
              l.quantity === 0
                ? 'border-gray-200 bg-gray-50 opacity-60'
                : l.quantity !== l.originalQuantity || hasDisc(l)
                  ? 'border-indigo-200 bg-indigo-50/40'
                  : 'border-gray-200',
            )}
          >
            <div className="flex items-center gap-3">
              {l.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={l.image} alt="" className="h-10 w-10 rounded object-cover" />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded bg-gray-100 text-gray-300">
                  <Package size={16} />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-800">
                  {l.title}
                  {l.isNew && (
                    <span className="ml-2 rounded bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-green-700">
                      added
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-gray-400">
                  {[l.variantTitle, l.price ? `${currency} ${l.price}` : null].filter(Boolean).join(' · ')}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <div className="inline-flex items-center overflow-hidden rounded-lg border border-gray-200">
                  <button onClick={() => setQty(idx, l.quantity - 1)} className="p-1.5 text-gray-500 hover:bg-gray-50">
                    <Minus size={14} />
                  </button>
                  <input
                    value={l.quantity}
                    onChange={(e) => setQty(idx, Number(e.target.value.replace(/\D/g, '')) || 0)}
                    className="w-9 border-x border-gray-200 py-1 text-center text-sm"
                  />
                  <button onClick={() => setQty(idx, l.quantity + 1)} className="p-1.5 text-gray-500 hover:bg-gray-50">
                    <Plus size={14} />
                  </button>
                </div>
                <button
                  onClick={() => setOpenDisc((o) => ({ ...o, [idx]: !o[idx] }))}
                  title="Add discount"
                  className={cn('rounded p-1.5', hasDisc(l) ? 'text-green-600' : 'text-gray-400 hover:text-gray-600')}
                >
                  <Percent size={15} />
                </button>
                <button
                  onClick={() => setQty(idx, 0)}
                  title="Remove item"
                  className="rounded p-1.5 text-gray-400 hover:text-rose-600"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
            {(openDisc[idx] || hasDisc(l)) && l.quantity > 0 && (
              <div className="mt-2 flex items-center justify-between gap-2 border-t border-gray-100 pt-2">
                <span className="shrink-0 text-xs text-gray-500">Discount</span>
                <div className="flex items-center gap-1.5">
                  <input
                    value={l.discValue}
                    onChange={(e) => setLineDisc(idx, { discValue: e.target.value.replace(/[^\d.]/g, '') })}
                    placeholder="0"
                    className="w-20 rounded border border-gray-200 px-2 py-1 text-right text-sm"
                  />
                  <div className="inline-flex overflow-hidden rounded border border-gray-200 text-xs">
                    <button
                      type="button"
                      onClick={() => setLineDisc(idx, { discType: 'percentage' })}
                      className={cn('px-2 py-1', l.discType === 'percentage' ? 'bg-green-600 text-white' : 'bg-white text-gray-600')}
                    >
                      %
                    </button>
                    <button
                      type="button"
                      onClick={() => setLineDisc(idx, { discType: 'fixed' })}
                      className={cn('border-l border-gray-200 px-2 py-1', l.discType === 'fixed' ? 'bg-green-600 text-white' : 'bg-white text-gray-600')}
                    >
                      {currency}
                    </button>
                  </div>
                  {hasDisc(l) && <span className="ml-1 text-xs text-green-700">{money(lineNet(l))}</span>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Add a product…"
            className="w-full rounded-lg border border-gray-200 py-2 pl-8 pr-3 text-sm"
          />
          {searching && <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-gray-400" />}
        </div>
        {results.length > 0 && (
          <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-100">
            {results.map((v) => (
              <button
                key={v.variantId}
                onClick={() => addVariant(v)}
                className="flex w-full items-center gap-2 border-b border-gray-50 px-2 py-1.5 text-left last:border-0 hover:bg-gray-50"
              >
                {v.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={v.image} alt="" className="h-8 w-8 rounded object-cover" />
                ) : (
                  <div className="h-8 w-8 rounded bg-gray-100" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                  {v.productTitle}
                  {v.variantTitle && v.variantTitle !== 'Default Title' && (
                    <span className="text-gray-400"> · {v.variantTitle}</span>
                  )}
                </span>
                <span className="text-xs text-gray-500">
                  {currency} {v.price}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg bg-gray-50 px-3 py-2.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500">Items subtotal</span>
          <span className="flex items-center gap-2">
            {dirty && <span className="text-gray-400 line-through">{money(origTotal)}</span>}
            <span className="font-semibold text-gray-900">
              {dirty ? '≈ ' : ''}
              {money(newTotal)}
            </span>
          </span>
        </div>
        {dirty && (
          <p className="mt-1 text-[11px] text-gray-400">
            Estimated from the line items — Shopify sets the final order total (any shipping, tax or
            order-level discount) when you save.
          </p>
        )}
      </div>

      {discChg && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
          Discounts apply on top of the current order — set a line&apos;s discount once; re-editing an
          already-discounted line adds another.
        </p>
      )}

      <div className="flex items-center justify-between border-t border-gray-100 pt-3">
        <div className="min-w-0 text-xs text-gray-400">
          {dirty
            ? [
                addedN && `+${addedN} item${addedN > 1 ? 's' : ''}`,
                removedN && `−${removedN} removed`,
                qtyChg && 'qty changed',
                discChg && 'discount',
              ]
                .filter(Boolean)
                .join(' · ')
            : 'No changes yet'}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
          >
            Close
          </button>
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Save to Shopify
          </button>
        </div>
      </div>
    </div>
  );
}
