'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, ImagePlus, Loader2, Plus, Sparkles, Trash2, X, XCircle } from 'lucide-react';
import { useToast } from '@/components/toast';
import { ApiError, apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { getLocations, PRODUCT_STATUS_META, type InventoryLocation, type ProductStatus } from '@/lib/inventory';
import { listSuppliers, type Supplier } from '@/lib/inventory-ops';
import { createProduct, describeProduct, getPublishJobs, retryPublishJob, uploadProductImage, type PublishJob } from '@/lib/inventory-products';
import { inputCls, money, parseMoney } from '@/components/inventory/shared';

interface StoreRow {
  id: number;
  label: string | null;
  shopDomain?: string | null;
  provider?: string;
}
interface Opt {
  name: string;
  values: string[];
  draft: string;
}
interface Row {
  key: string;
  optionValues: string[];
  sku: string;
  barcode: string;
  price: string;
  compareAt: string;
  cost: string;
  stock: Record<number, string>;
}

const cartesian = (opts: Opt[]): string[][] =>
  opts.filter((o) => o.values.length).reduce<string[][]>((acc, o) => acc.flatMap((a) => o.values.map((v) => [...a, v])), [[]]);

const slug = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 4);

/** Create a product once, publish it to every chosen store, sharing one stock pool. */
export default function NewProductPage() {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [aiNotes, setAiNotes] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [images, setImages] = useState<Array<{ path: string; url: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [opts, setOpts] = useState<Opt[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [skuPattern, setSkuPattern] = useState('');
  const [productType, setProductType] = useState('');
  const [vendor, setVendor] = useState('');
  const [tags, setTags] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [pick, setPick] = useState<Record<number, { on: boolean; status: ProductStatus; delta: string }>>({});
  const [busy, setBusy] = useState(false);
  const [batch, setBatch] = useState<string | null>(null);
  const [jobs, setJobs] = useState<PublishJob[]>([]);
  const [pollSeq, setPollSeq] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listSuppliers().then(setSuppliers).catch(() => undefined);
    getLocations().then((l) => setLocations(l.filter((x) => x.isActive))).catch(() => undefined);
    apiFetch<StoreRow[]>('/shopify/stores')
      .then((s) => {
        setStores(s);
        setPick(Object.fromEntries(s.map((x, i) => [x.id, { on: i === 0, status: 'active' as ProductStatus, delta: '' }])));
      })
      .catch(() => undefined);
  }, []);

  // rebuild the variant table when options change (keep values the person typed)
  const combos = useMemo(() => (opts.some((o) => o.values.length) ? cartesian(opts) : [[]]), [opts]);
  useEffect(() => {
    setRows((prev) =>
      combos.map((c) => {
        const key = c.join('|') || 'default';
        const old = prev.find((r) => r.key === key);
        return old ?? { key, optionValues: c, sku: '', barcode: '', price: prev[0]?.price ?? '', compareAt: prev[0]?.compareAt ?? '', cost: prev[0]?.cost ?? '', stock: {} };
      }),
    );
  }, [combos]);

  // poll publish jobs
  useEffect(() => {
    if (!batch) return;
    let stop = false;
    const tick = async () => {
      const j = await getPublishJobs(batch).catch(() => null);
      if (stop) return;
      if (j) setJobs(j);
      if (!j || j.some((x) => x.status === 'pending' || x.status === 'running')) setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [batch, pollSeq]);

  const applySkuPattern = () => {
    const base = skuPattern.trim().toUpperCase() || slug(title);
    setRows((rs) => rs.map((r) => ({ ...r, sku: [base, ...r.optionValues.map(slug)].filter(Boolean).join('-') })));
  };
  const setAll = (k: 'price' | 'compareAt' | 'cost', v: string) => setRows((rs) => rs.map((r) => ({ ...r, [k]: v })));

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files).slice(0, 10 - images.length)) {
        const up = await uploadProductImage(f);
        setImages((im) => [...im, up]);
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const chosen = stores.filter((s) => pick[s.id]?.on);
  const totalStock = rows.reduce((a, r) => a + Object.values(r.stock).reduce((x, v) => x + (Number(v) || 0), 0), 0);

  const submit = async () => {
    if (!title.trim()) return toast.error('Give the product a title');
    if (!chosen.length) return toast.error('Pick at least one store');
    const variants = [];
    for (const r of rows) {
      const price = parseMoney(r.price);
      const cmp = parseMoney(r.compareAt);
      const cost = parseMoney(r.cost);
      const name = r.optionValues.join(' / ') || 'the product';
      if (price === 'invalid' || price == null || !(price > 0)) return toast.error(`Enter a price for ${name}`);
      if (cmp === 'invalid' || cost === 'invalid') return toast.error(`Check the numbers for ${name}`);
      if (cmp != null && cmp > 0 && cmp <= price) return toast.error(`Compare-at for ${name} must be above its price`);
      variants.push({
        optionValues: r.optionValues,
        sku: r.sku.trim() || null,
        barcode: r.barcode.trim() || null,
        price,
        compareAt: cmp,
        cost,
        stock: Object.fromEntries(Object.entries(r.stock).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Number(v)])),
      });
    }
    setBusy(true);
    try {
      const res = await createProduct({
        title: title.trim(),
        descriptionHtml: desc || null,
        productType: productType.trim() || null,
        vendor: vendor.trim() || null,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        images: images.map((i) => i.path),
        supplierId: supplierId ? Number(supplierId) : null,
        options: opts.filter((o) => o.name.trim() && o.values.length).map((o) => ({ name: o.name.trim(), values: o.values })),
        variants,
        stores: chosen.map((s) => ({ storeId: s.id, status: pick[s.id].status, priceDelta: Number(pick[s.id].delta) || null })),
      });
      setBatch(res.batchKey);
      toast.success('Creating the product in your stores');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not create the product');
    } finally {
      setBusy(false);
    }
  };

  if (batch) {
    const done = jobs.length > 0 && jobs.every((j) => j.status === 'ok' || j.status === 'error');
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
        <h1 className="text-2xl font-extrabold text-ink">{title}</h1>
        <p className="text-sm text-muted">{done ? 'Finished.' : 'Creating it in each store — this takes a few seconds.'}</p>
        {jobs.map((j) => (
          <div key={j.id} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3 text-sm">
            <span className="flex items-center gap-2 font-semibold">
              {j.status === 'ok' ? (
                <CheckCircle2 className="h-4 w-4 text-brand-600" aria-hidden="true" />
              ) : j.status === 'error' ? (
                <XCircle className="h-4 w-4 text-red-600" aria-hidden="true" />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-sky-600" aria-hidden="true" />
              )}
              {j.store}
            </span>
            {j.status === 'error' ? (
              <span className="flex items-center gap-2">
                <span className="max-w-[18rem] text-xs text-red-700">{j.error}</span>
                <Button size="sm" variant="secondary" onClick={async () => { await retryPublishJob(j.id).catch(() => undefined); setPollSeq((n) => n + 1); setJobs((js) => js.map((x) => (x.id === j.id ? { ...x, status: 'pending' } : x))); }}>
                  Retry
                </Button>
              </span>
            ) : (
              <span className="text-xs text-muted">{j.status === 'ok' ? 'Live in the store' : 'Working…'}</span>
            )}
          </div>
        ))}
        <div className="flex gap-2">
          <Link href="/inventory"><Button>Back to catalogue</Button></Link>
          <Button variant="secondary" onClick={() => window.location.reload()}>Create another</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-4 px-4 pb-28 pt-5 sm:px-6">
      <header>
        <Link href="/inventory" className="text-sm font-bold text-brand-700">← Catalogue</Link>
        <h1 className="mt-1 text-2xl font-extrabold text-ink">New product</h1>
        <p className="text-sm text-muted">Created once in CodesApp, published to the stores you pick. Every store shares the same stock.</p>
      </header>
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-4">
          <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="p-title" className="text-xs font-bold text-ink">Title</label>
              <input id="p-title" className={cn(inputCls, 'text-base font-semibold')} value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label htmlFor="p-desc" className="text-xs font-bold text-ink">Description</label>
                <span className="flex items-center gap-2">
                  <label htmlFor="p-ai" className="sr-only">Notes for the AI</label>
                  <input id="p-ai" className={cn(inputCls, 'h-8 w-56 text-xs')} placeholder="Notes for AI: fabric, fit, use…" value={aiNotes} onChange={(e) => setAiNotes(e.target.value)} />
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={aiBusy}
                    disabled={!title.trim()}
                    onClick={async () => {
                      setAiBusy(true);
                      try {
                        const r = await describeProduct({ title, notes: aiNotes, productType, options: opts.map((o) => `${o.name}: ${o.values.join(', ')}`).join('; ') });
                        setDesc(r.html);
                      } catch (e) {
                        toast.error(e instanceof ApiError ? e.userMessage : 'AI is not available');
                      } finally {
                        setAiBusy(false);
                      }
                    }}
                  >
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> Write with AI
                  </Button>
                </span>
              </div>
              <textarea id="p-desc" className={cn(inputCls, 'h-32 py-2 font-mono text-xs')} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Plain text or simple HTML" />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-bold text-ink">Images</span>
              <div className="flex flex-wrap gap-2">
                {images.map((im, i) => (
                  <div key={im.path} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={im.path} alt="" className="h-20 w-20 rounded-xl border border-line object-cover" />
                    <button type="button" aria-label="Remove image" onClick={() => setImages((x) => x.filter((_, j) => j !== i))} className="absolute -right-1.5 -top-1.5 rounded-full bg-gray-900 p-0.5 text-white">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                {images.length < 10 && (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line text-xs font-semibold text-muted hover:border-brand-300"
                  >
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />} Add
                  </button>
                )}
                <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple className="sr-only" aria-label="Add images" onChange={(e) => void onFiles(e.target.files)} />
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
            <h2 className="text-sm font-extrabold text-ink">Options &amp; variants</h2>
            {opts.map((o, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-2">
                <label htmlFor={`opt-${i}`} className="sr-only">Option name</label>
                <input id={`opt-${i}`} className={cn(inputCls, 'h-9 w-32')} placeholder="Size" value={o.name} onChange={(e) => setOpts((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
                {o.values.map((v) => (
                  <span key={v} className="inline-flex items-center gap-1 rounded-lg bg-sunken px-2 py-1 text-sm">
                    {v}
                    <button type="button" aria-label={`Remove ${v}`} onClick={() => setOpts((x) => x.map((y, j) => (j === i ? { ...y, values: y.values.filter((z) => z !== v) } : y)))}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <label htmlFor={`optv-${i}`} className="sr-only">Add a value</label>
                <input
                  id={`optv-${i}`}
                  className={cn(inputCls, 'h-9 w-40')}
                  placeholder="Type a value, Enter"
                  value={o.draft}
                  onChange={(e) => setOpts((x) => x.map((y, j) => (j === i ? { ...y, draft: e.target.value } : y)))}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ',') return;
                    e.preventDefault();
                    const v = o.draft.trim();
                    if (v && !o.values.includes(v)) setOpts((x) => x.map((y, j) => (j === i ? { ...y, values: [...y.values, v], draft: '' } : y)));
                  }}
                />
                <Button size="sm" variant="ghost" aria-label="Remove option" onClick={() => setOpts((x) => x.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {opts.length < 3 && (
              <div>
                <Button size="sm" variant="secondary" onClick={() => setOpts((x) => [...x, { name: x.length ? '' : 'Size', values: [], draft: '' }])}>
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add option (size, colour…)
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label htmlFor="sku-pat" className="text-xs font-bold text-ink">SKU prefix</label>
              <input id="sku-pat" className={cn(inputCls, 'h-9 w-32')} placeholder={slug(title) || 'LK'} value={skuPattern} onChange={(e) => setSkuPattern(e.target.value)} />
              <Button size="sm" variant="secondary" onClick={applySkuPattern}>Fill SKUs</Button>
              <span className="text-xs text-muted">Makes PREFIX-SIZE-COLOUR for every variant (editable).</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="px-2 py-2">Variant</th>
                    <th className="px-2 py-2">SKU</th>
                    <th className="px-2 py-2">Barcode</th>
                    <th className="px-2 py-2 text-right">
                      Price
                      <button type="button" className="ml-1 text-brand-700" onClick={() => setAll('price', rows[0]?.price ?? '')}>all</button>
                    </th>
                    <th className="px-2 py-2 text-right">Compare-at</th>
                    <th className="px-2 py-2 text-right">
                      Cost
                      <button type="button" className="ml-1 text-brand-700" onClick={() => setAll('cost', rows[0]?.cost ?? '')}>all</button>
                    </th>
                    {locations.map((l) => (
                      <th key={l.id} className="px-2 py-2 text-right">{l.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const cell = (k: 'sku' | 'barcode' | 'price' | 'compareAt' | 'cost', w: string, num?: boolean) => (
                      <input
                        aria-label={`${k} for ${r.optionValues.join(' / ') || 'product'}`}
                        className={cn(inputCls, 'h-9', w, num && 'text-right')}
                        inputMode={num ? 'decimal' : undefined}
                        value={r[k]}
                        onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))}
                      />
                    );
                    return (
                      <tr key={r.key} className="border-t border-line">
                        <td className="px-2 py-1.5 font-semibold">{r.optionValues.join(' / ') || 'Default'}</td>
                        <td className="px-2 py-1.5">{cell('sku', 'w-36')}</td>
                        <td className="px-2 py-1.5">{cell('barcode', 'w-32')}</td>
                        <td className="px-2 py-1.5">{cell('price', 'w-24', true)}</td>
                        <td className="px-2 py-1.5">{cell('compareAt', 'w-24', true)}</td>
                        <td className="px-2 py-1.5">{cell('cost', 'w-24', true)}</td>
                        {locations.map((l) => (
                          <td key={l.id} className="px-2 py-1.5">
                            <input
                              aria-label={`Opening stock at ${l.name}`}
                              className={cn(inputCls, 'h-9 w-20 text-right')}
                              inputMode="numeric"
                              value={r.stock[l.id] ?? ''}
                              onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, stock: { ...x.stock, [l.id]: e.target.value.replace(/[^0-9]/g, '') } } : x)))}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
          <section className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
            <h2 className="text-sm font-extrabold text-ink">Publish to stores</h2>
            {stores.map((s) => {
              const p = pick[s.id] ?? { on: false, status: 'active' as ProductStatus, delta: '' };
              return (
                <div key={s.id} className={cn('flex flex-col gap-2 rounded-xl border p-3 text-sm', p.on ? 'border-brand-500' : 'border-line')}>
                  <label className="flex items-center gap-2 font-semibold">
                    <input type="checkbox" checked={p.on} onChange={(e) => setPick((x) => ({ ...x, [s.id]: { ...p, on: e.target.checked } }))} />
                    {s.label || s.shopDomain || `Store ${s.id}`}
                    <span className="text-xs font-normal text-muted">{s.provider === 'woocommerce' ? 'WooCommerce' : 'Shopify'}</span>
                  </label>
                  {p.on && (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex flex-col gap-1">
                        <label htmlFor={`st-${s.id}`} className="text-xs font-bold text-ink">Status</label>
                        <select id={`st-${s.id}`} className={cn(inputCls, 'h-9')} value={p.status} onChange={(e) => setPick((x) => ({ ...x, [s.id]: { ...p, status: e.target.value as ProductStatus } }))}>
                          {(Object.keys(PRODUCT_STATUS_META) as ProductStatus[]).map((k) => (
                            <option key={k} value={k}>{PRODUCT_STATUS_META[k].label} — {PRODUCT_STATUS_META[k].hint}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label htmlFor={`pd-${s.id}`} className="text-xs font-bold text-ink">Price change here</label>
                        <input id={`pd-${s.id}`} className={cn(inputCls, 'h-9 text-right')} inputMode="decimal" placeholder="0 or -500" value={p.delta} onChange={(e) => setPick((x) => ({ ...x, [s.id]: { ...p, delta: e.target.value.replace(/[^0-9.-]/g, '') } }))} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <p className="text-xs text-muted">Each store gets its own product, linked to the same CodesApp item, so stock is shared.</p>
          </section>
          <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
            <h2 className="text-sm font-extrabold text-ink">Organise</h2>
            {(
              [
                ['p-type', 'Category / product type', productType, setProductType],
                ['p-vendor', 'Vendor / brand', vendor, setVendor],
                ['p-tags', 'Tags (comma separated)', tags, setTags],
              ] as Array<[string, string, string, (v: string) => void]>
            ).map(([id, label, v, set]) => (
              <div key={id} className="flex flex-col gap-1">
                <label htmlFor={id} className="text-xs font-bold text-ink">{label}</label>
                <input id={id} className={inputCls} value={v} onChange={(e) => set(e.target.value)} />
              </div>
            ))}
            <div className="flex flex-col gap-1">
              <label htmlFor="p-sup" className="text-xs font-bold text-ink">Supplier</label>
              <select id="p-sup" className={inputCls} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">None</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </section>
        </aside>
      </div>
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur md:left-auto md:right-6 md:bottom-5 md:rounded-2xl md:border">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-muted">
            {rows.length} variant{rows.length === 1 ? '' : 's'} · {chosen.length} store{chosen.length === 1 ? '' : 's'} · {totalStock} units opening stock
            {rows[0]?.price && <> · from {money(Number(rows[0].price) || 0)}</>}
          </span>
          <Button onClick={submit} loading={busy} disabled={!title.trim() || !chosen.length}>
            Create in {chosen.length || ''} store{chosen.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </div>
  );
}
