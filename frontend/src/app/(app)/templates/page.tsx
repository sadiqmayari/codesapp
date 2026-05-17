'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, FileText } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn, fmtDateTime } from '@/lib/utils';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import { TemplateFormModal } from '@/components/templates/template-form-modal';
import { WhatsAppPreview } from '@/components/templates/whatsapp-preview';
import type { Template, TemplateStatus } from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

const FILTERS: Array<{ key: TemplateStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'approved', label: 'Approved' },
  { key: 'pending', label: 'Pending' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'paused', label: 'Paused' },
];

function StatusPill({ status }: { status: TemplateStatus }) {
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize',
        status === 'approved' && 'bg-green-100 text-green-800',
        status === 'pending' && 'bg-yellow-100 text-yellow-800',
        status === 'rejected' && 'bg-red-100 text-red-800',
        status === 'paused' && 'bg-gray-200 text-gray-700',
      )}
    >
      {status}
    </span>
  );
}

export default function TemplatesPage() {
  const toast = useToast();
  const [items, setItems] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<TemplateStatus | 'all'>('all');
  const [syncing, setSyncing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [detail, setDetail] = useState<Template | null>(null);
  const [delTarget, setDelTarget] = useState<Template | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<Template[]>('/templates', {
        params: { status: filter === 'all' ? undefined : filter },
      });
      setItems(res);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load templates',
      );
    } finally {
      setLoading(false);
    }
  }, [filter, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await apiFetch<{ synced: number; deleted: number }>(
        '/templates/sync',
        { method: 'POST' },
      );
      toast.success(`Synced ${r.synced} template(s) from Meta`);
      load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Meta sync failed',
      );
    } finally {
      setSyncing(false);
    }
  };

  const doDelete = async () => {
    if (!delTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/templates/${delTarget.id}`, { method: 'DELETE' });
      toast.success('Template deleted');
      setDelTarget(null);
      setDetail(null);
      load();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to delete template',
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <h1 className="text-2xl font-bold text-gray-900 mr-auto">Templates</h1>
        <button
          onClick={sync}
          disabled={syncing}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing…' : 'Sync from Meta'}
        </button>
        <button
          onClick={() => setFormOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 hover:bg-green-700 px-4 py-2 text-sm text-white font-medium"
        >
          <Plus size={16} /> New template
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium',
              filter === f.key
                ? 'bg-green-600 text-white'
                : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-100',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-gray-400 py-10 text-center">Loading…</p>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <FileText size={40} className="mx-auto mb-3 opacity-40" />
          <p>No templates yet. Create one or sync from Meta.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((t) => (
            <button
              key={t.id}
              onClick={() => setDetail(t)}
              className="text-left bg-white border border-gray-200 rounded-xl p-4 hover:shadow-md transition"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-gray-900 break-all">
                  {t.name}
                </p>
                <StatusPill status={t.status} />
              </div>
              <p className="text-xs text-gray-500 mt-1 capitalize">
                {t.category}
              </p>
              <p className="text-sm text-gray-600 mt-3 line-clamp-2">
                {t.content?.components?.find((c) => c.type === 'BODY')?.text ??
                  '—'}
              </p>
              <p className="text-xs text-gray-400 mt-3">
                Updated {fmtDateTime(t.created_at)}
              </p>
            </button>
          ))}
        </div>
      )}

      <TemplateFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onCreated={load}
      />

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.name ?? 'Template'}
        size="lg"
        footer={
          <button
            onClick={() => detail && setDelTarget(detail)}
            className="px-4 py-2 text-sm rounded-lg border border-red-300 text-red-600 hover:bg-red-50"
          >
            Delete template
          </button>
        }
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <StatusPill status={detail.status} />
              <span className="text-sm text-gray-500 capitalize">
                {detail.category} · {detail.content?.language}
              </span>
            </div>
            {detail.status === 'rejected' && detail.rejection_reason && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">
                <strong>Rejected:</strong> {detail.rejection_reason}
              </div>
            )}
            <WhatsAppPreview components={detail.content?.components ?? []} />
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!delTarget}
        title="Delete template"
        message={`Delete "${delTarget?.name}"? This soft-deletes the template.`}
        confirmLabel="Delete"
        danger
        busy={deleting}
        onConfirm={doDelete}
        onCancel={() => !deleting && setDelTarget(null)}
      />
    </div>
  );
}
