'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Copy, Download, ScanLine } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { cn, fmtDate, fmtDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { SkeletonRows } from '@/components/ui/skeleton';
import ScanToFind from '@/components/orders/scan-to-find';
import { getPO, poAction, PO_STATUS_META, receivePO, recordPoPayment, stockSearch, type PoDetail } from '@/lib/inventory-ops';
import { inputCls, money, parseMoney } from '@/components/inventory/shared';

type Html2PdfWorker = { set: (o: unknown) => Html2PdfWorker; from: (el: HTMLElement) => Html2PdfWorker; save: () => Promise<void> };
type Html2PdfFactory = () => Html2PdfWorker;

/** One purchase order: send, receive (scan or type), pay, PDF / copy for the supplier. */
export default function PurchaseOrderPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();
  const canManage = user?.role === 'owner' || user?.role === 'admin';
  const [po, setPo] = useState<PoDetail | null>(null);
  const [recv, setRecv] = useState<Record<number, string>>({});
  const [freight, setFreight] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'send' | 'cancel' | 'receive'>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [scan, setScan] = useState('');
  const sheetRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => getPO(id).then(setPo).catch(() => router.replace('/inventory/purchase-orders')), [id, router]);
  useEffect(() => {
    if (Number.isInteger(id)) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!po) return <div className="mx-auto max-w-5xl p-6"><SkeletonRows rows={6} /></div>;
  const open = ['draft', 'sent', 'partial'].includes(po.status);
  const toReceive = po.lines.map((l) => ({ itemId: l.itemId, qty: Number(recv[l.itemId] || 0) })).filter((l) => l.qty > 0);
  const units = toReceive.reduce((a, l) => a + l.qty, 0);

  const onScan = async (code: string) => {
    const c = code.trim();
    if (!c) return;
    const hits = await stockSearch(c).catch(() => []);
    const line = po.lines.find((l) => hits.some((h) => h.id === l.itemId) || l.sku === c);
    if (!line) {
      toast.error(`“${c}” is not on this order`);
    } else {
      setRecv((r) => ({ ...r, [line.itemId]: String((Number(r[line.itemId]) || 0) + 1) }));
    }
    setScan('');
  };

  const copyText = async () => {
    const text = [
      `Purchase order ${po.number}`,
      po.expectedAt ? `Needed by ${fmtDate(po.expectedAt)}` : null,
      `Deliver to: ${po.location}`,
      '',
      ...po.lines.map((l) => `• ${l.title}${l.sku ? ` (${l.sku})` : ''} × ${l.ordered}${l.unitCost ? ` @ ${money(l.unitCost)}` : ''}`),
      '',
      `Total: ${money(po.itemsTotal + po.freight)}`,
      po.notes ? `Notes: ${po.notes}` : null,
    ]
      .filter((x) => x != null)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied — paste it into WhatsApp or email');
    } catch {
      toast.error('Copy is blocked in this browser');
    }
  };

  const pdf = async () => {
    if (!sheetRef.current) return;
    const mod = await import('html2pdf.js');
    const html2pdf = ((mod as { default?: Html2PdfFactory })?.default ?? (mod as unknown as Html2PdfFactory)) as Html2PdfFactory;
    await html2pdf()
      .set({
        margin: [10, 10, 10, 10],
        filename: `${po.number}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      })
      .from(sheetRef.current)
      .save();
  };

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/inventory/purchase-orders" className="text-sm font-bold text-brand-700">← Purchase orders</Link>
          <h1 className="mt-1 text-2xl font-extrabold text-ink">
            {po.number}
            {po.supplier && <> · {po.supplier.name}</>}
          </h1>
          <p className="text-sm text-muted">
            Created {fmtDate(po.createdAt)}
            {po.expectedAt && <> · expected {fmtDate(po.expectedAt)}</>} · deliver to {po.location}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={PO_STATUS_META[po.status].tone}>{PO_STATUS_META[po.status].label}</Badge>
          <Button variant="secondary" onClick={() => void pdf()}><Download className="h-4 w-4" aria-hidden="true" /> PDF</Button>
          <Button variant="secondary" onClick={() => void copyText()}><Copy className="h-4 w-4" aria-hidden="true" /> Copy for supplier</Button>
          {canManage && po.status === 'draft' && <Button onClick={() => setConfirm('send')}>Mark as sent</Button>}
          {canManage && open && <Button variant="ghost" onClick={() => setConfirm('cancel')}>{po.status === 'partial' ? 'Close' : 'Cancel'}</Button>}
        </div>
      </header>

      <div className="flex flex-wrap gap-4">
        <section className="flex min-w-0 flex-[999_1_640px] flex-col rounded-2xl border border-line bg-surface">
          {open && (
            <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
              <h2 className="flex-1 text-sm font-extrabold text-ink">Receive items</h2>
              <form
                className="flex h-10 min-w-[220px] items-center gap-2 rounded-xl border-2 border-brand-500 px-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onScan(scan);
                }}
              >
                <ScanLine className="h-4 w-4 text-brand-600" aria-hidden="true" />
                <label htmlFor="po-scan" className="sr-only">Scan or type SKU — each scan adds 1</label>
                <input id="po-scan" value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Scan — each scan adds 1" className="flex-1 bg-transparent text-sm outline-none" />
              </form>
              <ScanToFind product label="Camera" onScan={(c) => void onScan(c)} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line px-3 text-sm font-semibold" />
              <Button
                variant="secondary"
                onClick={() => setRecv(Object.fromEntries(po.lines.map((l) => [l.itemId, String(Math.max(0, l.ordered - l.received))])))}
              >
                Receive all remaining
              </Button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-sunken text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2 text-right">Ordered</th>
                  <th className="px-3 py-2 text-right">Received</th>
                  {open && <th className="px-3 py-2 text-right">This delivery</th>}
                  <th className="px-3 py-2 text-right">Unit cost</th>
                  <th className="px-3 py-2 text-right">Current avg</th>
                </tr>
              </thead>
              <tbody>
                {po.lines.map((l) => {
                  const now = recv[l.itemId] ?? '';
                  const over = Number(now) > l.ordered - l.received;
                  return (
                    <tr key={l.itemId} className="border-t border-line">
                      <td className="px-3 py-2">
                        <div className="font-semibold text-ink">{l.title}</div>
                        <div className="font-mono text-xs text-muted">{l.sku ?? ''}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{l.ordered}</td>
                      <td className={cn('px-3 py-2 text-right tabular-nums', l.received >= l.ordered ? 'text-brand-700' : 'text-muted')}>{l.received}</td>
                      {open && (
                        <td className="px-3 py-2 text-right">
                          <label htmlFor={`rc-${l.itemId}`} className="sr-only">Arrived now for {l.title}</label>
                          <input
                            id={`rc-${l.itemId}`}
                            inputMode="numeric"
                            className={cn(inputCls, 'ml-auto h-9 w-20 text-right font-bold', Number(now) > 0 && 'border-brand-500 bg-brand-50', over && 'border-amber-500')}
                            value={now}
                            onChange={(e) => setRecv((r) => ({ ...r, [l.itemId]: e.target.value.replace(/[^0-9]/g, '') }))}
                          />
                          {over && <span className="block text-xs text-amber-800">more than ordered</span>}
                        </td>
                      )}
                      <td className="px-3 py-2 text-right tabular-nums">{money(l.unitCost)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">{money(l.currentCost)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {open && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-3">
              <div className="flex items-center gap-2 text-sm text-muted">
                <label htmlFor="rc-fr">Freight on this delivery</label>
                <input id="rc-fr" inputMode="decimal" className={cn(inputCls, 'h-9 w-28 text-right')} value={freight} onChange={(e) => setFreight(e.target.value)} placeholder="0" />
                <span>spread by value into unit cost</span>
              </div>
              <Button onClick={() => setConfirm('receive')} disabled={!units}>Receive {units} &amp; push to stores</Button>
            </div>
          )}
        </section>

        <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <section className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 text-sm">
            <h2 className="font-extrabold text-ink">Totals</h2>
            <div className="flex justify-between"><span className="text-muted">Items</span><b>{money(po.itemsTotal)}</b></div>
            <div className="flex justify-between"><span className="text-muted">Freight / landed</span><b>{money(po.freight)}</b></div>
            <div className="flex justify-between"><span className="text-muted">Paid to supplier</span><b>{money(po.paid)}</b></div>
            <div className="flex justify-between border-t border-line pt-2"><span className="font-bold">Balance due</span><b className={po.balance > 0 ? 'text-amber-800' : ''}>{money(po.balance)}</b></div>
            {canManage && po.status !== 'cancelled' && <Button size="sm" variant="secondary" onClick={() => setPayOpen(true)}>Record a payment</Button>}
          </section>
          <section className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 text-sm">
            <h2 className="font-extrabold text-ink">Deliveries</h2>
            {po.receipts.length ? (
              po.receipts.map((r) => (
                <div key={r.id} className="flex justify-between gap-2">
                  <span>{r.number} · {fmtDateTime(r.at)}</span>
                  <span className="text-muted">{r.units} units</span>
                </div>
              ))
            ) : (
              <p className="text-muted">Nothing received yet.</p>
            )}
          </section>
          {po.notes && (
            <section className="rounded-2xl border border-line bg-surface p-4 text-sm">
              <h2 className="font-extrabold text-ink">Notes</h2>
              <p className="mt-1 whitespace-pre-wrap text-muted">{po.notes}</p>
            </section>
          )}
        </aside>
      </div>

      {/* PDF sheet (light, off-screen) */}
      <div className="pointer-events-none fixed -left-[9999px] top-0" aria-hidden="true">
        <div ref={sheetRef} style={{ width: 760, padding: 32, background: '#fff', color: '#0E1A2B', fontFamily: 'Manrope, sans-serif', fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 24, fontWeight: 800 }}>Purchase order</div>
              <div style={{ color: '#475467' }}>{po.number} · {fmtDate(po.createdAt)}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 700 }}>{user?.company?.name ?? ''}</div>
              <div style={{ color: '#475467' }}>Deliver to: {po.location}</div>
              {po.expectedAt && <div style={{ color: '#475467' }}>Needed by {fmtDate(po.expectedAt)}</div>}
            </div>
          </div>
          {po.supplier && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 700 }}>Supplier</div>
              <div>{po.supplier.name}</div>
              {po.supplier.phone && <div>{po.supplier.phone}</div>}
              {po.supplier.email && <div>{po.supplier.email}</div>}
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 20 }}>
            <thead>
              <tr style={{ background: '#F2F4F7', textAlign: 'left' }}>
                <th style={{ padding: 8 }}>Item</th>
                <th style={{ padding: 8 }}>SKU</th>
                <th style={{ padding: 8, textAlign: 'right' }}>Qty</th>
                <th style={{ padding: 8, textAlign: 'right' }}>Unit cost</th>
                <th style={{ padding: 8, textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {po.lines.map((l) => (
                <tr key={l.itemId} style={{ borderTop: '1px solid #EAECF0' }}>
                  <td style={{ padding: 8 }}>{l.title}</td>
                  <td style={{ padding: 8 }}>{l.sku ?? ''}</td>
                  <td style={{ padding: 8, textAlign: 'right' }}>{l.ordered}</td>
                  <td style={{ padding: 8, textAlign: 'right' }}>{money(l.unitCost)}</td>
                  <td style={{ padding: 8, textAlign: 'right' }}>{money(l.unitCost * l.ordered)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12, textAlign: 'right' }}>
            <div>Freight: {money(po.freight)}</div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Total: {money(po.itemsTotal + po.freight)}</div>
          </div>
          {po.notes && <div style={{ marginTop: 16, whiteSpace: 'pre-wrap' }}>{po.notes}</div>}
        </div>
      </div>

      <ConfirmDialog
        open={confirm != null}
        title={confirm === 'send' ? 'Mark as sent?' : confirm === 'receive' ? `Receive ${units} units?` : po.status === 'partial' ? 'Close this order?' : 'Cancel this order?'}
        message={
          confirm === 'send'
            ? 'The ordered quantities show as incoming on each item.'
            : confirm === 'receive'
              ? `${units} units are added to ${po.location}, unit costs are updated and every linked store gets the new stock.`
              : 'Anything not yet received stops showing as incoming.'
        }
        confirmLabel={confirm === 'receive' ? 'Receive' : confirm === 'send' ? 'Mark as sent' : 'Confirm'}
        danger={confirm === 'cancel'}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setBusy(true);
          try {
            if (confirm === 'receive') {
              const f = parseMoney(freight);
              const next = await receivePO(id, { lines: toReceive, freight: f === 'invalid' ? 0 : f ?? 0 });
              setPo(next);
              setRecv({});
              setFreight('');
              toast.success(`Received ${units} units`);
            } else if (confirm === 'send') {
              setPo(await poAction(id, 'send'));
            } else if (confirm === 'cancel') {
              setPo(await poAction(id, 'cancel'));
            }
            setConfirm(null);
          } catch (e) {
            toast.error(e instanceof ApiError ? e.userMessage : 'Could not update the order');
          } finally {
            setBusy(false);
          }
        }}
      />
      <PaymentModal open={payOpen} onClose={() => setPayOpen(false)} onSave={async (amt) => { setPo(await recordPoPayment(id, amt)); setPayOpen(false); toast.success('Payment recorded'); }} />
    </div>
  );
}

function PaymentModal({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (amount: number) => Promise<void> }) {
  const toast = useToast();
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a payment to the supplier"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            loading={busy}
            onClick={async () => {
              const n = parseMoney(v);
              if (n === 'invalid' || !n) return toast.error('Enter an amount');
              setBusy(true);
              try {
                await onSave(n);
                setV('');
              } catch (e) {
                toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <label htmlFor="pay-amt" className="text-xs font-bold text-ink">Amount paid</label>
      <input id="pay-amt" inputMode="decimal" className={inputCls} value={v} onChange={(e) => setV(e.target.value)} />
    </Modal>
  );
}
