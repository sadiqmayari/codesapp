'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ScanLine } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/modal';
import { SkeletonRows } from '@/components/ui/skeleton';
import ScanToFind from '@/components/orders/scan-to-find';
import { applyCount, cancelCount, getCount, scanCount, setCountLine, type CountDetail } from '@/lib/inventory-ops';
import { ItemPicker } from '@/components/inventory/item-picker';
import { inputCls, money } from '@/components/inventory/shared';

/** One count: scan (USB scanner = types + Enter, or camera) → review → apply. */
export default function CountPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();
  const canManage = user?.role === 'owner' || user?.role === 'admin';
  const [c, setC] = useState<CountDetail | null>(null);
  const [code, setCode] = useState('');
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<null | 'apply' | 'cancel'>(null);
  const [busy, setBusy] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => getCount(id).then(setC).catch(() => router.replace('/inventory/counts')), [id, router]);
  useEffect(() => {
    if (Number.isInteger(id)) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const scan = async (value: string, itemId?: number) => {
    const v = value.trim();
    if (!v && !itemId) return;
    try {
      const next = await scanCount(id, itemId ? { itemId } : { code: v });
      setC(next);
      const hit = next.lines[0];
      setFlash({ ok: true, text: `${hit?.title ?? 'Item'} → ${hit?.counted ?? 1}` });
    } catch (e) {
      setFlash({ ok: false, text: e instanceof ApiError ? e.userMessage : 'Not found' });
    }
    setCode('');
    scanRef.current?.focus();
  };

  if (!c) return <div className="mx-auto max-w-5xl p-6"><SkeletonRows rows={6} /></div>;
  const open = c.status === 'draft';
  const counted = c.lines.filter((l) => l.counted != null);
  const varianceUnits = counted.reduce((a, l) => a + (l.variance ?? 0), 0);
  const varianceValue = counted.reduce((a, l) => a + (l.variance ?? 0) * (l.unitCost ?? 0), 0);
  const changes = counted.filter((l) => l.variance).length;

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/inventory/counts" className="text-sm font-bold text-brand-700">← Counts</Link>
          <h1 className="mt-1 text-2xl font-extrabold text-ink">
            {c.number} · {c.location}
          </h1>
          <p className="text-sm text-muted">
            {c.scope ?? 'Anything you scan'} · {c.blind ? 'Blind count (expected hidden from counters)' : 'Open count'}
          </p>
        </div>
        <div className="flex gap-2">
          {open && canManage && <Button variant="ghost" onClick={() => setConfirm('cancel')}>Cancel count</Button>}
          {open && canManage && (
            <Button onClick={() => setConfirm('apply')} disabled={!counted.length}>
              Apply {changes} change{changes === 1 ? '' : 's'}
            </Button>
          )}
          {!open && <Badge tone={c.status === 'applied' ? 'success' : 'danger'}>{c.status === 'applied' ? 'Applied' : 'Cancelled'}</Badge>}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Lines counted" value={`${counted.length} / ${c.lines.length}`} />
        <Stat label="Matches" value={counted.filter((l) => l.variance === 0).length} />
        <Stat label="Variance units" value={c.lines.some((l) => l.variance != null) ? varianceUnits : '—'} tone={varianceUnits < 0 ? 'danger' : undefined} />
        <Stat label="Variance value" value={c.lines.some((l) => l.variance != null) ? money(varianceValue) : '—'} tone={varianceValue < 0 ? 'danger' : undefined} />
      </div>

      {open && (
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-3">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void scan(code);
            }}
          >
            <div className="flex h-11 min-w-[240px] flex-1 items-center gap-2 rounded-xl border-2 border-brand-500 px-3">
              <ScanLine className="h-4 w-4 text-brand-600" aria-hidden="true" />
              <label htmlFor="scan" className="sr-only">Scan or type a barcode, SKU or item code</label>
              <input
                id="scan"
                ref={scanRef}
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Scan with a USB scanner, or type a code and press Enter"
                className="flex-1 bg-transparent text-sm text-ink outline-none"
              />
            </div>
            <ScanToFind product label="Camera" onScan={(v) => void scan(v)} className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-ink" />
          </form>
          {flash && (
            <p role="status" className={cn('text-sm font-semibold', flash.ok ? 'text-brand-700' : 'text-red-700')}>{flash.text}</p>
          )}
          <ItemPicker placeholder="No barcode? Search and add an item by hand" onPick={(it) => void scan('', it.id)} />
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-sunken text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Shelf</th>
              <th className="px-3 py-2 text-right">Expected</th>
              <th className="px-3 py-2 text-right">Counted</th>
              <th className="px-3 py-2 text-right">Variance</th>
            </tr>
          </thead>
          <tbody>
            {c.lines.map((l) => (
              <tr key={l.itemId} className={cn('border-t border-line', l.variance != null && l.variance < 0 && 'bg-red-50', l.variance != null && l.variance > 0 && 'bg-brand-50')}>
                <td className="px-3 py-2">
                  <div className="font-semibold text-ink">{l.title}</div>
                  <div className="font-mono text-xs text-muted">{l.sku ?? ''}</div>
                </td>
                <td className="px-3 py-2 text-muted">{l.shelf ?? ''}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{l.expected ?? 'hidden'}</td>
                <td className="px-3 py-2 text-right">
                  {open ? (
                    <input
                      aria-label={`Counted for ${l.title}`}
                      className={cn(inputCls, 'ml-auto h-9 w-20 text-right font-bold')}
                      inputMode="numeric"
                      defaultValue={l.counted ?? ''}
                      key={`${l.itemId}:${l.counted}`}
                      onBlur={async (e) => {
                        const t = e.target.value.trim();
                        const n = t === '' ? null : Number(t);
                        if (n === l.counted || (n != null && !(n >= 0))) return;
                        try {
                          setC(await setCountLine(id, l.itemId, { counted: n }));
                        } catch (err) {
                          toast.error(err instanceof ApiError ? err.userMessage : 'Could not save');
                        }
                      }}
                    />
                  ) : (
                    <span className="font-bold tabular-nums">{l.counted ?? '—'}</span>
                  )}
                </td>
                <td className={cn('px-3 py-2 text-right font-extrabold tabular-nums', (l.variance ?? 0) < 0 ? 'text-red-700' : (l.variance ?? 0) > 0 ? 'text-brand-700' : 'text-muted')}>
                  {l.variance == null ? (l.counted == null ? 'not counted' : '—') : l.variance > 0 ? `+${l.variance}` : l.variance}
                </td>
              </tr>
            ))}
            {!c.lines.length && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted">Scan the first item to start.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={confirm === 'apply'}
        title={`Apply ${changes} stock changes?`}
        message={`Stock at ${c.location} changes by ${varianceUnits > 0 ? '+' : ''}${varianceUnits} units and every linked store is updated. Items not counted are left as they are.`}
        confirmLabel="Apply count"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setBusy(true);
          try {
            const r = await applyCount(id);
            toast.success(`Applied ${r.applied} changes`);
            setConfirm(null);
            void load();
          } catch (e) {
            toast.error(e instanceof ApiError ? e.userMessage : 'Could not apply');
          } finally {
            setBusy(false);
          }
        }}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        title="Cancel this count?"
        message="Nothing is changed. The scanned numbers are kept for reference."
        confirmLabel="Cancel count"
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await cancelCount(id).catch(() => undefined);
          setConfirm(null);
          void load();
        }}
      />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'danger' }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <div className="text-xs font-semibold text-muted">{label}</div>
      <div className={cn('text-xl font-extrabold tabular-nums', tone === 'danger' ? 'text-red-700' : 'text-ink')}>{value}</div>
    </div>
  );
}
