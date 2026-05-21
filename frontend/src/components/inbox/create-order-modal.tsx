'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';

interface LineItem {
  title: string;
  quantity: string;
  price: string;
}

interface CreatedOrder {
  orderId: string;
  orderName: string;
  adminUrl: string;
}

/**
 * Agent-driven "Create Shopify order" popup, opened from a chat. Creates a
 * real (payment-pending) order in the merchant's store via
 * POST /shopify/orders. Customer name/phone are prefilled from the contact.
 */
export default function CreateOrderModal({
  contactName,
  contactPhone,
  onClose,
}: {
  contactName?: string | null;
  contactPhone?: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<LineItem[]>([
    { title: '', quantity: '1', price: '' },
  ]);
  const [customerName, setCustomerName] = useState(contactName ?? '');
  const [phone, setPhone] = useState(contactPhone ?? '');
  const [email, setEmail] = useState('');
  const [address1, setAddress1] = useState('');
  const [city, setCity] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedOrder | null>(null);

  const setItem = (i: number, patch: Partial<LineItem>) =>
    setItems((cur) => cur.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const addItem = () =>
    setItems((cur) => [...cur, { title: '', quantity: '1', price: '' }]);
  const removeItem = (i: number) =>
    setItems((cur) => (cur.length > 1 ? cur.filter((_, idx) => idx !== i) : cur));

  const validItems = items
    .map((it) => ({
      title: it.title.trim(),
      quantity: parseInt(it.quantity, 10),
      price: parseFloat(it.price),
    }))
    .filter(
      (it) =>
        it.title &&
        Number.isFinite(it.quantity) &&
        it.quantity > 0 &&
        Number.isFinite(it.price) &&
        it.price >= 0,
    );

  const total = validItems.reduce((s, it) => s + it.price * it.quantity, 0);
  const canSubmit = validItems.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = await apiFetch<CreatedOrder>('/shopify/orders', {
        method: 'POST',
        body: {
          lineItems: validItems,
          customerName: customerName.trim() || undefined,
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          address1: address1.trim() || undefined,
          city: city.trim() || undefined,
          note: note.trim() || undefined,
        },
      });
      setCreated(res);
      toast.success(`Order ${res.orderName} created in Shopify`);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to create order',
      );
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Modal open onClose={onClose} title="Order created">
        <div className="space-y-3 text-sm">
          <p className="text-gray-700">
            Shopify order{' '}
            <span className="font-semibold">{created.orderName}</span> was
            created (payment pending).
          </p>
          <a
            href={created.adminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-green-700 underline"
          >
            Open in Shopify admin
          </a>
          <div className="pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700"
            >
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Create Shopify order"
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create order'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-gray-600">
              Line items
            </label>
            <button
              type="button"
              onClick={addItem}
              className="text-xs text-green-700 hover:underline flex items-center gap-1"
            >
              <Plus size={14} /> Add item
            </button>
          </div>
          <div className="space-y-2">
            {items.map((it, i) => (
              <div key={i} className="flex items-start gap-2">
                <input
                  value={it.title}
                  onChange={(e) => setItem(i, { title: e.target.value })}
                  placeholder="Product / description"
                  className="flex-1 min-w-0 border border-gray-300 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <input
                  value={it.quantity}
                  onChange={(e) =>
                    setItem(i, { quantity: e.target.value.replace(/\D/g, '') })
                  }
                  inputMode="numeric"
                  placeholder="Qty"
                  className="w-16 border border-gray-300 rounded-lg px-2 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <input
                  value={it.price}
                  onChange={(e) =>
                    setItem(i, {
                      price: e.target.value.replace(/[^0-9.]/g, ''),
                    })
                  }
                  inputMode="decimal"
                  placeholder="Price"
                  className="w-24 border border-gray-300 rounded-lg px-2 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <button
                  type="button"
                  onClick={() => removeItem(i)}
                  disabled={items.length === 1}
                  className="p-2 text-gray-400 hover:text-red-600 disabled:opacity-30"
                  aria-label="Remove item"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
          {total > 0 && (
            <p className="text-right text-sm text-gray-600 mt-1">
              Subtotal: <span className="font-semibold">{total.toFixed(2)}</span>
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Customer name" value={customerName} onChange={setCustomerName} />
          <Field label="Phone" value={phone} onChange={setPhone} />
          <Field label="Email (optional)" value={email} onChange={setEmail} type="email" />
          <Field label="City" value={city} onChange={setCity} />
          <div className="sm:col-span-2">
            <Field label="Address" value={address1} onChange={setAddress1} />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Note (optional)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Internal note on the order"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>
        <p className="text-[11px] text-gray-400">
          Creates a payment-pending order in your connected Shopify store.
        </p>
      </div>
    </Modal>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
      />
    </div>
  );
}
