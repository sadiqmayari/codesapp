'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Loader2,
  MapPin,
  Minus,
  Package,
  Percent,
  Plus,
  Search,
  StickyNote,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { CityAutocomplete } from '@/components/ui/city-autocomplete';
import { ConfirmDialog } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import {
  archiveOrders,
  editOrderItems,
  getOrderEditable,
  updateOrderAddress,
  type EditableLineItem,
} from '@/lib/couriers';
import { setOrderTags, updateOrderNote } from '@/lib/orders';
import { COUNTRIES } from '@/lib/countries';

/**
 * The single "Edit order" sheet for the detail drawer — Items, Customer &
 * address, and Note & tags in one tabbed modal, replacing the old dropdown that
 * opened two separate modals. Each tab saves independently to its own endpoint;
 * the footer shows a live diff on the Items tab so an agent sees exactly what
 * will change on Shopify before saving.
 */

type Tab = 'items' | 'addr' | 'note';
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
  originalQuantity: number;
  isNew: boolean;
  discType: DiscType;
  discValue: string;
}

export interface EditOrderInitial {
  name: string | null;
  phone: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  note: string | null;
}

export function EditOrderModal({
  orderGid,
  orderName,
  currency = 'Rs',
  canEditItems,
  canEditAddress,
  initial,
  tags,
  onClose,
  onSaved,
}: {
  orderGid: string;
  orderName: string | null;
  currency?: string;
  canEditItems: boolean;
  canEditAddress: boolean;
  initial: EditOrderInitial;
  /** Current Shopify tags from the live fetch; undefined = live not available. */
  tags?: string[];
  onClose: () => void;
  /** addressChanged lets the drawer clear an address_issue flag after a fix. */
  onSaved: (opts?: { addressChanged?: boolean }) => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>(canEditItems ? 'items' : 'addr');
  const money = (v: number) => `${currency} ${Math.round(v).toLocaleString()}`;

  /* ── Items state ─────────────────────────────────────────────────────── */
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsEditable, setItemsEditable] = useState(canEditItems);
  const [lines, setLines] = useState<WorkingLine[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductVariant[]>([]);
  const [searching, setSearching] = useState(false);
  const [openDisc, setOpenDisc] = useState<Record<number, boolean>>({});
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!canEditItems) {
      setItemsLoading(false);
      return;
    }
    (async () => {
      try {
        const res = await getOrderEditable(orderGid);
        setItemsEditable(res.editable);
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
        setItemsEditable(false);
      } finally {
        setItemsLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderGid, canEditItems]);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await apiFetch<ProductVariant[]>('/shopify/products', { params: { query: q } });
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
  const itemsDirty = addedN > 0 || removedN > 0 || qtyChg || discChg;

  const [savingItems, setSavingItems] = useState(false);
  const saveItems = async () => {
    const discOf = (l: WorkingLine) =>
      hasDisc(l) ? { type: l.discType, value: parseFloat(l.discValue) } : undefined;
    const updates = lines
      .filter((l) => !l.isNew && (l.quantity !== l.originalQuantity || hasDisc(l)))
      .map((l) => ({ variantId: l.variantId, title: l.title, quantity: l.quantity, discount: discOf(l) }));
    const adds = lines
      .filter((l) => l.isNew && l.quantity > 0 && l.variantId)
      .map((l) => ({ variantId: l.variantId as string, quantity: l.quantity, discount: discOf(l) }));
    if (!updates.length && !adds.length) return;
    setSavingItems(true);
    try {
      await editOrderItems(orderGid, { updates, adds });
      toast.success('Order items updated in Shopify');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to update items');
    } finally {
      setSavingItems(false);
    }
  };

  /* ── Address state ───────────────────────────────────────────────────── */
  const [name, setName] = useState(initial.name ?? '');
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [email, setEmail] = useState(initial.email ?? '');
  const [address1, setAddress1] = useState(
    [initial.address1, initial.address2].filter(Boolean).join(', '),
  );
  const [city, setCity] = useState(initial.city ?? '');
  const [countryCode, setCountryCode] = useState(
    (initial.countryCode ?? 'PK').toUpperCase().slice(0, 2) || 'PK',
  );
  const addrDirty =
    name !== (initial.name ?? '') ||
    phone !== (initial.phone ?? '') ||
    email !== (initial.email ?? '') ||
    address1 !== [initial.address1, initial.address2].filter(Boolean).join(', ') ||
    city !== (initial.city ?? '') ||
    countryCode !== ((initial.countryCode ?? 'PK').toUpperCase().slice(0, 2) || 'PK');

  const [savingAddr, setSavingAddr] = useState(false);
  const saveAddress = async () => {
    if (!address1.trim() || !city.trim()) {
      toast.error('Address and city are required');
      return;
    }
    setSavingAddr(true);
    try {
      await updateOrderAddress({
        orderGid,
        name: name.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        address1: address1.trim(),
        city: city.trim(),
        countryCode,
      });
      toast.success('Customer & address updated in Shopify & CodesApp');
      onSaved({ addressChanged: true });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to update address');
    } finally {
      setSavingAddr(false);
    }
  };

  /* ── Note & tags state ───────────────────────────────────────────────── */
  const [note, setNote] = useState(initial.note ?? '');
  const noteDirty = note.trim() !== (initial.note ?? '').trim();

  const initialTags = useMemo(() => (Array.isArray(tags) ? tags.filter(Boolean) : []), [tags]);
  const [tagList, setTagList] = useState<string[]>(initialTags);
  const [tagDraft, setTagDraft] = useState('');
  useEffect(() => setTagList(initialTags), [initialTags]);
  const tagsDirty =
    tags !== undefined &&
    (tagList.length !== initialTags.length ||
      tagList.some((t) => !initialTags.includes(t)) ||
      initialTags.some((t) => !tagList.includes(t)));

  const addTag = () => {
    const t = tagDraft.trim();
    if (!t) return;
    if (!tagList.some((x) => x.toLowerCase() === t.toLowerCase())) setTagList((p) => [...p, t]);
    setTagDraft('');
  };
  const removeTag = (t: string) => setTagList((p) => p.filter((x) => x !== t));

  const [savingNote, setSavingNote] = useState(false);
  const saveNoteTags = async () => {
    setSavingNote(true);
    try {
      if (noteDirty) await updateOrderNote(orderGid, note);
      if (tagsDirty) {
        const add = tagList.filter((t) => !initialTags.includes(t));
        const remove = initialTags.filter((t) => !tagList.includes(t));
        await setOrderTags(orderGid, add, remove);
      }
      toast.success('Saved');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    } finally {
      setSavingNote(false);
    }
  };

  /* ── Archive ─────────────────────────────────────────────────────────── */
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const doArchive = async () => {
    setArchiving(true);
    try {
      await archiveOrders([orderGid], true);
      toast.success('Order archived');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not archive');
    } finally {
      setArchiving(false);
      setConfirmArchive(false);
    }
  };

  /* ── Footer (per tab) ────────────────────────────────────────────────── */
  const footer =
    tab === 'items' ? (
      <div className="flex w-full items-center gap-3">
        <div className="min-w-0 flex-1 text-xs text-gray-500">
          {!itemsDirty ? (
            'No changes yet'
          ) : (
            <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <b className="font-semibold text-gray-700">{money(origTotal)}</b>
              <span className="text-gray-300">→</span>
              <b className="font-semibold text-green-700">{money(newTotal)}</b>
              <span className="text-gray-400">
                ·{' '}
                {[
                  addedN && `+${addedN} item${addedN > 1 ? 's' : ''}`,
                  removedN && `−${removedN} removed`,
                  qtyChg && 'qty changed',
                  discChg && 'discount',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
          )}
        </div>
        <button onClick={onClose} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
          Close
        </button>
        <button
          onClick={saveItems}
          disabled={savingItems || !itemsDirty || !itemsEditable}
          className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
        >
          {savingItems && <Loader2 size={14} className="animate-spin" />}
          Save to Shopify
        </button>
      </div>
    ) : tab === 'addr' ? (
      <div className="flex w-full items-center justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
          Close
        </button>
        <button
          onClick={saveAddress}
          disabled={savingAddr || !addrDirty}
          className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
        >
          {savingAddr && <Loader2 size={14} className="animate-spin" />}
          Save customer &amp; address
        </button>
      </div>
    ) : (
      <div className="flex w-full items-center justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
          Close
        </button>
        <button
          onClick={saveNoteTags}
          disabled={savingNote || (!noteDirty && !tagsDirty)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
        >
          {savingNote && <Loader2 size={14} className="animate-spin" />}
          Save note &amp; tags
        </button>
      </div>
    );

  const TabBtn = ({ id, icon, label }: { id: Tab; icon: React.ReactNode; label: string }) => (
    <button
      onClick={() => setTab(id)}
      className={cn(
        'relative inline-flex items-center gap-1.5 px-3 pb-2.5 pt-1 text-sm font-medium',
        tab === id ? 'text-gray-900' : 'text-gray-500 hover:text-gray-700',
      )}
    >
      {icon} {label}
      {tab === id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-indigo-600" />}
    </button>
  );

  return (
    <Modal open onClose={onClose} title={`Edit order — ${orderName ?? 'order'}`} size="lg" footer={footer}>
      <div className="-mt-1 mb-3 flex gap-1 border-b border-gray-200">
        {canEditItems && <TabBtn id="items" icon={<Package size={14} />} label="Items" />}
        {canEditAddress && <TabBtn id="addr" icon={<MapPin size={14} />} label="Customer & address" />}
        <TabBtn id="note" icon={<StickyNote size={14} />} label="Note & tags" />
      </div>

      {/* ITEMS */}
      {tab === 'items' && (
        <div>
          {itemsLoading ? (
            <div className="flex items-center justify-center py-12 text-gray-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : !itemsEditable ? (
            <div className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
              This order is already fulfilled — its items can no longer be edited.
            </div>
          ) : (
            <div className="space-y-3">
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
                        <span className="text-xs text-gray-500">{currency} {v.price}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {discChg && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                  Discounts apply on top of the current order — set a line&apos;s discount once; re-editing an
                  already-discounted line adds another.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ADDRESS */}
      {tab === 'addr' && (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            Saving updates the shipping address on the Shopify order and here, so the courier books to the
            corrected address.
          </p>
          <Field label="Customer name">
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Phone">
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+92…" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </Field>
            <Field label="Email">
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Add email — links the Shopify customer"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
          </div>
          <Field label="Address">
            <textarea value={address1} onChange={(e) => setAddress1(e.target.value)} rows={2} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City">
              <CityAutocomplete value={city} onChange={setCity} inputClassName="text-base" />
            </Field>
            <Field label="Country">
              <select value={countryCode} onChange={(e) => setCountryCode(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      )}

      {/* NOTE & TAGS */}
      {tab === 'note' && (
        <div className="space-y-4">
          <Field label="Internal note (CodesApp only — never sent to Shopify or the customer)">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Visible to your team only."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>

          <div>
            <label className="mb-1 block text-xs text-gray-500">Shopify tags</label>
            {tags === undefined ? (
              <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-400">
                Live Shopify data isn&apos;t available right now — reopen once the order&apos;s live panel has
                loaded to edit tags.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {tagList.length === 0 && <span className="text-xs text-gray-400">No tags yet.</span>}
                  {tagList.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 py-1 pl-3 pr-1.5 text-xs font-medium text-indigo-700">
                      <Tag size={11} /> {t}
                      <button onClick={() => removeTag(t)} className="rounded-full p-0.5 hover:bg-indigo-100" aria-label={`Remove ${t}`}>
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addTag();
                      }
                    }}
                    placeholder="Add a tag…"
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <button
                    onClick={addTag}
                    disabled={!tagDraft.trim()}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-gray-400">
                  The automatic confirm / cancel / no-response tags keep working — these are extra tags you set by
                  hand. Other tags on the order are left untouched.
                </p>
              </>
            )}
          </div>

          <div className="border-t border-gray-200 pt-3">
            <button
              onClick={() => setConfirmArchive(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50"
            >
              <Archive size={13} /> Archive this order
            </button>
            <p className="mt-1.5 text-[11px] text-gray-400">
              Archiving hides the order from the active queue in both Shopify and CodesApp. It does not cancel or
              refund it.
            </p>
          </div>
        </div>
      )}

      {confirmArchive && (
        <ConfirmDialog
          open
          danger
          busy={archiving}
          title="Archive this order?"
          message={`This hides ${orderName ?? 'the order'} from the active queue in Shopify and CodesApp. It does not cancel or refund it — you can un-archive it from Shopify later.`}
          confirmLabel={archiving ? 'Archiving…' : 'Archive'}
          onConfirm={doArchive}
          onCancel={() => setConfirmArchive(false)}
        />
      )}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-gray-500">{label}</label>
      {children}
    </div>
  );
}
