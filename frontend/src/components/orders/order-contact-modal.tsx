'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { updateOrderAddress } from '@/lib/couriers';
import { COUNTRIES } from '@/lib/countries';

/**
 * Edit an order's customer + delivery details (name, phone, email, address) and
 * commit to Shopify via orderUpdate. Used from the order-detail drawer for
 * unfulfilled + unpaid orders.
 */
export function OrderContactModal({
  orderGid,
  initial,
  onClose,
  onSaved,
}: {
  orderGid: string;
  initial: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    countryCode?: string | null;
  };
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState({
    name: initial.name ?? '',
    phone: initial.phone ?? '',
    email: initial.email ?? '',
    address1: initial.address1 ?? '',
    address2: initial.address2 ?? '',
    city: initial.city ?? '',
    countryCode: initial.countryCode ?? 'PK',
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await updateOrderAddress({
        orderGid,
        name: f.name.trim() || undefined,
        phone: f.phone.trim() || undefined,
        email: f.email.trim() || undefined,
        address1: f.address1,
        address2: f.address2,
        city: f.city,
        countryCode: f.countryCode || undefined,
      });
      toast.success('Order details updated');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not update the order');
    } finally {
      setSaving(false);
    }
  };

  const input =
    'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';

  return (
    <Modal open onClose={onClose} title="Edit customer & delivery" size="md">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">Name</span>
            <input className={input} value={f.name} onChange={(e) => set('name', e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">Phone</span>
            <input className={input} value={f.phone} onChange={(e) => set('phone', e.target.value)} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Email</span>
          <input className={input} type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Address line 1</span>
          <input className={input} value={f.address1} onChange={(e) => set('address1', e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Address line 2</span>
          <input className={input} value={f.address2} onChange={(e) => set('address2', e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">City</span>
            <input className={input} value={f.city} onChange={(e) => set('city', e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">Country</span>
            <select className={input} value={f.countryCode} onChange={(e) => set('countryCode', e.target.value)}>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save & update Shopify
          </button>
        </div>
      </div>
    </Modal>
  );
}
