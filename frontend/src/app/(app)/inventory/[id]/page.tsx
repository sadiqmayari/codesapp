'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Package,
  ArrowUp,
  Loader2,
  Save,
  History,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { fmtDateTime } from '@/lib/utils';
import {
  InventoryVariantDetail,
  UpdateVariantInput,
  STOCK_STATUS_META,
  MOVEMENT_REASON_LABEL,
  getInventoryVariant,
  updateInventoryVariant,
  pushInventoryVariant,
} from '@/lib/inventory';

const money = (n: number | null) =>
  n == null ? '—' : 'Rs ' + Math.round(n).toLocaleString('en-PK');

export default function InventoryVariantPage() {
  const params = useParams();
  const router = useRouter();
  const toast = useToast();
  const id = Number(params?.id);

  const [v, setV] = useState<InventoryVariantDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);

  // editable form
  const [form, setForm] = useState<UpdateVariantInput>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getInventoryVariant(id);
      setV(data);
      setForm({
        item_code: data.itemCode ?? '',
        alias: data.alias ?? '',
        reorder_level: data.reorderLevel,
        cost_price: data.costPrice,
        shelf_location: data.shelfLocation ?? '',
        category: data.category ?? '',
        notes: data.notes ?? '',
        local_qty: data.localQty,
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load');
      if (e instanceof ApiError && e.status === 404) router.replace('/inventory');
    } finally {
      setLoading(false);
    }
  }, [id, router, toast]);

  useEffect(() => {
    if (Number.isFinite(id)) void load();
  }, [id, load]);

  const set = <K extends keyof UpdateVariantInput>(k: K, val: UpdateVariantInput[K]) =>
    setForm((f) => ({ ...f, [k]: val }));

  const save = async () => {
    setSaving(true);
    try {
      const updated = await updateInventoryVariant(id, {
        item_code: form.item_code || null,
        alias: form.alias || null,
        reorder_level: Number(form.reorder_level) || 0,
        cost_price:
          form.cost_price === null || form.cost_price === undefined || `${form.cost_price}` === ''
            ? null
            : Number(form.cost_price),
        shelf_location: form.shelf_location || null,
        category: form.category || null,
        notes: form.notes || null,
        local_qty: Number(form.local_qty) || 0,
      });
      setV(updated);
      toast.success('Saved');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const push = async () => {
    setPushing(true);
    try {
      await pushInventoryVariant(id);
      toast.success('Queued push to Shopify');
      setTimeout(load, 1500);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Push failed');
    } finally {
      setPushing(false);
    }
  };

  if (loading && !v) {
    return (
      <div className="py-24 text-center text-gray-400">
        <Loader2 className="w-6 h-6 animate-spin mx-auto" />
      </div>
    );
  }
  if (!v) return null;

  const meta = STOCK_STATUS_META[v.status];

  return (
    <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-6 space-y-6">
      <Link
        href="/inventory"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to inventory
      </Link>

      {/* Header */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 flex gap-4">
        {v.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={v.image}
            alt=""
            className="w-20 h-20 rounded-lg object-cover bg-gray-100 shrink-0"
          />
        ) : (
          <span className="w-20 h-20 rounded-lg bg-gray-100 grid place-items-center text-gray-300 shrink-0">
            <Package className="w-7 h-7" />
          </span>
        )}
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-gray-900">{v.productTitle}</h1>
          <div className="text-sm text-gray-500">
            {[v.variantTitle, v.sku ? `SKU ${v.sku}` : null]
              .filter(Boolean)
              .join(' · ') || '—'}
          </div>
          <div className="flex items-center gap-4 mt-3 text-sm">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium border ${meta.chip}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
              {meta.label}
            </span>
            <span className="text-gray-500">
              Shopify: <b className="text-gray-900 tabular-nums">{v.shopifyQty}</b>
            </span>
            <span className="text-gray-500">
              CodesApp: <b className="text-gray-900 tabular-nums">{v.localQty}</b>
            </span>
            <span className="text-gray-400">Price {money(v.price)}</span>
          </div>
        </div>
      </div>

      {/* Editor */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h2 className="font-semibold text-gray-900">Details</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Item Code (CodesApp-only)">
            <input
              value={form.item_code ?? ''}
              onChange={(e) => set('item_code', e.target.value)}
              className={inputCls}
              placeholder="e.g. SOI-101"
            />
          </Field>
          <Field label="Alias (CodesApp-only)">
            <input
              value={form.alias ?? ''}
              onChange={(e) => set('alias', e.target.value)}
              className={inputCls}
              placeholder="e.g. night serum"
            />
          </Field>
          <Field label="CodesApp quantity">
            <input
              value={String(form.local_qty ?? 0)}
              inputMode="numeric"
              onChange={(e) =>
                set('local_qty', Number(e.target.value.replace(/[^0-9]/g, '')) || 0)
              }
              className={inputCls}
            />
          </Field>
          <Field label="Reorder level (low-stock at ≤)">
            <input
              value={String(form.reorder_level ?? 0)}
              inputMode="numeric"
              onChange={(e) =>
                set('reorder_level', Number(e.target.value.replace(/[^0-9]/g, '')) || 0)
              }
              className={inputCls}
            />
          </Field>
          <Field label="Cost price (for stock value)">
            <input
              value={form.cost_price == null ? '' : String(form.cost_price)}
              inputMode="decimal"
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9.]/g, '');
                set('cost_price', raw === '' ? null : Number(raw));
              }}
              className={inputCls}
              placeholder="0"
            />
          </Field>
          <Field label="Shelf / bin location">
            <input
              value={form.shelf_location ?? ''}
              onChange={(e) => set('shelf_location', e.target.value)}
              className={inputCls}
              placeholder="e.g. A3-02"
            />
          </Field>
          <Field label="Category">
            <input
              value={form.category ?? ''}
              onChange={(e) => set('category', e.target.value)}
              className={inputCls}
              placeholder="e.g. Skincare"
            />
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            value={form.notes ?? ''}
            onChange={(e) => set('notes', e.target.value)}
            rows={3}
            className={`${inputCls} resize-y`}
          />
        </Field>
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white rounded-lg px-4 py-2 text-sm font-medium"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save
          </button>
          <button
            onClick={push}
            disabled={pushing}
            className="inline-flex items-center gap-2 bg-gray-900 hover:bg-black disabled:opacity-60 text-white rounded-lg px-4 py-2 text-sm font-medium"
          >
            {pushing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
            Push qty to Shopify
          </button>
        </div>
      </div>

      {/* Movement timeline */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="font-semibold text-gray-900 flex items-center gap-2 mb-4">
          <History className="w-4 h-4 text-gray-400" />
          Stock movements
        </h2>
        {v.movements.length === 0 ? (
          <p className="text-sm text-gray-400">No movements yet.</p>
        ) : (
          <ul className="space-y-2">
            {v.movements.map((m) => (
              <li
                key={m.id}
                className="flex items-center gap-3 text-sm border-b border-gray-50 pb-2 last:border-0"
              >
                <span
                  className={`w-14 text-right tabular-nums font-semibold ${
                    m.delta < 0 ? 'text-red-600' : 'text-green-600'
                  }`}
                >
                  {m.delta > 0 ? '+' : ''}
                  {m.delta}
                </span>
                <span className="flex-1 text-gray-700">
                  {MOVEMENT_REASON_LABEL[m.reason] ?? m.reason}
                  {m.ref ? <span className="text-gray-400"> · {m.ref}</span> : null}
                </span>
                <span className="text-gray-400 tabular-nums">→ {m.qtyAfter}</span>
                <span className="text-gray-400 w-40 text-right">
                  {fmtDateTime(m.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const inputCls =
  'w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-500 mb-1">{label}</span>
      {children}
    </label>
  );
}
