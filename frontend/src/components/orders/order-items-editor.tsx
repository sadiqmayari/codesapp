'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Loader2,
  Minus,
  Package,
  Percent,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import {
  getOrderEditable,
  editOrderItems,
  previewOrderEdit,
  type EditableLineItem,
  type OrderEditChanges,
} from '@/lib/couriers';

/**
 * The ONE item editor — shared by the fulfillment queue's `EditItemsModal` and
 * the order drawer's `EditOrderModal` Items tab, so the two can never drift.
 *
 * Model (deliberate, matches what Shopify's order-edit API can actually do):
 *  • Existing order lines → change quantity or remove only.
 *  • Newly-ADDED products → quantity + an optional one-time discount.
 *    (Shopify can only STACK, never set/remove, a discount on an existing line,
 *     so we don't offer discounts there — that was the "sometimes wrong" bug.)
 *  • The total shown is Shopify's AUTHORITATIVE calculated total (live preview),
 *    not a client-side guess.
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
  discValue: string; // '' / 0 = no discount (added lines only)
}

interface LivePreview {
  subtotal: number | null;
  total: number | null;
  outstanding: number | null;
  currency: string;
  warnings: string[];
}

function buildChanges(lines: WorkingLine[]): OrderEditChanges {
  const updates = lines
    .filter((l) => !l.isNew && l.quantity !== l.originalQuantity)
    .map((l) => ({ variantId: l.variantId, title: l.title, quantity: l.quantity }));
  const adds = lines
    .filter((l) => l.isNew && l.quantity > 0 && l.variantId)
    .map((l) => {
      const v = parseFloat(l.discValue) || 0;
      return {
        variantId: l.variantId as string,
        quantity: l.quantity,
        discount: v > 0 ? { type: l.discType, value: v } : undefined,
      };
    });
  return { updates, adds };
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

  const [loading, setLoading] = useState(true);
  const [editable, setEditable] = useState(true);
  const [lines, setLines] = useState<WorkingLine[]>([]);
  const [saving, setSaving] = useState(false);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductVariant[]>([]);
  const [searching, setSearching] = useState(false);
  const [openDisc, setOpenDisc] = useState<Record<number, boolean>>({});
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [preview, setPreview] = useState<LivePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Item-edit search deliberately includes draft/unlisted products (all=1) — a
  // human agent may legitimately add an unpublished product. The AI auto-order
  // keeps the strict ACTIVE+listed gate (it never passes all=1).
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

  const hasDisc = (l: WorkingLine) => l.isNew && (parseFloat(l.discValue) || 0) > 0;
  const lineNet = (l: WorkingLine) => {
    const gross = (Number(l.price) || 0) * l.quantity;
    if (!hasDisc(l)) return gross;
    const v = parseFloat(l.discValue) || 0;
    const d = l.discType === 'percentage' ? (gross * Math.min(v, 100)) / 100 : Math.min(v, gross);
    return Math.max(0, gross - d);
  };

  const addVariant = (v: ProductVariant) => {
    setLines((prev) => {
      // Bump an existing NEW line for the same variant; never merge into an
      // original order line (those are edited via their own qty control).
      const existing = prev.findIndex((l) => l.isNew && l.variantId === v.variantId);
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

  const addedN = lines.filter((l) => l.isNew && l.quantity > 0).length;
  const removedN = lines.filter((l) => !l.isNew && l.quantity === 0).length;
  const qtyChg = lines.some((l) => !l.isNew && l.quantity > 0 && l.quantity !== l.originalQuantity);
  const dirty = addedN > 0 || removedN > 0 || qtyChg;

  // Local estimate (fallback + pre-preview): sum of net line values.
  const localTotal = useMemo(() => lines.reduce((s, l) => s + lineNet(l), 0), [lines]);
  const curTotal = useMemo(
    () => lines.reduce((s, l) => s + (Number(l.price) || 0) * l.originalQuantity, 0),
    [lines],
  );

  // Live authoritative total: stage the edit against Shopify (no commit),
  // debounced. Only while dirty + editable.
  const changesKey = useMemo(() => JSON.stringify(buildChanges(lines)), [lines]);
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (!dirty || !editable) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    previewTimer.current = setTimeout(async () => {
      setPreviewing(true);
      try {
        const p = await previewOrderEdit(orderGid, JSON.parse(changesKey) as OrderEditChanges);
        setPreview(p);
      } catch {
        setPreview(null); // fall back to the local estimate on any error
      } finally {
        setPreviewing(false);
      }
    }, 550);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changesKey, dirty, editable, orderGid]);

  const warnings = preview?.warnings ?? [];
  const cur = preview?.currency || currency;
  const money = (v: number | null | undefined) =>
    v == null ? '—' : `${cur} ${Math.round(v).toLocaleString()}`;

  const authoritativeTotal = dirty && preview?.total != null;
  const displayTotal = authoritativeTotal ? preview!.total! : dirty ? localTotal : curTotal;

  const save = async () => {
    const changes = buildChanges(lines);
    if (!changes.updates?.length && !changes.adds?.length) return;
    setSaving(true);
    try {
      await editOrderItems(orderGid, changes);
      toast.success('Order items updated in Shopify');
      onSaved();
    } catch (e) {
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

      {/* Existing + added lines */}
      <div className="space-y-2">
        {lines.length === 0 && <p className="text-sm text-gray-500">No items on this order.</p>}
        {lines.map((l, idx) => {
          const removed = !l.isNew && l.quantity === 0;
          const changed = !l.isNew && l.quantity !== l.originalQuantity;
          return (
            <div
              key={`${l.isNew ? 'new' : 'orig'}-${l.variantId ?? l.title}-${idx}`}
              className={cn(
                'rounded-xl border p-2.5 transition-colors',
                removed
                  ? 'border-gray-200 bg-gray-50 opacity-70'
                  : l.isNew
                    ? 'border-green-200 bg-green-50/40'
                    : changed
                      ? 'border-indigo-200 bg-indigo-50/40'
                      : 'border-gray-200',
              )}
            >
              <div className="flex items-center gap-3">
                {l.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={l.image} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-300">
                    <Package size={18} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-800">
                    {l.title}
                    {l.isNew && (
                      <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-green-700">
                        added
                      </span>
                    )}
                    {removed && (
                      <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-gray-500">
                        removed
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-gray-400">
                    {[l.variantTitle, l.price ? `${cur} ${l.price}` : null].filter(Boolean).join(' · ')}
                  </p>
                </div>

                {removed ? (
                  <button
                    onClick={() => setQty(idx, l.originalQuantity)}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  >
                    <RotateCcw size={13} /> Undo
                  </button>
                ) : (
                  <div className="flex items-center gap-1">
                    <div className="inline-flex items-center overflow-hidden rounded-lg border border-gray-200">
                      <button
                        onClick={() => setQty(idx, l.quantity - 1)}
                        className="p-2 text-gray-500 hover:bg-gray-50"
                        aria-label="Decrease quantity"
                      >
                        <Minus size={14} />
                      </button>
                      <input
                        value={l.quantity}
                        onChange={(e) => setQty(idx, Number(e.target.value.replace(/\D/g, '')) || 0)}
                        inputMode="numeric"
                        className="w-9 border-x border-gray-200 py-1.5 text-center text-sm"
                      />
                      <button
                        onClick={() => setQty(idx, l.quantity + 1)}
                        className="p-2 text-gray-500 hover:bg-gray-50"
                        aria-label="Increase quantity"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    {/* Discount is offered ONLY on newly-added items. */}
                    {l.isNew && (
                      <button
                        onClick={() => setOpenDisc((o) => ({ ...o, [idx]: !o[idx] }))}
                        title="Add discount"
                        className={cn(
                          'rounded-lg p-2',
                          hasDisc(l) ? 'text-green-600' : 'text-gray-400 hover:text-gray-600',
                        )}
                      >
                        <Percent size={15} />
                      </button>
                    )}
                    <button
                      onClick={() => setQty(idx, 0)}
                      title={l.isNew ? 'Remove' : 'Remove from order'}
                      className="rounded-lg p-2 text-gray-400 hover:text-rose-600"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
              </div>

              {l.isNew && (openDisc[idx] || hasDisc(l)) && l.quantity > 0 && (
                <div className="mt-2 flex items-center justify-between gap-2 border-t border-green-100 pt-2">
                  <span className="shrink-0 text-xs text-gray-500">Discount</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      value={l.discValue}
                      onChange={(e) => setLineDisc(idx, { discValue: e.target.value.replace(/[^\d.]/g, '') })}
                      placeholder="0"
                      inputMode="decimal"
                      className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-right text-sm"
                    />
                    <div className="inline-flex overflow-hidden rounded-lg border border-gray-200 text-xs">
                      <button
                        type="button"
                        onClick={() => setLineDisc(idx, { discType: 'percentage' })}
                        className={cn('px-2.5 py-1.5', l.discType === 'percentage' ? 'bg-green-600 text-white' : 'bg-white text-gray-600')}
                      >
                        %
                      </button>
                      <button
                        type="button"
                        onClick={() => setLineDisc(idx, { discType: 'fixed' })}
                        className={cn('border-l border-gray-200 px-2.5 py-1.5', l.discType === 'fixed' ? 'bg-green-600 text-white' : 'bg-white text-gray-600')}
                      >
                        {cur}
                      </button>
                    </div>
                    {hasDisc(l) && <span className="ml-1 text-xs font-medium text-green-700">{money(lineNet(l))}</span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add product */}
      <div className="rounded-xl border border-gray-200 p-3">
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
          <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-gray-100">
            {results.map((v) => (
              <button
                key={v.variantId}
                onClick={() => addVariant(v)}
                className="flex w-full items-center gap-2 border-b border-gray-50 px-2 py-2 text-left last:border-0 hover:bg-gray-50"
              >
                {v.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={v.image} alt="" className="h-9 w-9 rounded-lg object-cover" />
                ) : (
                  <div className="h-9 w-9 rounded-lg bg-gray-100" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                  {v.productTitle}
                  {v.variantTitle && v.variantTitle !== 'Default Title' && (
                    <span className="text-gray-400"> · {v.variantTitle}</span>
                  )}
                </span>
                <span className="text-xs text-gray-500">
                  {cur} {v.price}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Warnings from the live preview (Shopify would reject these) */}
      {warnings.length > 0 && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-rose-700">
            <AlertTriangle size={13} /> Shopify won&apos;t accept part of this edit
          </p>
          <ul className="mt-1 list-disc pl-5 text-[11px] text-rose-600">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Total — Shopify-authoritative when available */}
      <div className="rounded-xl bg-gray-50 px-3 py-3">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1.5 text-gray-500">
            Order total
            {previewing && <Loader2 className="h-3 w-3 animate-spin text-gray-400" />}
          </span>
          <span className="flex items-center gap-2">
            {dirty && <span className="text-gray-400 line-through">{money(curTotal)}</span>}
            <span className="text-base font-semibold text-gray-900">{money(displayTotal)}</span>
          </span>
        </div>
        <p className="mt-1 text-[11px] text-gray-400">
          {authoritativeTotal
            ? 'Live from Shopify — exactly what the order will become when you save.'
            : dirty
              ? 'Estimated — the live Shopify total appears in a moment.'
              : 'Current order total.'}
        </p>
        {authoritativeTotal && preview?.outstanding != null && preview.outstanding > 0 && (
          <div className="mt-1.5 flex items-center justify-between border-t border-gray-200 pt-1.5 text-xs">
            <span className="text-gray-500">Balance to collect</span>
            <span className="font-semibold text-gray-800">{money(preview.outstanding)}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-gray-100 pt-3">
        <div className="min-w-0 text-xs text-gray-400">
          {dirty
            ? [
                addedN && `+${addedN} added`,
                removedN && `−${removedN} removed`,
                qtyChg && 'qty changed',
              ]
                .filter(Boolean)
                .join(' · ')
            : 'No changes yet'}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            Close
          </button>
          <button
            onClick={save}
            disabled={saving || !dirty || warnings.length > 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Save to Shopify
          </button>
        </div>
      </div>
    </div>
  );
}
