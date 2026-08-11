'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Minus, Percent, Plus, Search, Trash2, X } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import {
  getOrderEditable,
  editOrderItems,
  type EditableLineItem,
} from '@/lib/couriers';

interface ProductVariant {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  price: string;
  sku: string | null;
  image: string | null;
  available: boolean;
}

// A working line in the editor — either an existing order line or a freshly
// added variant. `original` marks lines that came from the order.
type DiscType = 'percentage' | 'fixed';
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

export function EditItemsModal({
  orderGid,
  orderName,
  onClose,
  onSaved,
}: {
  orderGid: string;
  orderName: string | null;
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
        onClose();
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderGid]);

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
    searchTimer.current = setTimeout(() => runSearch(query), 350);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, runSearch]);

  const setQty = (idx: number, qty: number) =>
    setLines((prev) =>
      prev.map((l, i) => (i === idx ? { ...l, quantity: Math.max(0, qty) } : l)),
    );

  const setLineDisc = (idx: number, patch: Partial<WorkingLine>) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  // Which lines have their discount editor expanded.
  const [openDisc, setOpenDisc] = useState<Record<number, boolean>>({});

  const lineNet = (l: WorkingLine) => {
    const gross = (Number(l.price) || 0) * l.quantity;
    const v = parseFloat(l.discValue) || 0;
    if (!(v > 0)) return gross;
    const d =
      l.discType === 'percentage' ? (gross * Math.min(v, 100)) / 100 : Math.min(v, gross);
    return Math.max(0, gross - d);
  };
  const hasDisc = (l: WorkingLine) => (parseFloat(l.discValue) || 0) > 0;

  const addVariant = (v: ProductVariant) => {
    setLines((prev) => {
      // If the variant is already a line, bump it instead of duplicating.
      const existing = prev.findIndex((l) => l.variantId === v.variantId);
      if (existing >= 0) {
        return prev.map((l, i) =>
          i === existing ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
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

  const dirty = lines.some(
    (l) => l.quantity !== l.originalQuantity || hasDisc(l),
  );
  const total = lines.reduce((sum, l) => sum + lineNet(l), 0);

  const discOf = (l: WorkingLine) =>
    hasDisc(l) ? { type: l.discType, value: parseFloat(l.discValue) } : undefined;

  const save = async () => {
    // Existing lines whose quantity changed OR that carry a discount → updates
    // (quantity 0 removes the line).
    const updates = lines
      .filter((l) => !l.isNew && (l.quantity !== l.originalQuantity || hasDisc(l)))
      .map((l) => ({
        variantId: l.variantId,
        title: l.title,
        quantity: l.quantity,
        discount: discOf(l),
      }));
    // New lines with quantity > 0 → adds (must have a variant id).
    const adds = lines
      .filter((l) => l.isNew && l.quantity > 0 && l.variantId)
      .map((l) => ({
        variantId: l.variantId as string,
        quantity: l.quantity,
        discount: discOf(l),
      }));

    if (!updates.length && !adds.length) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await editOrderItems(orderGid, { updates, adds });
      toast.success('Order items updated in Shopify');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to update items');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Edit items — ${orderName ?? 'order'}`} size="lg">
      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : !editable ? (
        <div className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
          This order is already fulfilled — its items can no longer be edited.
        </div>
      ) : (
        <div className="space-y-4">
          {/* Current lines */}
          <div className="space-y-2">
            {lines.length === 0 && (
              <p className="text-sm text-gray-500">No items on this order.</p>
            )}
            {lines.map((l, idx) => (
              <div
                key={`${l.variantId ?? l.title}-${idx}`}
                className={cn(
                  'rounded-lg border p-2',
                  l.quantity === 0
                    ? 'border-gray-200 bg-gray-50 opacity-60'
                    : 'border-gray-200',
                )}
              >
                <div className="flex items-center gap-3">
                  {l.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.image} alt="" className="h-10 w-10 rounded object-cover" />
                  ) : (
                    <div className="h-10 w-10 rounded bg-gray-100" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-800">
                      {l.title}
                      {l.isNew && (
                        <span className="ml-2 rounded bg-green-50 px-1.5 py-0.5 text-[10px] text-green-700">
                          new
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-gray-400">
                      {[l.variantTitle, l.price ? `Rs ${l.price}` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setQty(idx, l.quantity - 1)}
                      className="rounded border border-gray-200 p-1 text-gray-500 hover:bg-gray-50"
                    >
                      <Minus size={14} />
                    </button>
                    <input
                      value={l.quantity}
                      onChange={(e) => setQty(idx, Number(e.target.value.replace(/\D/g, '')) || 0)}
                      className="w-10 rounded border border-gray-200 px-1 py-1 text-center text-sm"
                    />
                    <button
                      onClick={() => setQty(idx, l.quantity + 1)}
                      className="rounded border border-gray-200 p-1 text-gray-500 hover:bg-gray-50"
                    >
                      <Plus size={14} />
                    </button>
                    <button
                      onClick={() =>
                        setOpenDisc((o) => ({ ...o, [idx]: !o[idx] }))
                      }
                      title="Add discount"
                      className={cn(
                        'rounded p-1',
                        hasDisc(l)
                          ? 'text-green-600'
                          : 'text-gray-400 hover:text-gray-600',
                      )}
                    >
                      <Percent size={15} />
                    </button>
                    <button
                      onClick={() => setQty(idx, 0)}
                      title="Remove item"
                      className="ml-0.5 rounded p-1 text-gray-400 hover:text-rose-600"
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
                        onChange={(e) =>
                          setLineDisc(idx, {
                            discValue: e.target.value.replace(/[^\d.]/g, ''),
                          })
                        }
                        placeholder="0"
                        className="w-20 rounded border border-gray-200 px-2 py-1 text-right text-sm"
                      />
                      <div className="inline-flex overflow-hidden rounded border border-gray-200 text-xs">
                        <button
                          type="button"
                          onClick={() => setLineDisc(idx, { discType: 'percentage' })}
                          className={cn(
                            'px-2 py-1',
                            l.discType === 'percentage'
                              ? 'bg-green-600 text-white'
                              : 'bg-white text-gray-600',
                          )}
                        >
                          %
                        </button>
                        <button
                          type="button"
                          onClick={() => setLineDisc(idx, { discType: 'fixed' })}
                          className={cn(
                            'border-l border-gray-200 px-2 py-1',
                            l.discType === 'fixed'
                              ? 'bg-green-600 text-white'
                              : 'bg-white text-gray-600',
                          )}
                        >
                          Rs
                        </button>
                      </div>
                      {hasDisc(l) && (
                        <span className="ml-1 text-xs text-green-700">
                          Rs {lineNet(l).toFixed(0)}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Add product */}
          <div className="rounded-lg border border-gray-200 p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Add a product…"
                className="w-full rounded-lg border border-gray-200 py-2 pl-8 pr-3 text-sm"
              />
              {searching && (
                <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-gray-400" />
              )}
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
                    <span className="text-xs text-gray-500">Rs {v.price}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {lines.some(hasDisc) && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
              Discounts are applied on top of the current order. Re-editing a line
              that already has a discount adds another — set discounts once.
            </p>
          )}
          <div className="flex items-center justify-between border-t border-gray-100 pt-3">
            <span className="text-sm text-gray-600">
              New total: <span className="font-semibold">Rs {total.toFixed(0)}</span>
            </span>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
              >
                <X size={14} /> Cancel
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
      )}
    </Modal>
  );
}
