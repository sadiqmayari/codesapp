'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Play, Wrench } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { ConfirmDialog } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { fmtDate } from '@/lib/utils';
import type { AdminInvoice, InvoiceStatus, Paged } from '@/lib/crm-types';
import { SaCard, SaPageHeader, SaSpinner } from '../_components/sa-ui';

export const dynamic = 'force-dynamic';

const LIMIT = 20;

const FILTERS: Array<{ key: InvoiceStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'paid', label: 'Paid' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'cancelled', label: 'Cancelled' },
];

const STATUS_CLS: Record<InvoiceStatus, string> = {
  paid: 'good',
  pending: 'warn',
  overdue: 'crit',
  cancelled: 'slate',
};

function money(v: string | number): string {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
}

export default function SuperAdminBillingPage() {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<AdminInvoice[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<InvoiceStatus | 'all'>('all');
  const [markBusyId, setMarkBusyId] = useState<number | null>(null);
  const [genConfirm, setGenConfirm] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriteBusy, setRewriteBusy] = useState(false);
  const [rewritePreview, setRewritePreview] = useState<{
    mode: 'dry-run' | 'apply';
    inspected: number;
    candidates: number;
    skipped: number;
    updated: number;
    collisions: Array<{ id: number; collidesWith: number }>;
    changes: Array<{
      id: number;
      companyId: number;
      companyName: string | null;
      oldNumber: string | null;
      newNumber: string;
      newDueDate: string;
      newPeriod: string;
    }>;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch<Paged<AdminInvoice>>('/super-admin/invoices', {
        params: { page, limit: LIMIT },
        noOnboardingRedirect: true,
      });
      setRows(res.items);
      setTotal(res.meta.total);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const markPaid = async (id: number) => {
    setMarkBusyId(id);
    try {
      await apiFetch(`/super-admin/billing/invoices/${id}/mark-paid`, { method: 'POST', noOnboardingRedirect: true });
      toast.success('Invoice marked paid');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Mark-paid failed');
    } finally {
      setMarkBusyId(null);
    }
  };

  const openRewrite = async () => {
    setRewriteOpen(true);
    setRewritePreview(null);
    setRewriteBusy(true);
    try {
      const res = await apiFetch<typeof rewritePreview>('/super-admin/billing/invoices/rewrite-legacy', {
        method: 'POST',
        body: { dryRun: true },
        noOnboardingRedirect: true,
      });
      setRewritePreview(res);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to preview rewrites');
      setRewriteOpen(false);
    } finally {
      setRewriteBusy(false);
    }
  };

  const applyRewrite = async () => {
    setRewriteBusy(true);
    try {
      const res = await apiFetch<typeof rewritePreview>('/super-admin/billing/invoices/rewrite-legacy', {
        method: 'POST',
        body: { dryRun: false },
        noOnboardingRedirect: true,
      });
      setRewritePreview(res);
      toast.success(`Rewrote ${res?.updated ?? 0} legacy invoices (skipped ${res?.skipped ?? 0})`);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Rewrite failed');
    } finally {
      setRewriteBusy(false);
    }
  };

  const runGenerate = async () => {
    setGenBusy(true);
    try {
      const res = await apiFetch<{ created: number; skipped: number }>('/super-admin/billing/invoices/generate', {
        method: 'POST',
        noOnboardingRedirect: true,
      });
      toast.success(`Generated ${res.created} · skipped ${res.skipped} (idempotent)`);
      setGenConfirm(false);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Generation failed');
    } finally {
      setGenBusy(false);
    }
  };

  const visible = useMemo(() => rows.filter((r) => filter === 'all' || r.status === filter), [rows, filter]);
  const paidOnPage = useMemo(
    () => rows.filter((r) => r.status === 'paid').reduce((s, r) => s + Number(r.amount || 0), 0),
    [rows],
  );
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="sa-content">
      <SaPageHeader
        title="Billing & invoices"
        subtitle="Activation-anchored 30-day cycles — an invoice is raised on each client's activation anniversary. A cron checks daily and raises only the missing invoice. Mark paid auto-reactivates a cron-suspended company once nothing is unpaid."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="sa-btn" style={{ cursor: 'default' }}>
              Paid on page: <b style={{ color: 'var(--sa-good)', marginLeft: 4 }}>${paidOnPage.toFixed(2)}</b>
            </span>
            <button className="sa-btn" onClick={openRewrite} disabled={rewriteBusy}
              style={{ borderColor: 'var(--sa-warn-wash)', color: 'var(--sa-warn)' }}>
              <Wrench size={14} /> Rewrite legacy
            </button>
            <button className="sa-btn primary" onClick={() => setGenConfirm(true)} disabled={genBusy}>
              <Play size={14} /> Run generation
            </button>
          </div>
        }
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={filter === f.key ? 'sa-btn primary' : 'sa-btn'}
            style={{ borderRadius: 999, fontSize: 12, padding: '5px 13px' }}>
            {f.label}
          </button>
        ))}
      </div>

      {error && <div className="sa-alert-error">{error}</div>}

      <SaCard bodyClassName="">
        <div className="sa-table-wrap">
          <table className="sa-table" style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th>Invoice</th><th>Company</th><th>Period</th>
                <th className="n">Amount</th><th>Status</th><th>Due</th><th>Created</th><th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8}><SaSpinner /></td></tr>
              ) : visible.length === 0 ? (
                <tr><td colSpan={8} className="sa-faint" style={{ textAlign: 'center', padding: 40 }}>No invoices match.</td></tr>
              ) : (
                visible.map((inv) => (
                  <tr key={inv.id}>
                    <td className="sa-mono sa-faint" style={{ fontSize: 12 }}>{inv.invoice_number ?? `#${inv.id}`}</td>
                    <td style={{ fontWeight: 600 }}>{inv.company?.company_name ?? `Company ${inv.company_id}`}</td>
                    <td className="sa-muted">{inv.period ?? '—'}</td>
                    <td className="n" style={{ fontWeight: 600 }}>${money(inv.amount)}</td>
                    <td><span className={`sa-pill ${STATUS_CLS[inv.status]}`} style={{ textTransform: 'capitalize' }}>{inv.status}</span></td>
                    <td className="sa-muted">{fmtDate(inv.due_date)}</td>
                    <td className="sa-muted">{fmtDate(inv.created_at)}</td>
                    <td className="n">
                      {(inv.status === 'pending' || inv.status === 'overdue') && (
                        <button className="sa-btn primary" style={{ padding: '5px 10px', fontSize: 12 }}
                          onClick={() => markPaid(inv.id)} disabled={markBusyId === inv.id}>
                          {markBusyId === inv.id ? '…' : 'Mark paid'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </SaCard>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }} className="sa-muted">
        <span>{total} total · page {page}/{totalPages}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="sa-btn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            <ChevronLeft size={14} /> Prev
          </button>
          <button className="sa-btn" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {rewriteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,.45)' }}
          onClick={() => !rewriteBusy && setRewriteOpen(false)}>
          <div className="sa-card" style={{ maxWidth: 760, width: '100%', padding: 20, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 17, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Wrench size={18} style={{ color: 'var(--sa-warn)' }} /> Rewrite legacy invoices
            </h3>
            <p className="sa-faint" style={{ fontSize: 12, marginTop: 4 }}>
              Rewrites pre-billing-lifecycle invoices to the canonical INV-&#123;id&#125;-&#123;YYYYMMDD&#125; format anchored
              on each company&apos;s activated_at. Never touches status, paid_at, or amount.
            </p>

            {rewriteBusy && !rewritePreview ? (
              <SaSpinner pad={48} />
            ) : rewritePreview ? (
              <>
                <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                  <MiniStat label="Inspected" value={rewritePreview.inspected} />
                  <MiniStat label="Candidates" value={rewritePreview.candidates} tone="warn" />
                  <MiniStat label="Skipped" value={rewritePreview.skipped} />
                  <MiniStat label={rewritePreview.mode === 'apply' ? 'Updated' : 'Will update'}
                    value={rewritePreview.mode === 'apply' ? rewritePreview.updated : rewritePreview.candidates} tone="good" />
                </div>

                <div style={{ marginTop: 16, flex: 1, overflow: 'auto', border: '1px solid var(--sa-border)', borderRadius: 9 }}>
                  {rewritePreview.changes.length === 0 ? (
                    <p className="sa-faint" style={{ padding: 24, textAlign: 'center', fontSize: 13 }}>
                      No legacy invoices found — every invoice is already canonical.
                    </p>
                  ) : (
                    <table className="sa-table" style={{ minWidth: 520 }}>
                      <thead><tr><th>Invoice</th><th>Company</th><th>Old #</th><th>New #</th><th>Period</th></tr></thead>
                      <tbody>
                        {rewritePreview.changes.map((c) => (
                          <tr key={c.id}>
                            <td className="sa-mono sa-faint">#{c.id}</td>
                            <td>{c.companyName ?? `Company ${c.companyId}`}</td>
                            <td className="sa-mono sa-faint" style={{ textDecoration: 'line-through' }}>{c.oldNumber ?? '(none)'}</td>
                            <td className="sa-mono" style={{ color: 'var(--sa-accent-ink)' }}>{c.newNumber}</td>
                            <td className="sa-muted">{c.newPeriod}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {rewritePreview.collisions.length > 0 && (
                  <p style={{ marginTop: 12, fontSize: 12, color: 'var(--sa-warn)', background: 'var(--sa-warn-wash)', border: '1px solid var(--sa-warn)', borderRadius: 7, padding: '6px 10px' }}>
                    ⚠ {rewritePreview.collisions.length} skipped due to number collisions.
                  </p>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--sa-border)' }}>
                  <button className="sa-btn" onClick={() => !rewriteBusy && setRewriteOpen(false)} disabled={rewriteBusy}>Close</button>
                  {rewritePreview.mode === 'dry-run' && rewritePreview.candidates > 0 && (
                    <button className="sa-btn" onClick={applyRewrite} disabled={rewriteBusy}
                      style={{ background: 'var(--sa-warn)', borderColor: 'var(--sa-warn)', color: '#fff' }}>
                      {rewriteBusy ? 'Applying…' : `Apply ${rewritePreview.candidates} rewrite${rewritePreview.candidates === 1 ? '' : 's'}`}
                    </button>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={genConfirm}
        title="Run invoice generation now?"
        message="This runs generateDueInvoices() against every active client — the same routine the daily cron uses. It's idempotent, so running it off-cycle is safe."
        confirmLabel="Run now"
        busy={genBusy}
        onConfirm={runGenerate}
        onCancel={() => !genBusy && setGenConfirm(false)}
      />
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: number; tone?: 'warn' | 'good' }) {
  const color = tone === 'warn' ? 'var(--sa-warn)' : tone === 'good' ? 'var(--sa-good)' : 'var(--sa-fg)';
  const bg = tone === 'warn' ? 'var(--sa-warn-wash)' : tone === 'good' ? 'var(--sa-good-wash)' : 'var(--sa-surface-2)';
  return (
    <div style={{ borderRadius: 9, border: '1px solid var(--sa-border)', padding: 8, background: bg }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', opacity: 0.7, color }}>{label}</div>
      <div className="sa-mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 2, color }}>{value.toLocaleString()}</div>
    </div>
  );
}
