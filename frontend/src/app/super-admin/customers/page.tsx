'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Users,
  Search,
  Download,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/utils';
import {
  listAdminCustomers,
  downloadAdminCustomersCsv,
  type AdminCustomer,
  type CustomerSort,
} from '@/lib/admin-customers';

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

  // Debounce the search box.
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
      const data = await listAdminCustomers({
        q: debouncedQ,
        sort,
        page,
        limit: PAGE_SIZE,
      });
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
    // `router` deliberately omitted (unstable identity in Next 14).
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
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <span className="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center">
              <Users size={18} />
            </span>
            Customer registry
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            CodesApp-owned customer database across all tenants. Rows persist
            even after a tenant is deleted.
          </p>
        </div>
        <button
          onClick={doExport}
          disabled={exporting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50"
        >
          {exporting ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Download size={15} />
          )}
          Export CSV
        </button>
      </div>

      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, phone, email or tenant…"
            className="w-full rounded-lg border border-gray-200 bg-white pl-9 pr-3 py-2 text-sm shadow-sm focus:border-green-500 focus:outline-none"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as CustomerSort);
            setPage(1);
          }}
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm"
        >
          <option value="ltv">Sort: LTV (highest)</option>
          <option value="orders">Sort: Orders (most)</option>
          <option value="recent">Sort: Last order (newest)</option>
          <option value="name">Sort: Name (A–Z)</option>
        </select>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Customer</th>
                <th className="text-left px-4 py-3 font-medium">Email</th>
                <th className="text-left px-4 py-3 font-medium">Origin tenant</th>
                <th className="text-right px-4 py-3 font-medium">Orders</th>
                <th className="text-right px-4 py-3 font-medium">LTV</th>
                <th className="text-right px-4 py-3 font-medium">AOV</th>
                <th className="text-left px-4 py-3 font-medium">Last order</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-gray-400">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-gray-400">
                    No customers found.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">
                        {r.name || '—'}
                      </div>
                      <div className="text-xs text-gray-500 tabular-nums">
                        {r.phone}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{r.email || '—'}</td>
                    <td className="px-4 py-3">
                      <span className="text-gray-800">
                        {r.origin_company_name}
                      </span>
                      {r.origin_company_deleted_at && (
                        <span className="ml-2 inline-block rounded-full bg-red-50 text-red-600 border border-red-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                          Tenant deleted
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-800">
                      {r.orders_count.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-gray-900">
                      {money(r.total_order_value, r.currency)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {money(r.avg_order_value, r.currency)}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {r.last_order_at ? (
                        <div>
                          <div className="text-gray-800">
                            {r.last_order_name || '—'}
                          </div>
                          <div className="text-xs text-gray-400">
                            {fmtDate(r.last_order_at)}
                          </div>
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-sm text-gray-500">
          <span>
            {total.toLocaleString()} customer{total === 1 ? '' : 's'}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 disabled:opacity-40 hover:bg-gray-50"
            >
              <ChevronLeft size={14} /> Prev
            </button>
            <span className="tabular-nums">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 disabled:opacity-40 hover:bg-gray-50"
            >
              Next <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
