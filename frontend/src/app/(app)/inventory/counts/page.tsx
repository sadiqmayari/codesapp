'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ClipboardCheck, Upload } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Switch } from '@/components/ui/switch';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { getLocations, type InventoryLocation } from '@/lib/inventory';
import { applyImport, createCount, listCounts, previewImport, type CountSummary, type ImportPreview } from '@/lib/inventory-ops';
import { inputCls } from '@/components/inventory/shared';

const STATUS: Record<CountSummary['status'], { label: string; tone: 'neutral' | 'success' | 'danger' }> = {
  draft: { label: 'Counting', tone: 'neutral' },
  applied: { label: 'Applied', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

/** Stock counts (cycle counts) + CSV stock import. */
export default function CountsPage() {
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const { user } = useAuth();
  const canManage = user?.role === 'owner' || user?.role === 'admin';
  const [rows, setRows] = useState<CountSummary[] | null>(null);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    listCounts().then(setRows).catch(() => setRows([]));
    getLocations().then(setLocations).catch(() => undefined);
    if (params?.get('import') === '1') setImportOpen(true);
    // params read once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns: Column<CountSummary>[] = [
    { key: 'n', header: 'Count', render: (c) => <span className="font-bold text-ink">{c.number}</span> },
    { key: 'loc', header: 'Location', render: (c) => c.location },
    { key: 'scope', header: 'Scope', render: (c) => <span className="text-muted">{c.scope ?? 'Anything scanned'}</span> },
    { key: 'lines', header: 'Counted', align: 'right', render: (c) => `${c.counted} / ${c.lines}` },
    {
      key: 'var',
      header: 'Variance',
      align: 'right',
      render: (c) => (
        <span className={c.variance < 0 ? 'font-bold text-red-700' : c.variance > 0 ? 'font-bold text-brand-700' : 'text-muted'}>
          {c.status === 'draft' && c.variance === 0 ? '—' : c.variance > 0 ? `+${c.variance}` : c.variance}
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (c) => <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge> },
    { key: 'at', header: 'Started', render: (c) => <span className="text-muted">{fmtDateTime(c.createdAt)}</span> },
  ];

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-ink">Stock counts</h1>
          <p className="mt-1 text-sm text-muted">Scan what is on the shelf. A manager reviews the differences and applies them in one go.</p>
        </div>
        <div className="flex gap-2">
          {canManage && (
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" aria-hidden="true" /> Import CSV
            </Button>
          )}
          <Button onClick={() => setNewOpen(true)} disabled={!locations.length}>
            <ClipboardCheck className="h-4 w-4" aria-hidden="true" /> Start a count
          </Button>
        </div>
      </header>
      <div className="rounded-2xl border border-line bg-surface p-3">
        <DataTable
          rows={rows ?? []}
          columns={columns}
          rowKey={(c) => c.id}
          loading={rows == null}
          onRowClick={(c) => router.push(`/inventory/counts/${c.id}`)}
          maxHeight="none"
          emptyNode={<EmptyState icon={ClipboardCheck} title="No counts yet" description="Start a count to check a shelf or the whole warehouse." />}
        />
      </div>
      <NewCountModal open={newOpen} locations={locations} onClose={() => setNewOpen(false)} onCreated={(id) => router.push(`/inventory/counts/${id}`)} />
      <ImportModal
        open={importOpen}
        locations={locations}
        onClose={() => setImportOpen(false)}
        onDone={(m) => {
          setImportOpen(false);
          toast.success(m);
        }}
      />
    </div>
  );
}

function NewCountModal({ open, locations, onClose, onCreated }: { open: boolean; locations: InventoryLocation[]; onClose: () => void; onCreated: (id: number) => void }) {
  const toast = useToast();
  const [loc, setLoc] = useState(0);
  const [scope, setScope] = useState('');
  const [blind, setBlind] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setLoc(locations.find((l) => l.isDefault)?.id ?? locations[0]?.id ?? 0);
  }, [open, locations]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start a stock count"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const c = await createCount({ locationId: loc, blind, scope: scope.trim() || undefined });
                onCreated(c.id);
              } catch (e) {
                toast.error(e instanceof ApiError ? e.userMessage : 'Could not start the count');
              } finally {
                setBusy(false);
              }
            }}
          >
            Start counting
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="cnt-loc" className="text-xs font-bold text-ink">Location</label>
          <select id="cnt-loc" className={inputCls} value={loc} onChange={(e) => setLoc(Number(e.target.value))}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="cnt-scope" className="text-xs font-bold text-ink">What are you counting? (optional)</label>
          <input id="cnt-scope" className={inputCls} value={scope} maxLength={160} onChange={(e) => setScope(e.target.value)} placeholder="Shelf A3, or the whole warehouse" />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 text-sm">
          <span>
            <b>Blind count</b>
            <span className="block text-xs text-muted">The counter doesn’t see the expected number, so they count what is really there.</span>
          </span>
          <Switch checked={blind} onChange={setBlind} label="Blind count" />
        </div>
      </div>
    </Modal>
  );
}

