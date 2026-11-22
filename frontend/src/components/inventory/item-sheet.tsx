'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, Link2, Minus, Plus, RefreshCw, Unlink } from 'lucide-react';
import { SideSheet } from '@/components/ui/side-sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { StorePill } from '@/components/store-pill';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { cn, fmtDateTime } from '@/lib/utils';
import {
  ADJUST_REASONS,
  adjustItem,
  downloadLedgerCsv,
  getItem,
  linkCandidates,
  linkListing,
  listMovements,
  MOVEMENT_REASON_LABEL,
  pushItem,
  unlinkListing,
  updateItem,
  updateListing,
  type ItemDetail,
  type Movement,
} from '@/lib/inventory';
import { BundleBadge, inputCls, itemName, money, parseMoney, ProductStatusBadge, PushChip, StockBadge, Thumb } from './shared';

type Tab = 'stock' | 'pricing' | 'ledger' | 'details';

/**
 * Inventory item sheet: stock by location, linked stores, adjust, pricing per
 * store, ledger, details. Opens over the catalogue (URL ?item=<id>) so the
 * person never loses their place in the list.
 */
export function ItemSheet({
  itemId,
  onClose,
  onChanged,
  version,
}: {
  itemId: number | null;
  onClose: () => void;
  onChanged: () => void;
  /** bump to refetch (live socket change) */
  version: number;
}) {
  const toast = useToast();
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [tab, setTab] = useState<Tab>('stock');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!itemId) return;
    try {
      const d = await getItem(itemId);
      setItem(d);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not load the item');
      onClose();
    } finally {
      setLoading(false);
    }
  }, [itemId, toast, onClose]);

  useEffect(() => {
    if (!itemId) {
      setItem(null);
      return;
    }
    setLoading(true);
    setTab('stock');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  useEffect(() => {
    if (itemId && version) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const changed = (next?: ItemDetail) => {
    if (next) setItem(next);
    else void load();
    onChanged();
  };

  return (
    <SideSheet
      open={itemId != null}
      onClose={onClose}
      width="lg"
      title={item ? itemName(item) : 'Item'}
      subtitle={
        item ? (
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {item.sku && <span>SKU {item.sku}</span>}
            {item.itemCode && <span>Code {item.itemCode}</span>}
            {item.barcode && <span>Barcode {item.barcode}</span>}
            {item.shelfLocation && <span>Shelf {item.shelfLocation}</span>}
          </span>
        ) : undefined
      }
      icon={item ? <Thumb src={item.image} alt="" /> : undefined}
    >
      {loading || !item ? (
        <SkeletonRows rows={6} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <StockBadge status={item.status} />
            {item.isBundle && <BundleBadge />}
            {!item.track && <Badge tone="neutral">Not tracked</Badge>}
            {item.listings.length > 1 && <Badge tone="brand">Shared stock · {item.listings.length} stores</Badge>}
            {item.conflict && <Badge tone="warn">Stores disagree</Badge>}
          </div>
          <div role="tablist" aria-label="Item sections" className="flex gap-1 border-b border-line">
            {(
              [
                ['stock', 'Stock'],
                ['pricing', 'Pricing & cost'],
                ['ledger', 'Ledger'],
                ['details', 'Details'],
              ] as Array<[Tab, string]>
            ).map(([k, l]) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-semibold',
                  tab === k ? 'border-brand-600 text-ink' : 'border-transparent text-muted hover:text-ink',
                )}
              >
                {l}
              </button>
            ))}
          </div>
          {tab === 'stock' && <StockTab item={item} onChanged={changed} />}
          {tab === 'pricing' && <PricingTab item={item} onChanged={changed} />}
          {tab === 'ledger' && <LedgerTab itemId={item.id} version={version} />}
          {tab === 'details' && <DetailsTab item={item} onChanged={changed} />}
        </div>
      )}
    </SideSheet>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'brand' | 'info' }) {
  return (
    <div
      className={cn(
        'rounded-xl border p-3',
        tone === 'brand' ? 'border-brand-500 bg-brand-50' : 'border-line bg-surface',
      )}
    >
      <div className={cn('text-xs font-semibold', tone === 'brand' ? 'text-brand-700' : 'text-muted')}>{label}</div>
      <div className={cn('text-xl font-extrabold tabular-nums', tone === 'info' ? 'text-sky-700' : 'text-ink')}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}

function StockTab({ item, onChanged }: { item: ItemDetail; onChanged: (d?: ItemDetail) => void }) {
  const toast = useToast();
  const locs = item.locations.filter((l) => l.isActive || l.onHand);
  const [locationId, setLocationId] = useState<number>(locs.find((l) => l.isDefault)?.id ?? locs[0]?.id ?? 0);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('adjust_damaged');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const loc = item.locations.find((l) => l.id === locationId);
  const d = Number(delta);
  const validDelta = /^-?\d+$/.test(delta.trim()) && d !== 0;
  const stores = item.listings.map((l) => l.storeLabel).join(' and ');

  const save = async () => {
    if (!validDelta) return;
    setSaving(true);
    try {
      const next = await adjustItem(item.id, { locationId, delta: d, reason, note: note.trim() || undefined });
      toast.success('Stock adjusted — pushing to stores');
      setDelta('');
      setNote('');
      onChanged(next);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not adjust stock');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="On hand" value={item.onHand} />
        <Tile label="Committed" value={item.committed} sub="ordered, not shipped" />
        <Tile
          label="Available"
          tone="brand"
          value={item.available}
          sub={item.daysCover != null ? `≈ ${Math.round(item.daysCover)} days cover` : item.sold30 ? undefined : 'no sales in 30 days'}
        />
        <Tile label="Incoming" tone="info" value={item.incoming} sub="open purchase orders" />
      </div>

      {item.isBundle && item.components && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-extrabold text-ink">Built from</h3>
          <div className="overflow-hidden rounded-xl border border-line">
            {item.components.map((c) => (
              <div key={c.itemId} className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 text-sm last:border-0">
                <span className="min-w-0 truncate">
                  {c.quantity} × {c.title}
                </span>
                <span className={cn('tabular-nums', c.limiting && 'font-bold text-amber-800')}>
                  {c.available} available{c.limiting ? ' · limits the bundle' : ''}
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted">A bundle has no stock of its own. Selling one takes its parts out.</p>
        </section>
      )}

      {!item.isBundle && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-extrabold text-ink">By location</h3>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="bg-sunken text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-semibold">Location</th>
                  <th className="px-3 py-2 text-right font-semibold">On hand</th>
                  <th className="px-3 py-2 text-right font-semibold">Committed</th>
                  <th className="px-3 py-2 text-right font-semibold">Available</th>
                  <th className="px-3 py-2 text-right font-semibold">Incoming</th>
                </tr>
              </thead>
              <tbody>
                {item.locations.map((l) => (
                  <tr key={l.id} className={cn('border-t border-line', !l.isActive && 'text-muted')}>
                    <td className="px-3 py-2 font-semibold">
                      {l.name}
                      {!l.isActive && ' (inactive)'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.onHand}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.committed}</td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums">{l.available}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-sky-700">{l.incoming || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-extrabold text-ink">Linked stores</h3>
          <Button size="sm" variant="ghost" onClick={() => setLinkOpen((v) => !v)}>
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" /> Link another store’s product
          </Button>
        </div>
        {item.listings.map((l) => (
          <div
            key={l.id}
            className={cn(
              'flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm',
              l.qtyPushStatus === 'error' ? 'border-red-300 bg-red-50' : 'border-line',
            )}
          >
            <span className="flex flex-wrap items-center gap-2">
              <StorePill storeId={l.storeId} label={l.storeLabel} />
              <ProductStatusBadge status={l.productStatus} />
              <span className="text-muted">
                store shows <b className="text-ink">{l.storeQty}</b>
                {l.price != null && <> · {money(l.price)}</>}
                {l.linkSource && l.linkSource !== 'created' && <> · linked by {l.linkSource}</>}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <PushChip listings={[l]} />
              {item.listings.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Unlink ${l.storeLabel}`}
                  onClick={async () => {
                    try {
                      await unlinkListing(l.id);
                      toast.success('Unlinked — that store now has its own stock');
                      onChanged();
                    } catch (e) {
                      toast.error(e instanceof ApiError ? e.userMessage : 'Could not unlink');
                    }
                  }}
                >
                  <Unlink className="h-3.5 w-3.5" aria-hidden="true" /> Unlink
                </Button>
              )}
            </span>
          </div>
        ))}
        {linkOpen && <LinkPicker itemId={item.id} onLinked={(d) => { setLinkOpen(false); onChanged(d); }} />}
        <p className="text-xs text-muted">
          {item.listings.length > 1
            ? `One stock pool for ${stores}. A sale in one store lowers the other. Prices stay per store.`
            : 'Only sold in one store. Link the same product from another store to share its stock.'}
        </p>
        <div>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              await pushItem(item.id).catch(() => undefined);
              toast.info('Pushing current stock to every store');
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Push now
          </Button>
        </div>
      </section>

      {!item.isBundle && locs.length > 0 && (
        <section className="flex flex-col gap-3 rounded-xl border border-line p-3">
          <h3 className="text-sm font-extrabold text-ink">Adjust stock</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="adj-loc" className="text-xs font-bold text-ink">Location</label>
              <select id="adj-loc" className={inputCls} value={locationId} onChange={(e) => setLocationId(Number(e.target.value))}>
                {locs.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="adj-qty" className="text-xs font-bold text-ink">Change by</label>
              <div className="flex gap-1">
                <Button variant="secondary" aria-label="Decrease" onClick={() => setDelta(String((Number(delta) || 0) - 1))}>
                  <Minus className="h-4 w-4" />
                </Button>
                <input id="adj-qty" inputMode="numeric" className={cn(inputCls, 'text-center font-bold')} value={delta}
                  onChange={(e) => setDelta(e.target.value.replace(/[^0-9-]/g, ''))} placeholder="-2 or 5" />
                <Button variant="secondary" aria-label="Increase" onClick={() => setDelta(String((Number(delta) || 0) + 1))}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="adj-reason" className="text-xs font-bold text-ink">Reason</label>
              <select id="adj-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)}>
                {ADJUST_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="adj-note" className="text-xs font-bold text-ink">Note (optional)</label>
            <input id="adj-note" className={inputCls} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
            <span>
              {loc && validDelta ? (
                <>
                  {loc.name} {loc.available} → <b className="text-ink">{loc.available + d}</b>
                  {item.listings.length ? ` · pushes to ${stores}` : ''}
                </>
              ) : (
                'Type how many to add (5) or remove (-2).'
              )}
            </span>
            <Button onClick={save} loading={saving} disabled={!validDelta}>Save adjustment</Button>
          </div>
        </section>
      )}
    </div>
  );
}

function LinkPicker({ itemId, onLinked }: { itemId: number; onLinked: (d: ItemDetail) => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Awaited<ReturnType<typeof linkCandidates>>>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      linkCandidates(itemId, q)
        .then((r) => live && setRows(r))
        .catch(() => live && setRows([]))
        .finally(() => live && setLoading(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [itemId, q]);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-sunken p-3">
      <label htmlFor="link-q" className="text-xs font-bold text-ink">Find the same product in another store</label>
      <input id="link-q" className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title or SKU" />
      {loading ? (
        <SkeletonRows rows={2} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No matching products in your other stores.</p>
      ) : (
        rows.map((r) => (
          <div key={r.listingId} className="flex items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2 text-sm">
            <span className="min-w-0 truncate">
              {r.title}
              {r.variantTitle && r.variantTitle !== 'Default Title' ? ` · ${r.variantTitle}` : ''}
              {r.sku ? <span className="text-muted"> · {r.sku}</span> : null}
            </span>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  const d = await linkListing(itemId, r.listingId);
                  toast.success('Linked — both stores now share this stock');
                  onLinked(d);
                } catch (e) {
                  toast.error(e instanceof ApiError ? e.userMessage : 'Could not link');
                }
              }}
            >
              Link
            </Button>
          </div>
        ))
      )}
    </div>
  );
}

function PricingTab({ item, onChanged }: { item: ItemDetail; onChanged: (d?: ItemDetail) => void }) {
  const toast = useToast();
  const [cost, setCost] = useState(item.avgCost != null ? String(item.avgCost) : '');
  const [saving, setSaving] = useState(false);
  const margin = (price: number | null) =>
    price && item.avgCost != null ? `${Math.round(((price - item.avgCost) / price) * 100)}% margin` : null;

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-extrabold text-ink">Price in each store</h3>
        {item.listings.map((l) => (
          <ListingPrice key={l.id} listing={l} margin={margin} onSaved={() => onChanged()} />
        ))}
      </section>
      <section className="flex flex-col gap-2 rounded-xl border border-line p-3">
        <label htmlFor="avg-cost" className="text-sm font-extrabold text-ink">Unit cost</label>
        <p className="text-xs text-muted">
          Used for stock value, margins and profit reports. Receiving a purchase order updates it automatically (weighted average). Saving
          here also sets Shopify’s cost per item.
        </p>
        <div className="flex gap-2">
          <input id="avg-cost" inputMode="decimal" className={inputCls} value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0" />
          <Button
            loading={saving}
            onClick={async () => {
              const v = parseMoney(cost);
              if (v === 'invalid') return toast.error('Enter a cost like 1250 or 1250.50');
              setSaving(true);
              try {
                const d = await updateItem(item.id, { avg_cost: v });
                toast.success('Cost saved');
                onChanged(d);
              } catch (e) {
                toast.error(e instanceof ApiError ? e.userMessage : 'Could not save cost');
              } finally {
                setSaving(false);
              }
            }}
          >
            Save cost
          </Button>
        </div>
        {item.costHistory.length > 0 && (
          <div className="mt-1 flex flex-col gap-1 text-xs text-muted">
            {item.costHistory.map((c, i) => (
              <div key={i} className="flex justify-between gap-2">
                <span>{money(c.oldCost)} → <b className="text-ink">{money(c.newCost)}</b> · {c.source === 'po' ? `received ${c.ref ?? ''}` : 'set by hand'}</span>
                <span>{fmtDateTime(c.at)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ListingPrice({
  listing,
  margin,
  onSaved,
}: {
  listing: ItemDetail['listings'][number];
  margin: (p: number | null) => string | null;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [price, setPrice] = useState(listing.price != null ? String(listing.price) : '');
  const [cmp, setCmp] = useState(listing.compareAtPrice != null ? String(listing.compareAtPrice) : '');
  const [saving, setSaving] = useState(false);
  const dirty = price !== (listing.price != null ? String(listing.price) : '') || cmp !== (listing.compareAtPrice != null ? String(listing.compareAtPrice) : '');
  const save = async () => {
    const p = parseMoney(price);
    const c = parseMoney(cmp);
    if (p === 'invalid' || p == null || !(p > 0)) return toast.error('Sale price must be more than 0');
    if (c === 'invalid') return toast.error('Enter a compare-at price like 3990');
    if (c != null && c > 0 && c <= p) return toast.error('Compare-at must be higher than the sale price');
    setSaving(true);
    try {
      await updateListing(listing.id, { price: p, compare_at_price: c });
      toast.success(`Price saved — updating ${listing.storeLabel}`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save price');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <StorePill storeId={listing.storeId} label={listing.storeLabel} />
        <span className="text-xs text-muted">{margin(Number(price) || null)}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`p-${listing.id}`} className="text-xs font-bold text-ink">Sale price</label>
          <input id={`p-${listing.id}`} inputMode="decimal" className={inputCls} value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`c-${listing.id}`} className="text-xs font-bold text-ink">Compare-at (“was”)</label>
          <input id={`c-${listing.id}`} inputMode="decimal" className={inputCls} value={cmp} onChange={(e) => setCmp(e.target.value)} placeholder="none" />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <PushChip listings={[{ ...listing, qtyPushStatus: null, costPushStatus: null, productStatusPush: null }]} />
        <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>Save price</Button>
      </div>
    </div>
  );
}

function LedgerTab({ itemId, version }: { itemId: number; version: number }) {
  const [rows, setRows] = useState<Movement[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  useEffect(() => {
    let live = true;
    listMovements({ itemId, page, limit: 25 })
      .then((r) => {
        if (!live) return;
        setRows(r.rows);
        setTotal(r.total);
      })
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [itemId, page, version]);
  if (!rows) return <SkeletonRows rows={5} />;
  if (!rows.length) return <EmptyState compact title="No stock movements yet" description="Sales, returns, receiving and adjustments will show here." />;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => void downloadLedgerCsv({ itemId })}>
          <Download className="h-3.5 w-3.5" aria-hidden="true" /> Export
        </Button>
      </div>
      {rows.map((m) => (
        <div key={m.id} className="grid grid-cols-[56px_1fr_auto] items-start gap-3 border-t border-line py-2 text-sm">
          <span className={cn('text-right font-extrabold tabular-nums', m.delta < 0 ? 'text-red-700' : m.delta > 0 ? 'text-brand-700' : 'text-muted')}>
            {m.delta > 0 ? `+${m.delta}` : m.delta < 0 ? `−${Math.abs(m.delta)}` : '0'}
          </span>
          <span className="min-w-0">
            <b>{MOVEMENT_REASON_LABEL[m.reason] ?? m.reason}</b>{' '}
            <span className="text-muted">
              {m.ref && <RefLink ref_={m.ref} />}
              {m.location && ` · ${m.location}`} · now {m.after}
              {m.by && ` · ${m.by}`}
              {m.note && ` · ${m.note}`}
            </span>
          </span>
          <span className="whitespace-nowrap text-xs text-muted">{fmtDateTime(m.at)}</span>
        </div>
      ))}
      {total > 25 && (
        <div className="flex items-center justify-between pt-2 text-xs text-muted">
          <span>{total} movements</span>
          <span className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Newer</Button>
            <Button size="sm" variant="secondary" disabled={page * 25 >= total} onClick={() => setPage((p) => p + 1)}>Older</Button>
          </span>
        </div>
      )}
    </div>
  );
}

/** "return:123" → shipment, "po:PO-0012" → PO, order numbers → order page. */
export function RefLink({ ref_ }: { ref_: string }) {
  const m = /^#?(\d{3,9})$/.exec(ref_);
  if (m) return <Link href={`/orders/${m[1]}`} className="font-semibold">#{m[1]}</Link>;
  const po = /^po:(.+)$/.exec(ref_);
  if (po) return <Link href={`/inventory/purchase-orders?q=${encodeURIComponent(po[1])}`} className="font-semibold">{po[1]}</Link>;
  const ret = /^return:(\d+)$/.exec(ref_);
  if (ret) return <span>Return parcel {ret[1]}</span>;
  return <span>{ref_}</span>;
}

function DetailsTab({ item, onChanged }: { item: ItemDetail; onChanged: (d?: ItemDetail) => void }) {
  const toast = useToast();
  const seed = useMemo(
    () => ({
      item_code: item.itemCode ?? '',
      alias: item.alias ?? '',
      category: item.category ?? '',
      shelf_location: item.shelfLocation ?? '',
      reorder_level: String(item.reorderLevel),
      reorder_qty: item.reorderQty != null ? String(item.reorderQty) : '',
      lead_time_days: item.leadTimeDays != null ? String(item.leadTimeDays) : '',
      notes: item.notes ?? '',
      track: item.track,
      allow_backorder: item.allowBackorder,
    }),
    [item],
  );
  const [f, setF] = useState(seed);
  useEffect(() => setF(seed), [seed]);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(seed);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const int = (s: string) => (s.trim() === '' ? null : Math.max(0, Math.trunc(Number(s) || 0)));

  const save = async () => {
    const patch: Record<string, unknown> = {};
    (Object.keys(f) as Array<keyof typeof f>).forEach((k) => {
      if (f[k] === seed[k]) return;
      if (k === 'reorder_level') patch[k] = int(f[k] as string) ?? 0;
      else if (k === 'reorder_qty' || k === 'lead_time_days') patch[k] = int(f[k] as string);
      else if (k === 'track' || k === 'allow_backorder') patch[k] = f[k];
      else patch[k] = (f[k] as string).trim() || null;
    });
    setSaving(true);
    try {
      const d = await updateItem(item.id, patch);
      toast.success('Saved');
      onChanged(d);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const field = (k: 'item_code' | 'alias' | 'category' | 'shelf_location', label: string, hint?: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`d-${k}`} className="text-xs font-bold text-ink">{label}</label>
      <input id={`d-${k}`} className={inputCls} value={f[k]} onChange={(e) => set(k, e.target.value)} />
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
  const num = (k: 'reorder_level' | 'reorder_qty' | 'lead_time_days', label: string, hint?: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`d-${k}`} className="text-xs font-bold text-ink">{label}</label>
      <input id={`d-${k}`} inputMode="numeric" className={inputCls} value={f[k]} onChange={(e) => set(k, e.target.value.replace(/[^0-9]/g, ''))} />
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {field('item_code', 'Item code', 'Your own code — agents can add it to an order by typing it.')}
        {field('alias', 'Alias')}
        {field('category', 'Category')}
        {field('shelf_location', 'Shelf', 'Printed on picklists and the pack station.')}
        {num('reorder_level', 'Reorder at', 'Shows as Low at or below this.')}
        {num('reorder_qty', 'Reorder in packs of')}
        {num('lead_time_days', 'Supplier lead time (days)')}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="d-notes" className="text-xs font-bold text-ink">Notes</label>
        <textarea id="d-notes" className={cn(inputCls, 'h-24 py-2')} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">
            <b>Track stock</b>
            <span className="block text-xs text-muted">Off for services or made-to-order items — never shows out of stock.</span>
          </span>
          <Switch checked={f.track} onChange={(v) => set('track', v)} label="Track stock" />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">
            <b>Allow selling when out of stock</b>
            <span className="block text-xs text-muted">Agents and the AI can still order it at 0.</span>
          </span>
          <Switch checked={f.allow_backorder} onChange={(v) => set('allow_backorder', v)} label="Allow backorder" />
        </div>
      </div>
      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line bg-surface py-3">
        <Button variant="ghost" disabled={!dirty || saving} onClick={() => setF(seed)}>Discard</Button>
        <Button onClick={save} loading={saving} disabled={!dirty}>Save details</Button>
      </div>
    </div>
  );
}
