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
  Truck,
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
 * the order drawer's `EditOrderModal` Items tab.
 *
 * Matches the create-order form as far as Shopify's Order-Edit API allows:
 *  • Change qty / remove / add products.
 *  • A discount on EVERY line (%, or flat) — set cleanly via update/remove, never
 *    stacked (orderEditUpdateDiscount/RemoveDiscount).
 *  • A whole-order discount, spread proportionally across the lines.
 *  • A shipping rate picker (the store's live rates for the order's destination).
 *  • The total is Shopify's AUTHORITATIVE calculated total (live preview).
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
interface ShippingRate {
  handle: string;
  title: string;
  amount: string;
  currencyCode: string;
}

interface WorkingLine {
  variantId: string | null;
  title: string;
  variantTitle: string | null;
  price: string | null; // gross unit price
  image: string | null;
  quantity: number;
  originalQuantity: number; // 0 for newly-added lines
  isNew: boolean;
  discType: DiscType;
  discValue: string; // this line's own discount (empty/0 = none)
  origDiscount: number; // discount currently on the line (for change detection)
}

// Shopify order-edit can only ADD a shipping charge (never modify/remove the
// original line), so we offer it only when the order has no charge yet.
type ShipChoice = { kind: 'keep' } | { kind: 'rate'; title: string; amount: number };

// Line maths ------------------------------------------------------------------
const grossOf = (l: WorkingLine) => (Number(l.price) || 0) * l.quantity;
const lineDiscOf = (l: WorkingLine) => {
  const v = parseFloat(l.discValue) || 0;
  if (!(v > 0)) return 0;
  const g = grossOf(l);
  return l.discType === 'percentage' ? (g * Math.min(v, 100)) / 100 : Math.min(v, g);
};

function targetDiscounts(
  lines: WorkingLine[],
  orderDiscType: DiscType,
  orderDiscValue: string,
): Map<WorkingLine, number> {
  const active = lines.filter((l) => l.quantity > 0);
  const netOf = (l: WorkingLine) => grossOf(l) - lineDiscOf(l);
  const subAfterLine = active.reduce((s, l) => s + netOf(l), 0);
  const odv = parseFloat(orderDiscValue) || 0;
  const orderDiscTotal =
    odv > 0
      ? orderDiscType === 'percentage'
        ? (subAfterLine * Math.min(odv, 100)) / 100
        : Math.min(odv, subAfterLine)
      : 0;
  const out = new Map<WorkingLine, number>();
  for (const l of lines) {
    if (l.quantity <= 0) {
      out.set(l, 0);
      continue;
    }
    const share = subAfterLine > 0 ? orderDiscTotal * (netOf(l) / subAfterLine) : 0;
    out.set(l, Math.min(grossOf(l), Math.round((lineDiscOf(l) + share) * 100) / 100));
  }
  return out;
}

