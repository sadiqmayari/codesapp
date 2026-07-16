'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShoppingCart, ExternalLink, RefreshCw } from 'lucide-react';
import CreateOrderModal from '@/components/inbox/create-order-modal';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';
import {
  listAbandonedCheckouts,
  dismissAbandonedCheckout,
  type AbandonedCheckout,
} from '@/lib/orders';

export default function AbandonedCheckoutsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<AbandonedCheckout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<AbandonedCheckout | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listAbandonedCheckouts());
    } catch (e) {
      setError(
        e instanceof ApiError ? e.userMessage : 'Failed to load checkouts',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onCreated = async () => {
    if (!active) return;
    const id = active.id;
    try {
      await dismissAbandonedCheckout(id);
    } catch {
      // best-effort — the webhook backstop will also convert it
    }
    setRows((r) => r.filter((x) => x.id !== id));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Carts left without checking out. Customers who already ordered today
          are hidden automatically.
        </p>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          No abandoned checkouts to recover right now.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Items</th>
                <th className="px-4 py-3 font-medium">Abandoned</th>
                <th className="px-4 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {r.contactName || '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{r.phone || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{r.email || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 max-w-[280px] truncate">
                    {r.itemsSummary || '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {fmtDateTime(r.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      {r.recoveryUrl && (
                        <a
                          href={r.recoveryUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-400 hover:text-gray-700"
                          title="Open recovery link"
                        >
                          <ExternalLink size={16} />
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => setActive(r)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                      >
                        <ShoppingCart size={14} />
                        Create order
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {active && (
        <CreateOrderModal
          contactName={active.contactName}
          contactPhone={active.phone}
          contactEmail={active.email}
          assignedAgentName={user?.name ?? null}
          extraTags={['Abandoned Checkout']}
          onCreated={onCreated}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}