function ImportModal({ open, locations, onClose, onDone }: { open: boolean; locations: InventoryLocation[]; onClose: () => void; onDone: (msg: string) => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [loc, setLoc] = useState(0);
  const [mode, setMode] = useState<'set' | 'adjust'>('set');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setLoc(locations.find((l) => l.isDefault)?.id ?? locations[0]?.id ?? 0);
      setPreview(null);
      setFile(null);
    }
  }, [open, locations]);
  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      if (!preview) setPreview(await previewImport(file, loc, mode));
      else {
        const r = await applyImport(preview.token);
        onDone(`Imported — ${r.stockChanges} stock changes, ${r.costChanges} cost changes`);
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not read the file');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Import stock from CSV"
      footer={
        <>
          <Button variant="ghost" onClick={preview ? () => setPreview(null) : onClose}>{preview ? 'Back' : 'Cancel'}</Button>
          <Button onClick={run} loading={busy} disabled={!file || (!!preview && preview.changes === 0)}>
            {preview ? `Apply ${preview.changes} changes` : 'Preview'}
          </Button>
        </>
      }
    >
      {!preview ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            One row per item. Identify it by <b>sku</b>, <b>item code</b> or <b>barcode</b>, then a quantity column. An optional <b>cost</b> column updates unit cost.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="im-loc" className="text-xs font-bold text-ink">Location</label>
              <select id="im-loc" className={inputCls} value={loc} onChange={(e) => setLoc(Number(e.target.value))}>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="im-mode" className="text-xs font-bold text-ink">The quantity column is</label>
              <select id="im-mode" className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as 'set' | 'adjust')}>
                <option value="set">The new available stock (available / qty)</option>
                <option value="adjust">A change to add or remove (change)</option>
              </select>
            </div>
          </div>
          <label htmlFor="im-file" className="flex cursor-pointer flex-col items-center gap-1 rounded-xl border-2 border-dashed border-line p-6 text-center text-sm text-muted hover:border-brand-300">
            <Upload className="h-5 w-5" aria-hidden="true" />
            {file ? <b className="text-ink">{file.name}</b> : 'Choose a CSV file (up to 5,000 rows)'}
            <input id="im-file" type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            <b>{preview.total}</b> rows · <b className="text-brand-700">{preview.changes}</b> changes · <b className={preview.errors ? 'text-red-700' : ''}>{preview.errors}</b> problems. Nothing is saved until you apply.
          </p>
          <div className="max-h-[50vh] overflow-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-sunken text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2 text-right">Now</th>
                  <th className="px-3 py-2 text-right">Change</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.row} className={r.error ? 'bg-red-50' : ''}>
                    <td className="border-t border-line px-3 py-1.5 text-muted">{r.row}</td>
                    <td className="border-t border-line px-3 py-1.5">
                      {r.title ?? r.code}
                      {r.error && <span className="block text-xs font-semibold text-red-700">{r.error}</span>}
                    </td>
                    <td className="border-t border-line px-3 py-1.5 text-right tabular-nums">{r.current ?? '—'}</td>
                    <td className="border-t border-line px-3 py-1.5 text-right font-bold tabular-nums">{r.delta == null ? '—' : r.delta > 0 ? `+${r.delta}` : r.delta}</td>
                    <td className="border-t border-line px-3 py-1.5 text-right tabular-nums">{r.cost ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
