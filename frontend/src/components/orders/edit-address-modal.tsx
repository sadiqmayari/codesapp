'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { CityAutocomplete } from '@/components/ui/city-autocomplete';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { updateOrderAddress } from '@/lib/couriers';
import { COUNTRIES } from '@/lib/countries';

/**
 * The single shared "Edit address" form — name / phone / address / city /
 * country, committed to Shopify + the local mirror via updateOrderAddress. Used
 * from the order tables (the pencil on a To-book row) AND the order-detail
 * drawer, so there's one form, not two that drift apart.
 */
export function EditAddressModal({
  orderGid,
  orderName,
  initial,
  onClose,
  onSaved,
}: {
  orderGid: string;
  orderName?: string | null;
  initial?: {
    name?: string | null;
    phone?: string | null;
    address?: string | null;
    city?: string | null;
    countryCode?: string | null;
  };
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [address1, setAddress1] = useState(initial?.address ?? '');
  const [city, setCity] = useState(initial?.city ?? '');
  const [countryCode, setCountryCode] = useState(initial?.countryCode ?? 'PK');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!address1.trim() || !city.trim()) {
      toast.error('Address and city are required');
      return;
    }
    setBusy(true);
    try {
      await updateOrderAddress({
        orderGid,
        name: name.trim() || undefined,
        phone: phone.trim() || undefined,
        address1: address1.trim(),
        city: city.trim(),
        countryCode,
      });
      toast.success('Address updated in Shopify & CodesApp');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to update address');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Edit address — ${orderName ?? 'order'}`}>
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          Saving updates the shipping address on the Shopify order and here, so
          the courier books to the corrected address.
        </p>
        <Field label="Customer name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Phone">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+92…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Address">
          <textarea
            value={address1}
            onChange={(e) => setAddress1(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="City">
            <CityAutocomplete value={city} onChange={setCity} inputClassName="text-base" />
          </Field>
          <Field label="Country">
            <select
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save address'}
          </button>
        </div>
      </div>
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
