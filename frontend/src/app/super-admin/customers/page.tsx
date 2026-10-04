'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, ChevronLeft, ChevronRight, Loader2, Search } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/utils';
import {
  listAdminCustomers,
  downloadAdminCustomersCsv,
  type AdminCustomer,
  type CustomerSort,
} from '@/lib/admin-customers';
import { SaCard, SaAvatar, SaPageHeader, SaSpinner } from '../_components/sa-ui';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

const money = (v: number | null | undefined, cur?: string | null) =>
  v == null ? '—' : `${cur ?? 'PKR'} ${Math.round(v).toLocaleString()}`;

export default function SuperAdminCustomersPage() {
  const router = useRouter();
  const [rows, setRows] = useState<AdminCustomer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [sort, setSort] = useState<CustomerSort>('ltv');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listAdminCustomers({ q: debouncedQ, sort, page, limit: PAGE_SIZE });
      setRows(data.items);
      setTotal(data.meta.total);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load customers');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ, sort, page]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const doExport = async () => {
    setExporting(true);
    try {
      await downloadAdminCustomersCsv({ q: debouncedQ, sort });
    } catch {
      setError('Could not export the CSV.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="sa-content">
      <SaPageHeader
        title="Customer registry"
        subtitle="CodesApp-owned customer database across all tenants. Rows persist even after a tenant is deleted."
        actions={
          <button className="sa-btn" onClick={doExport} disabled={exporting}>
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            Export CSV
          </button>
        }
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={16} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--sa-fg-faint)' }} />
          <input
            className="sa-input"
            style={{ paddingLeft: 34 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, phone, email or tenant…"
          />
        </div>
        <select
          className="sa-select"
          style={{ width: 'auto' }}
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as CustomerSort);
            setPage(1);
          }}
        >
          <option value="ltv">Sort: LTV (highest)</option>
          <option value="orders">Sort: Orders (most)</option>
          <option value="recent">Sort: Last order (newest)</option>
          <option value="name">Sort: Name (A–Z)</option>
        </select>
      </div>

      {error && <div className="sa-alert-error">{error}</div>}

      <SaCard bodyClassName="">
        <div className="sa-table-wrap">
          <table className="sa-table" style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Email</th>
                <th>Origin tenant</th>
                <th className="n">Orders</th>
                <th className="n">LTV</th>
                <th className="n">AOV</th>
                <th>Last order</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7}><SaSpinner /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="sa-faint" style={{ textAlign: 'center', padding: 40 }}>No customers found.</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <SaAvatar label={r.name || r.phone} />
                        <span>
                          <span style={{ fontWeight: 600, display: 'block' }}>{r.name || '—'}</span>
                          <span className="sub sa-mono">{r.phone}</span>
                        </span>
                      </div>
                    </td>
                    <td className="sa-muted">{r.email || '—'}</td>
                    <td>
                      <span>{r.origin_company_name}</span>
                      {r.origin_company_deleted_at && (
                        <span className="sa-pill crit" style={{ marginLeft: 8 }}>Tenant deleted</span>
                      )}
                    </td>
                    <td className="n">{r.orders_count.toLocaleString()}</td>
                    <td className="n" style={{ fontWeight: 600 }}>{money(r.total_order_value, r.currency)}</td>
                    <td className="n sa-muted">{money(r.avg_order_value, r.currency)}</td>
                    <td>
                      {r.last_order_at ? (
                        <>
                          <span style={{ display: 'block' }}>{r.last_order_name || '—'}</span>
                          <span className="sub">{fmtDate(r.last_order_at)}</span>
                        </>
                      ) : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--sa-border)', padding: '12px 16px', fontSize: 13 }} className="sa-muted">
          <span>{total.toLocaleString()} customer{total === 1 ? '' : 's'}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="sa-btn" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              <ChevronLeft size={14} /> Prev
            </button>
            <span className="sa-mono">{page} / {totalPages}</span>
            <button className="sa-btn" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
              Next <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </SaCard>
    </div>
  );
}
