'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus, Minus, Trash2, Loader2, Gift } from 'lucide-react';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import { ApiError } from '@/lib/api';
import {
  PrSubmission,
  ProductVariant,
  searchProducts,
  sendPackage,
} from '@/lib/pr';

interface Line {
  variant: ProductVariant;
  quantity: number;
}

/**
 * Pick catalogue products for a 0-amount "PR" order. Products come from the
 * existing Shopify product search; the order is created with a 100% discount
 * and tagged "PR" server-side.
 */
export function SendPackageModal({
  submission,
  onClose,
  onDone,
}: {
  submission: PrSubmission;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductVariant[]>([]);
  const [searching, setSearching] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        setResults(await searchProducts(query.trim()));
      } catch (e) {
        toast.error(e instanceof ApiError ? e.userMessage : 'Search failed');
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const addVariant = (v: ProductVariant) => {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.variant.variantId === v.variantId);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], quantity: next[i].quantity + 1 };
        return next;
      }
      return [...prev, { variant: v, quantity: 1 }];
    });
  };

  const setQty = (variantId: string, delta: number) =>
    setLines((prev) =>
      prev
        .map((l) =>
          l.variant.variantId === variantId
            ? { ...l, quantity: Math.max(0, l.quantity + delta) }
            : l,
        )
        .filter((l) => l.quantity > 0),
    );

  const retail = useMemo(
    () =>
      lines.reduce(
        (sum, l) => sum + (parseFloat(l.variant.price) || 0) * l.quantity,
        0,
      ),
    [lines],
  );

  const submit = async () => {
    if (lines.length === 0) return toast.error('Add at least one product');
    setBusy(true);
    try {
      const res = await sendPackage(
        submission.id,
        lines.map((l) => ({ variantId: l.variant.variantId, quantity: l.quantity })),
      );
      toast.success(`PR order ${res.order?.orderName ?? ''} created (free)`);
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to create order');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Send PR package — ${submission.influencer_name}`}
      size="lg"
      footer={
        <>
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || lines.length === 0}
            className="px-4 py-2 text-sm rounded-lg bg-pink-600 text-white font-medium hover:bg-pink-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Gift size={16} />}
            Create free order
          </button>
        </>
      }
    >
      <div className="p-4 space-y-4">
        <p className="text-xs text-gray-500">
          The order is created at <span className="font-medium">PKR 0</span> (100%
          discount), marked paid, and tagged <span className="font-medium">PR</span>.
          Shipping goes to {submission.address ? 'the submitted address' : 'the influencer'}.
        </p>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products…"
            className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm"
          />
          {searching && (
            <Loader2 className="absolute right-3 top-2.5 animate-spin text-gray-400" size={16} />
          )}
        </div>

        {results.length > 0 && (
          <div className="max-h-48 overflow-y-auto border border-gray-100 rounded-lg divide-y">
            {results.map((v) => (
              <button
                key={v.variantId}
                onClick={() => addVariant(v)}
                className="w-full flex items-center gap-3 p-2 hover:bg-gray-50 text-left"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {v.image ? (
                  <img src={v.image} alt="" className="w-9 h-9 rounded object-cover" />
                ) : (
                  <div className="w-9 h-9 rounded bg-gray-100" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{v.productTitle}</p>
                  <p className="text-xs text-gray-400 truncate">
                    {v.variantTitle} · {v.price}
                  </p>
                </div>
                <Plus size={16} className="text-pink-600 shrink-0" />
              </button>
            ))}
          </div>
        )}

        {/* Chosen lines */}
        <div>
          <p className="text-xs font-medium text-gray-600 mb-1.5">
            Selected products
          </p>
          {lines.length === 0 ? (
            <p className="text-sm text-gray-400">None yet — search and add above.</p>
          ) : (
            <div className="space-y-2">
              {lines.map((l) => (
                <div
                  key={l.variant.variantId}
                  className="flex items-center gap-3 border border-gray-200 rounded-lg p-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm truncate">{l.variant.productTitle}</p>
                    <p className="text-xs text-gray-400 truncate">{l.variant.variantTitle}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => setQty(l.variant.variantId, -1)}
                      className="p-1 rounded border border-gray-300 hover:bg-gray-50"
                    >
                      <Minus size={13} />
                    </button>
                    <span className="w-6 text-center text-sm">{l.quantity}</span>
                    <button
                      onClick={() => setQty(l.variant.variantId, 1)}
                      className="p-1 rounded border border-gray-300 hover:bg-gray-50"
                    >
                      <Plus size={13} />
                    </button>
                    <button
                      onClick={() => setQty(l.variant.variantId, -l.quantity)}
                      className="p-1 rounded border border-gray-300 text-red-500 hover:bg-red-50 ml-1"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
              <p className="text-xs text-gray-400 text-right">
                Retail value {retail.toFixed(2)} · billed to influencer:{' '}
                <span className="font-medium text-gray-600">0.00</span>
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
