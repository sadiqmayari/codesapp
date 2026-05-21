'use client';

import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import type { CannedReply } from '@/lib/crm-types';

/**
 * Saved canned / quick replies. Two modes in one modal:
 *  - pick  : tap a reply → `onInsert(body)` drops it into the composer.
 *  - manage: add / edit / delete the company-wide saved replies.
 * Company-scoped CRUD lives at /canned-replies (AuthGuard+TenantGuard).
 */
export default function QuickReplyPicker({
  onInsert,
  onClose,
}: {
  onInsert: (body: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<CannedReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'pick' | 'edit'>('pick');
  const [editing, setEditing] = useState<CannedReply | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CannedReply | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<CannedReply[]>('/canned-replies');
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load quick replies',
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const openNew = () => {
    setEditing(null);
    setTitle('');
    setBody('');
    setMode('edit');
  };

  const openEdit = (r: CannedReply) => {
    setEditing(r);
    setTitle(r.title);
    setBody(r.body);
    setMode('edit');
  };

  const save = async () => {
    const t = title.trim();
    const b = body.trim();
    if (!t || !b) return;
    setBusy(true);
    try {
      if (editing) {
        await apiFetch(`/canned-replies/${editing.id}`, {
          method: 'PATCH',
          body: { title: t, body: b },
        });
      } else {
        await apiFetch('/canned-replies', {
          method: 'POST',
          body: { title: t, body: b },
        });
      }
      setMode('pick');
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await apiFetch(`/canned-replies/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={mode === 'edit' ? (editing ? 'Edit quick reply' : 'New quick reply') : 'Quick replies'}
        footer={
          mode === 'edit' ? (
            <>
              <button
                type="button"
                onClick={() => setMode('pick')}
                disabled={busy}
                className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy || !title.trim() || !body.trim()}
                className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={openNew}
              className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 flex items-center gap-1.5"
            >
              <Plus size={16} /> New quick reply
            </button>
          )
        }
      >
        {mode === 'edit' ? (
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Title (shortcut name)
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                placeholder="e.g. Greeting"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Message</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                placeholder="Hi! Thanks for reaching out…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
          </div>
        ) : loading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-gray-400 py-6 text-center">
            No quick replies yet. Create one to reuse common messages.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li
                key={r.id}
                className="group border border-gray-200 rounded-lg p-3 hover:border-green-400"
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onInsert(r.body);
                      onClose();
                    }}
                    className="flex-1 text-left min-w-0"
                    title="Insert into composer"
                  >
                    <p className="font-medium text-sm text-gray-900 truncate">
                      {r.title}
                    </p>
                    <p className="text-xs text-gray-500 line-clamp-2 whitespace-pre-wrap">
                      {r.body}
                    </p>
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => openEdit(r)}
                      className="p-1.5 text-gray-400 hover:text-gray-700"
                      aria-label="Edit"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(r)}
                      className="p-1.5 text-gray-400 hover:text-red-600"
                      aria-label="Delete"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete quick reply"
        message={`Delete "${deleteTarget?.title ?? ''}"? This can't be undone.`}
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={doDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
