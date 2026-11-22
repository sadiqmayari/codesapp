'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Factory, Plus } from 'lucide-react';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { SideSheet } from '@/components/ui/side-sheet';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { listSuppliers, saveSupplier, type Supplier } from '@/lib/inventory-ops';
import { inputCls, money } from '@/components/inventory/shared';

/** Suppliers: contact details, lead time, open orders and what you still owe. */
export default function SuppliersPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Supplier[] | null>(null);
  const [edit, setEdit] = useState<Supplier | 'new' | null>(null);
  useEffect(() => {
    listSuppliers().then(setRows).catch(() => setRows([]));
  }, []);
  const columns: Column<Supplier>[] = [
    { key: 'name', header: 'Supplier', render: (s) => <span className="font-bold">{s.name}</span>, sortValue: (s) => s.name },
    { key: 'contact', header: 'Contact', render: (s) => <span className="text-muted">{[s.contactName, s.phone].filter(Boolean).join(' · ') || '—'}</span> },
    { key: 'lead', header: 'Lead time', align: 'right', render: (s) => (s.leadTimeDays != null ? `${s.leadTimeDays} days` : '—') },
    { key: 'items', header: 'Items', align: 'right', render: (s) => s.items, sortValue: (s) => s.items },
    { key: 'open', header: 'Open orders', align: 'right', render: (s) => s.openOrders },
    {
      key: 'bal',
      header: 'You owe',
      align: 'right',
      sortValue: (s) => s.balance,
      render: (s) => <span className={s.balance > 0 ? 'font-bold text-amber-800' : 'text-muted'}>{s.balance > 0 ? money(s.balance) : '—'}</span>,
    },
    {
      key: 'po',
      header: '',
      render: (s) => (
        <span onClick={(e) => e.stopPropagation()} className="flex justify-end">
          <Link href={`/inventory/purchase-orders/new?supplier=${s.id}`}>
            <Button size="sm" variant="secondary">New PO</Button>
          </Link>
        </span>
      ),
    },
  ];
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-ink">Suppliers</h1>
          <p className="mt-1 text-sm text-muted">Who you buy from. Lead times drive the reorder suggestions.</p>
        </div>
        <Button onClick={() => setEdit('new')}>
          <Plus className="h-4 w-4" aria-hidden="true" /> Add supplier
        </Button>
      </header>
      <div className="rounded-2xl border border-line bg-surface p-3">
        <DataTable
          rows={rows ?? []}
          columns={columns}
          rowKey={(s) => s.id}
          loading={rows == null}
          onRowClick={(s) => setEdit(s)}
          maxHeight="none"
          emptyNode={<EmptyState icon={Factory} title="No suppliers yet" description="Add the people you buy stock from to raise purchase orders." />}
        />
      </div>
      <SupplierSheet
        value={edit}
        onClose={() => setEdit(null)}
        onSaved={(list) => {
          setRows(list);
          setEdit(null);
          toast.success('Supplier saved');
        }}
      />
    </div>
  );
}

function SupplierSheet({ value, onClose, onSaved }: { value: Supplier | 'new' | null; onClose: () => void; onSaved: (l: Supplier[]) => void }) {
  const toast = useToast();
  const cur = value && value !== 'new' ? value : null;
  const [f, setF] = useState({ name: '', contactName: '', phone: '', email: '', address: '', notes: '', leadTimeDays: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setF({
      name: cur?.name ?? '',
      contactName: cur?.contactName ?? '',
      phone: cur?.phone ?? '',
      email: cur?.email ?? '',
      address: cur?.address ?? '',
      notes: cur?.notes ?? '',
      leadTimeDays: cur?.leadTimeDays != null ? String(cur.leadTimeDays) : '',
    });
  }, [cur, value]);
  const field = (k: keyof typeof f, label: string, opts: { area?: boolean; numeric?: boolean } = {}) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`sup-${k}`} className="text-xs font-bold text-ink">{label}</label>
      {opts.area ? (
        <textarea id={`sup-${k}`} className={`${inputCls} h-24 py-2`} value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} />
      ) : (
        <input
          id={`sup-${k}`}
          className={inputCls}
          inputMode={opts.numeric ? 'numeric' : undefined}
          value={f[k]}
          onChange={(e) => setF((x) => ({ ...x, [k]: opts.numeric ? e.target.value.replace(/[^0-9]/g, '') : e.target.value }))}
        />
      )}
    </div>
  );
  const save = async (archived?: boolean) => {
    if (!f.name.trim()) return toast.error('Supplier name is required');
    setBusy(true);
    try {
      onSaved(
        await saveSupplier(cur?.id ?? null, {
          name: f.name.trim(),
          contactName: f.contactName || null,
          phone: f.phone || null,
          email: f.email || null,
          address: f.address || null,
          notes: f.notes || null,
          leadTimeDays: f.leadTimeDays === '' ? null : Number(f.leadTimeDays),
          ...(archived ? { archived: true } : {}),
        }),
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <SideSheet
      open={value != null}
      onClose={onClose}
      title={cur ? cur.name : 'New supplier'}
      footer={
        <div className="flex w-full justify-between gap-2">
          {cur ? <Button variant="ghost" onClick={() => void save(true)}>Archive</Button> : <span />}
          <span className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void save()} loading={busy}>Save</Button>
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {field('name', 'Name')}
        {field('contactName', 'Contact person')}
        <div className="grid gap-3 sm:grid-cols-2">
          {field('phone', 'Phone')}
          {field('email', 'Email')}
        </div>
        {field('address', 'Address')}
        {field('leadTimeDays', 'Usual lead time (days)', { numeric: true })}
        {field('notes', 'Notes', { area: true })}
      </div>
    </SideSheet>
  );
}
