'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, PackageCheck, ScanLine } from 'lucide-react';
import { useToast } from '@/components/toast';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import ScanToFind from '@/components/orders/scan-to-find';
import { ApiError } from '@/lib/api';
import { markPacked, packLookup, packStats, type PackParcel } from '@/lib/commissions';
import { fmtDateTime, cn } from '@/lib/utils';

/**
 * Pack station: scan a parcel (camera or a USB scanner that types + Enter),
 * tick each item into the box, tap Packed. Stamps who packed it — the source of
 * packing commission — and keeps a running "you packed N today" counter.
 */
export default function PackStationPage() {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [parcel, setParcel] = useState<PackParcel | null>(null);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<{ packedToday: number; packedThisMonth: number } | null>(null);
  const [recent, setRecent] = useState<{ order: string; at: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    packStats().then(setStats).catch(() => undefined);
    inputRef.current?.focus();
  }, []);

  const lookup = useCallback(
    async (raw: string) => {
      const c = raw.trim();
      if (!c) return;
      setBusy(true);
      try {
        const p = await packLookup(c);
        setParcel(p);
        setChecked({});
      } catch (e) {
        setParcel(null);
        toast.error(e instanceof ApiError ? e.userMessage : 'Parcel not found');
      } finally {
        setBusy(false);
        setCode('');
        inputRef.current?.focus();
      }
    },
    [toast],
  );

  const allChecked = !!parcel && parcel.items.every((_, i) => checked[i]);

  const pack = async () => {
    if (!parcel) return;
    setBusy(true);
    try {
      const r = await markPacked(parcel.shipmentId);
      setStats({ packedToday: r.packedToday, packedThisMonth: r.packedThisMonth });
      setRecent((x) => [{ order: parcel.orderName ?? parcel.tracking ?? '', at: new Date().toISOString() }, ...x].slice(0, 8));
      toast.success(`${parcel.orderName ?? 'Parcel'} packed`);
      setParcel(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save');
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-lg font-bold text-ink">Pack station</h1>
          <p className="text-xs text-muted">Scan the courier label or type the order number.</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr_0.8fr]">
        <Card className="p-4 space-y-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void lookup(code);
            }}
            className="space-y-2"
          >
            <label htmlFor="pack-code" className="block text-xs font-semibold text-muted">
              Tracking or order number
            </label>
            <input
              id="pack-code"
              ref={inputRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              inputMode="text"
              placeholder="LE7841230955 or 51284"
              className="h-12 w-full rounded-xl border-2 border-brand-500 bg-brand-50 px-4 text-center font-mono text-lg text-ink focus:outline-none"
            />
            <div className="flex gap-2">
              <Button type="submit" className="flex-1" loading={busy} disabled={!code.trim()}>
                Find parcel
              </Button>
              <ScanToFind
                onScan={(c) => void lookup(c)}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-medium text-ink hover:bg-sunken"
              />
            </div>
          </form>
          {parcel && (
            <div className="rounded-xl bg-sunken p-3 text-sm space-y-1">
              <p className="font-mono text-base font-bold text-ink">{parcel.tracking ?? 'No tracking yet'}</p>
              <p className="text-ink">
                Order <b>{parcel.orderName}</b> · {parcel.courier}
              </p>
              <p className="text-muted">
                {parcel.customerName} · {parcel.city}
                {parcel.cod ? ` · COD Rs ${Math.round(parcel.cod).toLocaleString()}` : ' · Prepaid'}
              </p>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Items to pack"
            action={parcel ? <Badge tone={allChecked ? 'success' : 'warn'}>{Object.values(checked).filter(Boolean).length} of {parcel.items.length}</Badge> : undefined}
          />
          <CardBody>
            {!parcel ? (
              <EmptyState compact icon={ScanLine} title="Scan a parcel to start" description="Its items show here as a checklist." />
            ) : (
              <div className="space-y-3">
                {parcel.packedAt && (
                  <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    <AlertTriangle size={14} /> Already packed by {parcel.packedBy ?? 'someone'} on {fmtDateTime(parcel.packedAt)}. Packing again moves the credit to you.
                  </p>
                )}
                {['cancelled', 'returned', 'failed', 'delivered'].includes(parcel.status) && (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">This parcel is {parcel.status}. Do not pack it.</p>
                )}
                <ul className="divide-y divide-line">
                  {parcel.items.map((it, i) => (
                    <li key={i}>
                      <label className="flex cursor-pointer items-center gap-3 py-3">
                        <input
                          type="checkbox"
                          className="h-5 w-5 accent-[rgb(var(--brand-600))]"
                          checked={!!checked[i]}
                          onChange={(e) => setChecked((c) => ({ ...c, [i]: e.target.checked }))}
                        />
                        <span className={cn('flex-1 text-sm', checked[i] ? 'text-muted line-through' : 'text-ink')}>
                          {it.title}
                          {it.variant && <span className="text-muted"> · {it.variant}</span>}
                          {it.sku && <span className="ml-2 font-mono text-xs text-muted">{it.sku}</span>}
                        </span>
                        <b className="tabular-nums">× {it.quantity}</b>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setParcel(null)}>
                    Skip
                  </Button>
                  <span className="flex-1" />
                  {!allChecked && parcel.items.length > 0 && (
                    <Button variant="ghost" onClick={() => setChecked(Object.fromEntries(parcel.items.map((_, i) => [i, true])))}>
                      Tick all
                    </Button>
                  )}
                  <Button loading={busy} disabled={!allChecked && parcel.items.length > 0} onClick={pack}>
                    <PackageCheck size={16} /> Packed · next
                  </Button>
                </div>
              </div>
            )}
          </CardBody>
        </Card>

        <Card className="p-4 text-center space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">You packed today</p>
          <p className="text-5xl font-bold tabular-nums text-ink">{stats?.packedToday ?? '—'}</p>
          <p className="text-xs text-muted">{stats ? `${stats.packedThisMonth.toLocaleString()} this month` : ''}</p>
          {recent.length > 0 && (
            <ul className="mt-3 space-y-1 text-left text-xs">
              {recent.map((r) => (
                <li key={r.at} className="flex items-center gap-2 text-muted">
                  <CheckCircle2 size={12} className="text-brand-600" /> {r.order}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
