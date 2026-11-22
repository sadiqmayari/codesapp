'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Trash2, Truck } from 'lucide-react';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { getLocations, type InventoryLocation } from '@/lib/inventory';
import { createTransfer, listTransfers, transferAction, type StockHit, type TransferSummary } from '@/lib/inventory-ops';
import { ItemPicker } from '@/components/inventory/item-picker';
import { inputCls, itemName } from '@/components/inventory/shared';

const STATUS: Record<TransferSummary['status'], { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  in_transit: { label: 'In transit', tone: 'info' },
  received: { label: 'Received', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

/** Move stock between your locations: send (leaves the source) → receive (arrives). */
export default function TransfersPage() {
  const toast = useToast();
  const [rows, setRows] = useState<TransferSummary[] | null>(null);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [open, setOpen] = useState(false);
  const [act, setAct] = useState<{ t: TransferSummary; action: 'send' | 'receive' | 'cancel' } | null>(null);
  const load = () => listTransfers().then(setRows).catch(() => setRows([]));
  useEffect(() => {
    void load();
    getLocations().then(setLocations).catch(() => undefined);
  }, []);

  const columns: Column<TransferSummary>[] = [
    { key: 'n', header: 'Transfer', render: (t) => <span className="font-bold">{t.number}</span> },
    {
      key: 'route',
      header: 'Route',
      render: (t) => (
        <span className="inline-flex items-center gap-1.5">
          {t.from} <ArrowRight className="h-3.5 w-3.5 text-muted" aria-hidden="true" /> {t.to}
        </span>
      ),
    },
    { key: 'units', header: 'Units', align: 'right', render: (t) => `${t.units} (${t.lines} items)` },
    { key: 'status', header: 'Status', render: (t) => <Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge> },
    { key: 'at', header: 'Created', render: (t) => <span className="text-muted">{fmtDateTime(t.createdAt)}</span> },
    {
      key: 'act',
      header: '',
      render: (t) => (
        <span className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
          {t.status === 'draft' && <Button size="sm" onClick={() => setAct({ t, action: 'send' })}>Send</Button>}
          {t.status === 'in_transit' && <Button size="sm" onClick={() => setAct({ t, action: 'receive' })}>Mark received</Button>}
          {(t.status === 'draft' || t.status === 'in_transit') && (
            <Button size="sm" variant="ghost" onClick={() => setAct({ t, action: 'cancel' })}>Cancel</Button>
          )}
        </span>
      ),
    },
  ];

  const msg = (a: NonNullable<typeof act>) =>
    a.action === 'send'
      ? `${a.t.units} units leave ${a.t.from} now and show as in transit.`
      : a.action === 'receive'
        ? `${a.t.units} units are added to ${a.t.to}.`
        : a.t.status === 'in_transit'
          ? `The units go back to ${a.t.from}.`
          : 'The draft is discarded.';

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-ink">Transfers</h1>
          <p className="mt-1 text-sm text-muted">Move stock between locations. Stores fed by each location update automatically.</p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={locations.length < 2}>
          <Truck className="h-4 w-4" aria-hidden="true" /> New transfer
        </Button>
      </header>
      {locations.length < 2 && (
        <p className="rounded-xl border border-line bg-sunken px-4 py-3 text-sm text-muted">Add a second location in Settings → Inventory to move stock between them.</p>
      )}
      <div className="rounded-2xl border border-line bg-surface p-3">
        <DataTable
          rows={rows ?? []}
          columns={columns}
          rowKey={(t) => t.id}
          loading={rows == null}
          maxHeight="none"
          emptyNode={<EmptyState icon={Truck} title="No transfers yet" />}
        />
      </div>
      <NewTransfer open={open} locations={locations} onClose={() => setOpen(false)} onDone={() => { setOpen(false); void load(); }} />
      <ConfirmDialog
        open={!!act}
        title={act ? `${act.action === 'send' ? 'Send' : act.action === 'receive' ? 'Receive' : 'Cancel'} ${act.t.number}?` : ''}
        message={act ? msg(act) : ''}
        confirmLabel={act?.action === 'cancel' ? 'Cancel transfer' : 'Confirm'}
        danger={act?.action === 'cancel'}
        onCancel={() => setAct(null)}
        onConfirm={async () => {
          if (!act) return;
          try {
            await transferAction(act.t.id, act.action);
            toast.success('Done');
            void load();
          } catch (e) {
            toast.error(e instanceof ApiError ? e.userMessage : 'Could not update');
          }
          setAct(null);
        }}
      />
    </div>
  );
}

function NewTransfer({ open, locations, onClose, onDone }: { open: boolean; locations: InventoryLocation[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Array<{ item: StockHit; qty: string }>>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setFrom(locations[0]?.id ?? 0);
      setTo(locations[1]?.id ?? 0);
      setLines([]);
      setNote('');
    }
  }, [open, locations]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="New transfer"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            loading={busy}
            disabled={!lines.length || from === to}
            onClick={async () => {
              setBusy(true);
              try {
                await createTransfer({
                  fromLocationId: from,
                  toLocationId: to,
                  note: note.trim() || undefined,
                  lines: lines.map((l) => ({ itemId: l.item.id, qty: Math.max(1, Number(l.qty) || 1) })),
                });
                toast.success('Transfer saved as draft — send it when it leaves');
                onDone();
              } catch (e) {
                toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
              } finally {
                setBusy(false);
              }
            }}
          >
            Save transfer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="tr-from" className="text-xs font-bold text-ink">From</label>
            <select id="tr-from" className={inputCls} value={from} onChange={(e) => setFrom(Number(e.target.value))}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="tr-to" className="text-xs font-bold text-ink">To</label>
            <select id="tr-to" className={inputCls} value={to} onChange={(e) => setTo(Number(e.target.value))}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        </div>
        {from === to && <p className="text-sm font-semibold text-red-700">Pick two different locations.</p>}
        <ItemPicker exclude={new Set(lines.map((l) => l.item.id))} onPick={(it) => setLines((ls) => [...ls, { item: it, qty: '1' }])} />
        {lines.map((l, i) => (
          <div key={l.item.id} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{itemName(l.item)}</span>
            <label htmlFor={`tr-q-${l.item.id}`} className="sr-only">Quantity</label>
            <input
              id={`tr-q-${l.item.id}`}
              className={`${inputCls} w-20 text-right`}
              inputMode="numeric"
              value={l.qty}
              onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/[^0-9]/g, '') } : x)))}
            />
            <Button size="sm" variant="ghost" aria-label="Remove" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <div className="flex flex-col gap-1">
          <label htmlFor="tr-note" className="text-xs font-bold text-ink">Note (optional)</label>
          <input id="tr-note" className={inputCls} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}