export function OrderItemsEditor({
  orderGid,
  currency: currencyProp = 'Rs',
  prepaid = false,
  onClose,
  onSaved,
}: {
  orderGid: string;
  currency?: string;
  prepaid?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [editable, setEditable] = useState(true);
  const [currency, setCurrency] = useState(currencyProp);
  const [lines, setLines] = useState<WorkingLine[]>([]);
  const [saving, setSaving] = useState(false);

  const [orderDiscType, setOrderDiscType] = useState<DiscType>('percentage');
  const [orderDiscValue, setOrderDiscValue] = useState('');

  const [shipCurrent, setShipCurrent] = useState<{ title: string; amount: number } | null>(null);
  const [shipChoice, setShipChoice] = useState<ShipChoice>({ kind: 'keep' });
  const [shipAddr, setShipAddr] = useState<{ address1: string | null; city: string | null; countryCode: string | null } | null>(null);
  const [shipRates, setShipRates] = useState<ShippingRate[]>([]);
  const [ratesLoading, setRatesLoading] = useState(false);
  const ratesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductVariant[]>([]);
  const [searching, setSearching] = useState(false);
  const [openDisc, setOpenDisc] = useState<Record<number, boolean>>({});
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [preview, setPreview] = useState<{
    subtotal: number | null;
    total: number | null;
    outstanding: number | null;
    currency: string;
    warnings: string[];
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await getOrderEditable(orderGid);
        setEditable(res.editable);
        setCurrency(res.currency || currencyProp);
        setShipCurrent(res.shipping);
        setShipAddr(res.shippingAddress);
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
            // Pre-fill the line's current discount (as a flat amount) so "no
            // change" keeps it; the agent edits it or adds an order-level one.
            discType: 'fixed' as DiscType,
            discValue: i.discountAmount > 0 ? String(Math.round(i.discountAmount)) : '',
            origDiscount: i.discountAmount,
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

  // Product search — includes draft/unlisted (all=1); the AI auto-order stays strict.
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
  const setDiscValue = (idx: number, raw: string) =>
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        let s = raw.replace(/[^\d.]/g, '');
        if (l.discType === 'percentage' && (parseFloat(s) || 0) > 100) s = '100';
        return { ...l, discValue: s };
      }),
    );
  const setDiscType = (idx: number, type: DiscType) =>
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        let s = l.discValue;
        if (type === 'percentage' && (parseFloat(s) || 0) > 100) s = '100';
        return { ...l, discType: type, discValue: s };
      }),
    );

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
          discType: 'fixed' as DiscType,
          discValue: '',
          origDiscount: 0,
        },
      ];
    });
    setQuery('');
    setResults([]);
  };

  // Targets + change detection --------------------------------------------------
  const targets = useMemo(
    () => targetDiscounts(lines, orderDiscType, orderDiscValue),
    [lines, orderDiscType, orderDiscValue],
  );
  const addedN = lines.filter((l) => l.isNew && l.quantity > 0).length;
  const removedN = lines.filter((l) => !l.isNew && l.quantity === 0).length;
  const qtyChg = lines.some((l) => !l.isNew && l.quantity > 0 && l.quantity !== l.originalQuantity);
  const discChg = lines.some(
    (l) => l.quantity > 0 && Math.abs((targets.get(l) ?? 0) - l.origDiscount) > 0.5,
  );
  const shipChg = shipChoice.kind !== 'keep';
  const dirty = addedN > 0 || removedN > 0 || qtyChg || discChg || shipChg;
  // A line the discount would wipe out entirely (100% off) blocks save.
  const freeLine = lines.some((l) => l.quantity > 0 && (targets.get(l) ?? 0) >= grossOf(l) && grossOf(l) > 0);

  const buildChanges = useCallback((): OrderEditChanges => {
    const updates = lines
      .filter((l) => !l.isNew && (l.quantity !== l.originalQuantity || Math.abs((targets.get(l) ?? 0) - l.origDiscount) > 0.5))
      .map((l) => ({
        variantId: l.variantId,
        title: l.title,
        quantity: l.quantity,
        discountAmount: l.quantity > 0 ? (targets.get(l) ?? 0) : 0,
      }));
    const adds = lines
      .filter((l) => l.isNew && l.quantity > 0 && l.variantId)
      .map((l) => ({ variantId: l.variantId as string, quantity: l.quantity, discountAmount: targets.get(l) ?? 0 }));
    const changes: OrderEditChanges = { updates, adds };
    if (shipChoice.kind === 'rate') changes.shipping = { title: shipChoice.title, amount: shipChoice.amount };
    return changes;
  }, [lines, targets, shipChoice]);

  // Live shipping rates for the resulting cart + the order's destination.
  const cartKey = useMemo(
    () =>
      JSON.stringify(
        lines.filter((l) => l.quantity > 0 && l.variantId).map((l) => [l.variantId, l.quantity]),
      ) + '|' + JSON.stringify(shipAddr),
    [lines, shipAddr],
  );
  useEffect(() => {
    if (ratesTimer.current) clearTimeout(ratesTimer.current);
    const cart = lines.filter((l) => l.quantity > 0 && l.variantId);
    if (!editable || !cart.length) {
      setShipRates([]);
      return;
    }
    ratesTimer.current = setTimeout(async () => {
      setRatesLoading(true);
      try {
        const r = await apiFetch<ShippingRate[]>('/shopify/shipping-rates', {
          method: 'POST',
          body: {
            lineItems: cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
            address1: shipAddr?.address1 || undefined,
            city: shipAddr?.city || undefined,
            countryCode: shipAddr?.countryCode || undefined,
          },
        });
        setShipRates(Array.isArray(r) ? r : []);
      } catch {
        setShipRates([]);
      } finally {
        setRatesLoading(false);
      }
    }, 500);
    return () => {
      if (ratesTimer.current) clearTimeout(ratesTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey, editable]);

  // Live authoritative total (stage against Shopify, no commit).
  const changesKey = useMemo(() => JSON.stringify(buildChanges()), [buildChanges]);
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
        setPreview(await previewOrderEdit(orderGid, JSON.parse(changesKey) as OrderEditChanges));
      } catch {
        setPreview(null);
      } finally {
        setPreviewing(false);
      }
    }, 600);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changesKey, dirty, editable, orderGid]);

  const warnings = preview?.warnings ?? [];
  const cur = preview?.currency || currency;
  const money = (v: number | null | undefined) =>
    v == null ? '—' : `${cur} ${Math.round(v).toLocaleString()}`;

  // Local estimate fallback for the total.
  const localTotal = useMemo(() => {
    const items = lines.reduce((s, l) => s + Math.max(0, grossOf(l) - (targets.get(l) ?? 0)), 0);
    const ship = shipChoice.kind === 'rate' ? shipChoice.amount : shipCurrent?.amount ?? 0;
    return items + ship;
  }, [lines, targets, shipChoice, shipCurrent]);
  const curTotal = useMemo(
    () => lines.reduce((s, l) => s + (Number(l.price) || 0) * l.originalQuantity - l.origDiscount, 0) + (shipCurrent?.amount ?? 0),
    [lines, shipCurrent],
  );
  const authoritative = dirty && preview?.total != null;
  const displayTotal = authoritative ? preview!.total! : dirty ? localTotal : curTotal;

  const save = async () => {
    const changes = buildChanges();
    if (!changes.updates?.length && !changes.adds?.length && changes.shipping === undefined) return;
    setSaving(true);
    try {
      await editOrderItems(orderGid, changes);
      toast.success('Order updated in Shopify');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to update order');
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
        This order is already fulfilled — it can no longer be edited.
      </div>
    );

  const shipLabel = (r: ShippingRate) => `${r.title} · ${cur} ${Math.round(parseFloat(r.amount) || 0).toLocaleString()}`;

  return (
    <div className="space-y-3">
      {prepaid && (
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-[11px] text-blue-700">
          This order is already paid — changing it creates a balance or refund on the Shopify order
          that you&apos;ll need to settle there.
        </p>
      )}

      {/* Lines */}
      <div className="space-y-2">
        {lines.length === 0 && <p className="text-sm text-gray-500">No items on this order.</p>}
        {lines.map((l, idx) => {
          const removed = !l.isNew && l.quantity === 0;
          const changed = !l.isNew && l.quantity !== l.originalQuantity;
          const hasD = (parseFloat(l.discValue) || 0) > 0;
          const tgt = targets.get(l) ?? 0;
          const net = Math.max(0, grossOf(l) - tgt);
          const free = l.quantity > 0 && tgt >= grossOf(l) && grossOf(l) > 0;
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
                      <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-green-700">added</span>
                    )}
                    {removed && (
                      <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-gray-500">removed</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-gray-400">
                    {[l.variantTitle, l.price ? `${cur} ${l.price}` : null].filter(Boolean).join(' · ')}
                  </p>
                </div>

                {removed ? (
                  <button onClick={() => setQty(idx, l.originalQuantity)} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
                    <RotateCcw size={13} /> Undo
                  </button>
                ) : (
                  <div className="flex items-center gap-1">
                    <div className="inline-flex items-center overflow-hidden rounded-lg border border-gray-200">
                      <button onClick={() => setQty(idx, l.quantity - 1)} className="p-2 text-gray-500 hover:bg-gray-50" aria-label="Decrease">
                        <Minus size={14} />
                      </button>
                      <input value={l.quantity} onChange={(e) => setQty(idx, Number(e.target.value.replace(/\D/g, '')) || 0)} inputMode="numeric" className="w-9 border-x border-gray-200 py-1.5 text-center text-sm" />
                      <button onClick={() => setQty(idx, l.quantity + 1)} className="p-2 text-gray-500 hover:bg-gray-50" aria-label="Increase">
                        <Plus size={14} />
                      </button>
                    </div>
                    <button onClick={() => setOpenDisc((o) => ({ ...o, [idx]: !o[idx] }))} title="Discount" className={cn('rounded-lg p-2', hasD ? 'text-green-600' : 'text-gray-400 hover:text-gray-600')}>
                      <Percent size={15} />
                    </button>
                    <button onClick={() => setQty(idx, 0)} title="Remove" className="rounded-lg p-2 text-gray-400 hover:text-rose-600">
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
              </div>

              {!removed && (openDisc[idx] || hasD) && l.quantity > 0 && (
                <div className="mt-2 border-t border-gray-100 pt-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="shrink-0 text-xs text-gray-500">Discount</span>
                    <div className="flex items-center gap-1.5">
                      <input value={l.discValue} onChange={(e) => setDiscValue(idx, e.target.value)} placeholder="0" inputMode="decimal" className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-right text-sm" />
                      <div className="inline-flex overflow-hidden rounded-lg border border-gray-200 text-xs">
                        <button type="button" onClick={() => setDiscType(idx, 'percentage')} className={cn('px-2.5 py-1.5', l.discType === 'percentage' ? 'bg-green-600 text-white' : 'bg-white text-gray-600')}>%</button>
                        <button type="button" onClick={() => setDiscType(idx, 'fixed')} className={cn('border-l border-gray-200 px-2.5 py-1.5', l.discType === 'fixed' ? 'bg-green-600 text-white' : 'bg-white text-gray-600')}>{cur}</button>
                      </div>
                      <span className={cn('ml-1 text-xs font-medium', free ? 'text-rose-600' : 'text-green-700')}>{money(net)}</span>
                    </div>
                  </div>
                  {free && <p className="mt-1 text-right text-[11px] text-rose-600">Discount can&apos;t be the whole price — lower it.</p>}
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
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Add a product…" className="w-full rounded-lg border border-gray-200 py-2 pl-8 pr-3 text-sm" />
          {searching && <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-gray-400" />}
        </div>
        {results.length > 0 && (
          <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-gray-100">
            {results.map((v) => (
              <button key={v.variantId} onClick={() => addVariant(v)} className="flex w-full items-center gap-2 border-b border-gray-50 px-2 py-2 text-left last:border-0 hover:bg-gray-50">
                {v.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={v.image} alt="" className="h-9 w-9 rounded-lg object-cover" />
                ) : (
                  <div className="h-9 w-9 rounded-lg bg-gray-100" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                  {v.productTitle}
                  {v.variantTitle && v.variantTitle !== 'Default Title' && <span className="text-gray-400"> · {v.variantTitle}</span>}
                </span>
                <span className="text-xs text-gray-500">{cur} {v.price}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Whole-order discount */}
      <div className="flex items-center justify-between gap-2 rounded-xl border border-gray-200 px-3 py-2.5">
        <span className="text-sm text-gray-600">Order discount</span>
        <div className="flex items-center gap-1.5">
          <input value={orderDiscValue} onChange={(e) => { let s = e.target.value.replace(/[^\d.]/g, ''); if (orderDiscType === 'percentage' && (parseFloat(s) || 0) > 100) s = '100'; setOrderDiscValue(s); }} placeholder="0" inputMode="decimal" className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-right text-sm" />
          <div className="inline-flex overflow-hidden rounded-lg border border-gray-200 text-xs">
            <button type="button" onClick={() => { setOrderDiscType('percentage'); if ((parseFloat(orderDiscValue) || 0) > 100) setOrderDiscValue('100'); }} className={cn('px-2.5 py-1.5', orderDiscType === 'percentage' ? 'bg-green-600 text-white' : 'bg-white text-gray-600')}>%</button>
            <button type="button" onClick={() => setOrderDiscType('fixed')} className={cn('border-l border-gray-200 px-2.5 py-1.5', orderDiscType === 'fixed' ? 'bg-green-600 text-white' : 'bg-white text-gray-600')}>{cur}</button>
          </div>
        </div>
      </div>

      {/* Shipping — add a charge (only when the order has none; Shopify can't
          modify an existing shipping line via order editing). */}
      {shipCurrent && shipCurrent.amount > 0 ? (
        <div className="flex items-center justify-between rounded-xl border border-gray-200 px-3 py-2.5 text-sm">
          <span className="flex items-center gap-1.5 text-gray-600">
            <Truck size={15} className="text-gray-400" /> Shipping
          </span>
          <span className="text-gray-700">
            {money(shipCurrent.amount)} <span className="text-[11px] text-gray-400">(change in Shopify)</span>
          </span>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-sm text-gray-600">
            <Truck size={15} className="text-gray-400" /> Shipping charge
            {ratesLoading && <Loader2 className="h-3 w-3 animate-spin text-gray-400" />}
          </div>
          <div className="space-y-1">
            <label className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-gray-50">
              <input type="radio" checked={shipChoice.kind === 'keep'} onChange={() => setShipChoice({ kind: 'keep' })} />
              <span className="text-gray-700">No charge</span>
            </label>
            {shipRates.map((r) => (
              <label key={r.handle} className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-gray-50">
                <input type="radio" checked={shipChoice.kind === 'rate' && shipChoice.title === r.title && shipChoice.amount === (parseFloat(r.amount) || 0)} onChange={() => setShipChoice({ kind: 'rate', title: r.title, amount: parseFloat(r.amount) || 0 })} />
                <span className="text-gray-700">{shipLabel(r)}</span>
              </label>
            ))}
            {!ratesLoading && shipRates.length === 0 && (
              <p className="px-1.5 text-[11px] text-gray-400">No shipping rates for this address.</p>
            )}
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-rose-700">
            <AlertTriangle size={13} /> Shopify won&apos;t accept part of this edit
          </p>
          <ul className="mt-1 list-disc pl-5 text-[11px] text-rose-600">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* Total */}
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
          {authoritative
            ? 'Live from Shopify — exactly what the order will become when you save.'
            : dirty
              ? 'Estimated — the live Shopify total appears in a moment.'
              : 'Current order total.'}
        </p>
        {authoritative && preview?.outstanding != null && preview.outstanding > 0 && (
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
            ? [addedN && `+${addedN} added`, removedN && `−${removedN} removed`, qtyChg && 'qty', discChg && 'discount', shipChg && 'shipping'].filter(Boolean).join(' · ')
            : 'No changes yet'}
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">Close</button>
          <button onClick={save} disabled={saving || !dirty || warnings.length > 0 || freeLine} className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
            {saving && <Loader2 size={14} className="animate-spin" />}
            Save to Shopify
          </button>
        </div>
      </div>
    </div>
  );
}
