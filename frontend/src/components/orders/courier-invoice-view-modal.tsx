'use client';

import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { fmtDate } from '@/lib/utils';
import {
  courierInvoicePdf,
  getCourierInvoice,
  deductionGroup,
  type CourierDeductionComponent,
  type CourierInvoiceAdjustment,
  type CourierInvoiceTotals,
} from '@/lib/couriers';

interface InvoiceView {
  courierName: string;
  invoiceNumber: string | null;
  chequeNumber?: string | null;
  reportDate: string | null;
  currency: string | null;
  status: string;
  pdfUrl: string | null;
  totals: CourierInvoiceTotals;
  taxBreakdown: CourierDeductionComponent[] | null;
  adjustment: CourierInvoiceAdjustment | null;
}

/**
 * Read-only summary of an applied courier statement — the tax cards + deduction
 * breakup only, NOT the parcel-by-parcel detail. For a tenant who just wants to
 * see the money, without downloading the full PDF.
 */
export function CourierInvoiceViewModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [inv, setInv] = useState<InvoiceView | null>(null);
  const [err, setErr] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  // Re-render the PDF on download so courier invoice numbers imported after the
  // statement was applied show up (the stored pdf_url is an apply-time snapshot).
  const downloadPdf = async () => {
    const win = window.open('', '_blank');
    setPdfBusy(true);
    try {
      const { url } = await courierInvoicePdf(id);
      if (win) win.location.href = url;
      else window.open(url, '_blank');
    } catch {
      if (inv?.pdfUrl && win) win.location.href = inv.pdfUrl;
      else win?.close();
    } finally {
      setPdfBusy(false);
    }
  };

  useEffect(() => {
    let alive = true;
    getCourierInvoice(id)
      .then((r) => alive && setInv(r as unknown as InvoiceView))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [id]);

  const cur = inv?.currency ?? 'PKR';
  const money = (v: number) => `${cur} ${Math.round(v).toLocaleString()}`;
  const cards = (inv?.taxBreakdown ?? []).filter((t) => t.card !== false);
  const charges = (inv?.taxBreakdown ?? []).filter((t) => deductionGroup(t) === 'charges');
  const taxes = (inv?.taxBreakdown ?? []).filter((t) => deductionGroup(t) === 'taxes');
  const sum = (xs: CourierDeductionComponent[]) => xs.reduce((s, x) => s + x.amount, 0);

  return (
    <Modal open onClose={onClose} title="Settlement summary" size="md">
      {!inv && !err && (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {err && <p className="py-10 text-center text-sm text-gray-500">Could not load this statement.</p>}

      {inv && (
        <div className="space-y-5">
          {/* header */}
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-gray-100 pb-3">
            <div>
              <p className="text-lg font-bold text-gray-900">{inv.courierName}</p>
              <p className="text-xs text-gray-500">
                Invoice {inv.invoiceNumber ?? '—'}
                {inv.chequeNumber ? ` · Cheque ${inv.chequeNumber}` : ''}
              </p>
            </div>
            <p className="text-xs text-gray-500">
              {inv.reportDate ? fmtDate(inv.reportDate) : 'no statement date'}
            </p>
          </div>

          {/* headline tiles */}
          <div className="grid grid-cols-3 gap-2">
            <Tile label="COD collected" value={money(inv.totals.codCollected)} tone="ink" />
            <Tile label="Deductions" value={`- ${money(inv.totals.deductions)}`} tone="amber" />
            <Tile label="Net payable" value={money(inv.totals.netPayable)} tone="green" />
          </div>

          {/* tax cards */}
          {cards.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold text-gray-700">Taxes &amp; charges</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {cards.map((c, i) => (
                  <div key={i} className="rounded-lg border border-gray-200 p-2.5">
                    <p className="text-xs font-semibold text-indigo-900">{c.label}</p>
                    {c.sublabel && <p className="text-xs text-gray-400">{c.sublabel}</p>}
                    <p className="mt-1 text-sm font-bold text-gray-800">{money(c.amount)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* deduction breakup */}
          <div>
            <p className="mb-1.5 text-xs font-semibold text-gray-700">Deduction breakup</p>
            <div className="overflow-hidden rounded-lg border border-gray-200 text-sm">
              <Row label={`COD collected (${inv.totals.paidRows} delivered parcels)`} value={money(inv.totals.codCollected)} />
              {[
                { title: 'Service charges', items: charges },
                { title: 'Taxes', items: taxes },
              ]
                .filter((g) => g.items.length)
                .map((g) => (
                  <div key={g.title}>
                    <div className="border-t border-gray-100 bg-gray-50/70 px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                      {g.title}
                    </div>
                    {g.items.map((c, i) => (
                      <Row
                        key={i}
                        label={c.sublabel ? `${c.label} (${c.sublabel})` : c.label}
                        value={`- ${money(c.amount)}`}
                        amber
                        indent
                      />
                    ))}
                    <Row label={`Total ${g.title.toLowerCase()}`} value={`- ${money(sum(g.items))}`} strong />
                  </div>
                ))}
              <Row label="Total deductions" value={`- ${money(inv.totals.deductions)}`} strong />
              {inv.adjustment && inv.adjustment.amount !== 0 && (
                <Row
                  label={inv.adjustment.label || 'Manual adjustment'}
                  value={`${inv.adjustment.amount < 0 ? '- ' : '+ '}${money(Math.abs(inv.adjustment.amount))}`}
                  amber={inv.adjustment.amount < 0}
                />
              )}
              <Row label="Net payable" value={money(inv.totals.netPayable)} net />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            {inv.pdfUrl && (
              <button
                onClick={() => void downloadPdf()}
                disabled={pdfBusy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                {pdfBusy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Download full PDF
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-black"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone: 'ink' | 'amber' | 'green' }) {
  const color = tone === 'green' ? 'text-green-700' : tone === 'amber' ? 'text-amber-700' : 'text-gray-900';
  const bg = tone === 'green' ? 'bg-green-50' : 'bg-gray-50';
  return (
    <div className={`rounded-lg ${bg} px-3 py-2.5`}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-0.5 text-base font-bold ${color}`}>{value}</p>
    </div>
  );
}

function Row({
  label,
  value,
  amber,
  strong,
  net,
  indent,
}: {
  label: string;
  value: string;
  amber?: boolean;
  strong?: boolean;
  net?: boolean;
  indent?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between px-3 py-1.5 ${
        net ? 'bg-green-50' : strong ? 'bg-gray-50' : 'odd:bg-white even:bg-gray-50/40'
      }`}
    >
      <span className={`${strong || net ? 'font-semibold text-gray-800' : 'text-gray-600'} ${indent ? 'pl-3' : ''}`}>
        {label}
      </span>
      <span
        className={`font-medium ${net ? 'text-green-700' : amber ? 'text-amber-700' : 'text-gray-800'} ${
          strong || net ? 'font-bold' : ''
        }`}
      >
        {value}
      </span>
    </div>
  );
}
