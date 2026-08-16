'use client';

import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { fmtDate } from '@/lib/utils';
import {
  getCourierInvoice,
  type CourierDeductionComponent,
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
}

/**
 * Read-only summary of an applied courier statement — the tax cards + deduction
 * breakup only, NOT the parcel-by-parcel detail. For a tenant who just wants to
 * see the money, without downloading the full PDF.
 */
export function CourierInvoiceViewModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [inv, setInv] = useState<InvoiceView | null>(null);
  const [err, setErr] = useState(false);

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
                    <p className="text-[11px] font-semibold text-indigo-900">{c.label}</p>
                    {c.sublabel && <p className="text-[10px] text-gray-400">{c.sublabel}</p>}
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
              {(inv.taxBreakdown ?? []).map((c, i) => (
                <Row
                  key={i}
                  label={c.sublabel ? `${c.label} (${c.sublabel})` : c.label}
                  value={`- ${money(c.amount)}`}
                  amber
                />
              ))}
              <Row label="Total deductions" value={`- ${money(inv.totals.deductions)}`} strong />
              <Row label="Net payable" value={money(inv.totals.netPayable)} net />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            {inv.pdfUrl && (
              <a
                href={inv.pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                <Download size={14} /> Download full PDF
              </a>
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
      <p className="text-[11px] text-gray-500">{label}</p>
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
}: {
  label: string;
  value: string;
  amber?: boolean;
  strong?: boolean;
  net?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between px-3 py-1.5 ${
        net ? 'bg-green-50' : strong ? 'bg-gray-50' : 'odd:bg-white even:bg-gray-50/40'
      }`}
    >
      <span className={`${strong || net ? 'font-semibold text-gray-800' : 'text-gray-600'}`}>{label}</span>
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
