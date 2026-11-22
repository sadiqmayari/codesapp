'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { getItem, getLocations, type InventoryLocation } from '@/lib/inventory';
import { createPO, getReorderSuggestions, listSuppliers, type Supplier } from '@/lib/inventory-ops';
import { ItemPicker } from '@/components/inventory/item-picker';
import { inputCls, money, parseMoney } from '@/components/inventory/shared';

interface Line {
  itemId: number;
  title: string;
  sku: string | null;
  qty: string;
  cost: string;
  note?: string;
}

/** PO builder — from scratch, from selected items (?items=1,2) or from reorder suggestions. */
export default function NewPurchaseOrderPage() {
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [supplierId, setSupplierId] = useState<string>(params?.get('supplier') ?? '');
  const [locationId, setLocationId] = useState(0);
  const [expectedAt, setExpectedAt] = useState('');
  const [freight, setFreight] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listSuppliers().then(setSuppliers).catch(() => undefined);
    getLocations()
      .then((l) => {
        setLocations(l);
        setLocationId(l.find((x) => x.isDefault)?.id ?? l[0]?.id ?? 0);
      })
      .catch(() => undefined);
    const ids = (params?.get('items') ?? '').split(',').map(Number).filter((n) => n > 0);
    if (ids.length) {
      Promise.all(ids.slice(0, 100).map((id) => getItem(id).catch(() => null))).then((items) =>
        setLines(
          items
            .filter((x): x is NonNullable<typeof x> => !!x && !x.isBundle)
            .map((it) => ({ itemId: it.id, title: [it.title, it.variantTitle].filter((v) => v && v !== 'Default Title').join(' · '), sku: it.sku, qty: String(Math.max(1, it.reorderQty ?? 1)), cost: it.avgCost != null ? String(it.avgCost) : '' })),
        ),
      );
    } else if (params?.get('from') === 'suggestions') {
      getReorderSuggestions({ supplierId: Number(params.get('supplier')) || undefined })
        .then((s) =>
          setLines(
            s
              .filter((x) => (params.get('supplier') ? true : !x.supplierId))
              .map((x) => ({
                itemId: x.itemId,
                title: x.title,
                sku: x.sku,
                qty: String(x.suggested),
                cost: x.unitCost != null ? String(x.unitCost) : '',
                note: `${x.available} available · sells ${x.soldPerDay}/day`,
              })),
          ),
        )
        .catch(() => undefined);
    }
    // params read once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = useMemo(
    () => lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost.replace(/,/g, '')) || 0), 0) + (Number(freight) || 0),
    [lines, freight],
  );

  const save = async () => {
    const f = parseMoney(freight);
    if (f === 'invalid') return toast.error('Freight must be a number');
    for (const l of lines) {
      if (!(Number(l.qty) > 0)) return toast.error(`Enter a quantity for ${l.title}`);
      if (parseMoney(l.cost) === 'invalid') return toast.error(`Cost for ${l.title} must be a number`);
    }
    setBusy(true);
    try {
      const po = await createPO({
        supplierId: supplierId ? Number(supplierId) : null,
        locationId,
        expectedAt: expectedAt || null,
        notes: notes.trim() || null,
        freight: f ?? 0,
        lines: lines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty), unitCost: parseMoney(l.cost) as number | null })),
      });
      toast.success(`${po.number} saved as a draft`);
      router.replace(`/inventory/purchase-orders/${po.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header>
        <Link href="/inventory/purchase-orders" className="text-sm font-bold text-brand-700">← Purchase orders</Link>
        <h1 className="mt-1 text-2xl font-extrabold text-ink">New purchase order</h1>
      </header>
      <section className="grid gap-3 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="po-sup" className="text-xs font-bold text-ink">Supplier</label>
          <select id="po-sup" className={inputCls} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">No supplier</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="po-loc" className="text-xs font-bold text-ink">Deliver to</label>
          <select id="po-loc" className={inputCls} value={locationId} onChange={(e) => setLocationId(Number(e.target.value))}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="po-exp" className="text-xs font-bold text-ink">Expected</label>
          <input id="po-exp" type="date" className={inputCls} value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="po-fr" className="text-xs font-bold text-ink">Freight / landed cost</label>
          <input id="po-fr" inputMode="decimal" className={inputCls} value={freight} onChange={(e) => setFreight(e.target.value)} placeholder="0" />
        </div>
      </section>
      <section className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
        <ItemPicker
          exclude={new Set(lines.map((l) => l.itemId))}
          onPick={(it) => setLines((ls) => [...ls, { itemId: it.id, title: [it.title, it.variantTitle].filter((v) => v && v !== 'Default Title').join(' · '), sku: it.sku, qty: '1', cost: '' }])}
        />
        {lines.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Add the items you are ordering.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-2 py-2">Item</th>
                  <th className="px-2 py-2 text-right">Qty</th>
                  <th className="px-2 py-2 text-right">Unit cost</th>
                  <th className="px-2 py-2 text-right">Line total</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.itemId} className="border-t border-line">
                    <td className="px-2 py-2">
                      <div className="font-semibold text-ink">{l.title}</div>
                      <div className="text-xs text-muted">{[l.sku, l.note].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <label htmlFor={`q-${l.itemId}`} className="sr-only">Quantity</label>
                      <input id={`q-${l.itemId}`} inputMode="numeric" className={`${inputCls} ml-auto w-20 text-right`} value={l.qty}
                        onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/[^0-9]/g, '') } : x)))} />
                    </td>
                    <td className="px-2 py-2 text-right">
                      <label htmlFor={`c-${l.itemId}`} className="sr-only">Unit cost</label>
                      <input id={`c-${l.itemId}`} inputMode="decimal" className={`${inputCls} ml-auto w-28 text-right`} value={l.cost} placeholder="0"
                        onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)))} />
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{money((Number(l.qty) || 0) * (Number(l.cost.replace(/,/g, '')) || 0))}</td>
                    <td className="px-2 py-2 text-right">
                      <Button size="sm" variant="ghost" aria-label={`Remove ${l.title}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-1 rounded-2xl border border-line bg-surface p-4">
        <label htmlFor="po-notes" className="text-xs font-bold text-ink">Notes for the supplier</label>
        <textarea id="po-notes" className={`${inputCls} h-20 py-2`} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </section>
      <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-gray-900 px-4 py-3 text-sm text-white shadow-2xl">
        <span>
          {lines.length} items · {lines.reduce((a, l) => a + (Number(l.qty) || 0), 0)} units · <b>{money(total)}</b>
        </span>
        <Button onClick={save} loading={busy} disabled={!lines.length || !locationId}>Save draft</Button>
      </div>
    </div>
  );
}
