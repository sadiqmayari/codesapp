'use client';

import { useEffect, useMemo, useState } from 'react';
import { Archive, Ban, Loader2, MapPin, Package, StickyNote, Tag, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import { CityAutocomplete } from '@/components/ui/city-autocomplete';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { archiveOrders, bulkCancelShipments, updateOrderAddress } from '@/lib/couriers';
import { setOrderTags, updateOrderNote } from '@/lib/orders';
import { COUNTRIES } from '@/lib/countries';
import { OrderItemsEditor } from './order-items-editor';

/**
 * The single "Edit order" sheet for the detail drawer — Items, Customer &
 * address, and Note & tags in one tabbed modal, replacing the old dropdown that
 * opened two separate modals. Each tab saves independently to its own endpoint;
 * the footer shows a live diff on the Items tab so an agent sees exactly what
 * will change on Shopify before saving.
 */

type Tab = 'items' | 'addr' | 'note';

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
  prepaid = false,
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
  /** Order already paid (outstanding 0) — item edits create a balance/refund. */
  prepaid?: boolean;
  initial: EditOrderInitial;
  /** Current Shopify tags from the live fetch; undefined = live not available. */
  tags?: string[];
  onClose: () => void;
  /** addressChanged lets the drawer clear an address_issue flag after a fix. */
  onSaved: (opts?: { addressChanged?: boolean }) => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>(canEditItems ? 'items' : 'addr');

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

  /* ── Cancel (reuses the tables' bulk-cancel: fully cancels + archives) ── */
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const doCancel = async () => {
    setCancelling(true);
    try {
      await bulkCancelShipments({ mode: 'cancel', orderGids: [orderGid] });
      toast.success('Cancelling order — it will drop out of the queue shortly');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not cancel');
    } finally {
      setCancelling(false);
      setConfirmCancel(false);
    }
  };

  /* ── Footer (per tab) ────────────────────────────────────────────────── */
  const footer =
    tab === 'items' ? null : tab === 'addr' ? (
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

      {/* ITEMS — shared editor (also used by the fulfillment queue) */}
      {tab === 'items' && (
        <OrderItemsEditor
          orderGid={orderGid}
          currency={currency}
          prepaid={prepaid}
          onClose={onClose}
          onSaved={() => onSaved()}
        />
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
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setConfirmCancel(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100"
              >
                <Ban size={13} /> Cancel order
              </button>
              <button
                onClick={() => setConfirmArchive(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                <Archive size={13} /> Archive
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-gray-400">
              <b className="font-semibold text-gray-500">Cancel</b> voids the order in Shopify and archives it (the
              same as the Orders board&apos;s cancel). <b className="font-semibold text-gray-500">Archive</b> just
              hides it from the active queue — it doesn&apos;t cancel or refund.
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
      {confirmCancel && (
        <ConfirmDialog
          open
          danger
          busy={cancelling}
          title="Cancel this order?"
          message={`This voids ${orderName ?? 'the order'} in Shopify and archives it. If it's already booked with a courier, that booking is cancelled too. This can't be undone from here.`}
          confirmLabel={cancelling ? 'Cancelling…' : 'Cancel order'}
          onConfirm={doCancel}
          onCancel={() => setConfirmCancel(false)}
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
