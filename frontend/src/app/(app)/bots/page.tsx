'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Bot as BotIcon } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/modal';
import { BotFormModal } from '@/components/bots/bot-form-modal';
import type { Bot } from '@/lib/crm-types';

export const dynamic = 'force-dynamic';

const ACTION_LABEL: Record<string, string> = {
  reply_template: 'Reply template',
  send_text: 'Send text',
  assign_agent: 'Assign agent',
  apply_tag: 'Apply tag',
  fire_webhook: 'Fire webhook',
};

export default function BotsPage() {
  const toast = useToast();
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Bot | null>(null);
  const [delTarget, setDelTarget] = useState<Bot | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBots(await apiFetch<Bot[]>('/bots'));
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load bots',
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (b: Bot) => {
    const prev = bots;
    setBots((c) =>
      c.map((x) =>
        x.id === b.id
          ? { ...x, status: x.status === 'active' ? 'inactive' : 'active' }
          : x,
      ),
    );
    try {
      await apiFetch(`/bots/${b.id}/toggle`, { method: 'PATCH' });
    } catch (e) {
      setBots(prev);
      toast.error(e instanceof ApiError ? e.userMessage : 'Toggle failed');
    }
  };

  const doDelete = async () => {
    if (!delTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/bots/${delTarget.id}`, { method: 'DELETE' });
      toast.success('Bot deleted');
      setDelTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-5">
        <h1 className="text-2xl font-bold text-gray-900 mr-auto">Bots</h1>
        <button
          onClick={() => {
            setEditTarget(null);
            setFormOpen(true);
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 hover:bg-green-700 px-4 py-2 text-sm text-white font-medium"
        >
          <Plus size={16} /> New bot
        </button>
      </div>

      {loading ? (
        <p className="text-center text-gray-400 py-10">Loading…</p>
      ) : bots.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <BotIcon size={40} className="mx-auto mb-3 opacity-40" />
          <p>No bots yet. Create a keyword automation.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {bots.map((b) => (
            <div
              key={b.id}
              className="bg-white border border-gray-200 rounded-xl p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 truncate">
                    {b.name}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    <span className="capitalize">{b.trigger_type}</span> ·{' '}
                    <code className="bg-gray-100 px-1 rounded">
                      {b.keyword}
                    </code>
                  </p>
                </div>
                <button
                  onClick={() => toggle(b)}
                  className={cn(
                    'rounded-full px-2.5 py-0.5 text-xs font-medium',
                    b.status === 'active'
                      ? 'bg-green-100 text-green-800'
                      : 'bg-gray-200 text-gray-600',
                  )}
                  title="Toggle active"
                >
                  {b.status}
                </button>
              </div>
              <div className="flex flex-wrap gap-1 mt-3">
                {b.actions.map((a, i) => (
                  <span
                    key={i}
                    className="rounded-full bg-blue-50 text-blue-700 px-2 py-0.5 text-xs"
                  >
                    {ACTION_LABEL[a.type] ?? a.type}
                  </span>
                ))}
              </div>
              <div className="flex justify-end gap-4 mt-4">
                <button
                  onClick={() => {
                    setEditTarget(b);
                    setFormOpen(true);
                  }}
                  className="text-sm text-gray-600 inline-flex items-center gap-1"
                >
                  <Pencil size={14} /> Edit
                </button>
                <button
                  onClick={() => setDelTarget(b)}
                  className="text-sm text-red-600 inline-flex items-center gap-1"
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <BotFormModal
        open={formOpen}
        bot={editTarget}
        onClose={() => setFormOpen(false)}
        onSaved={load}
      />
      <ConfirmDialog
        open={!!delTarget}
        title="Delete bot"
        message={`Delete "${delTarget?.name}"? This permanently removes the bot (hard delete).`}
        confirmLabel="Delete"
        danger
        busy={deleting}
        onConfirm={doDelete}
        onCancel={() => !deleting && setDelTarget(null)}
      />
    </div>
  );
}
