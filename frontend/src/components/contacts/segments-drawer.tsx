'use client';

import { useCallback, useEffect, useState } from 'react';
import { X, Plus, Trash2, Pencil } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import type { Segment, SegmentFilter, ContactStatus } from '@/lib/crm-types';

const STATUSES: Array<ContactStatus | ''> = ['', 'active', 'blocked', 'archived'];

function summarize(f: SegmentFilter): string {
  const parts: string[] = [];
  if (f.tags?.length) parts.push(`tags: ${f.tags.join(', ')}`);
  if (f.status) parts.push(`status: ${f.status}`);
  if (f.hasEmail) parts.push('has email');
  if (f.lastMessageAfter)
    parts.push(`after ${f.lastMessageAfter.slice(0, 10)}`);
  if (f.lastMessageBefore)
    parts.push(`before ${f.lastMessageBefore.slice(0, 10)}`);
  return parts.length ? parts.join(' · ') : 'no filters';
}

export function SegmentsDrawer({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Segment | 'new' | null>(null);

  // form state
  const [name, setName] = useState('');
  const [status, setStatus] = useState<ContactStatus | ''>('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [hasEmail, setHasEmail] = useState(false);
  const [after, setAfter] = useState('');
  const [before, setBefore] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<Segment[]>('/contacts/segments');
      setSegments(res);
    } catch {
      toast.error('Failed to load segments');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const startEdit = (s: Segment | 'new') => {
    setEditing(s);
    if (s === 'new') {
      setName('');
      setStatus('');
      setTags([]);
      setHasEmail(false);
      setAfter('');
      setBefore('');
    } else {
      setName(s.name);
      setStatus(s.filter.status ?? '');
      setTags(s.filter.tags ?? []);
      setHasEmail(!!s.filter.hasEmail);
      setAfter(s.filter.lastMessageAfter?.slice(0, 10) ?? '');
      setBefore(s.filter.lastMessageBefore?.slice(0, 10) ?? '');
    }
    setTagDraft('');
  };

  const save = async () => {
    if (!name.trim()) {
      toast.error('Segment name is required');
      return;
    }
    const filter: SegmentFilter = {};
    if (tags.length) filter.tags = tags;
    if (status) filter.status = status;
    if (hasEmail) filter.hasEmail = true;
    if (after) filter.lastMessageAfter = new Date(after).toISOString();
    if (before) filter.lastMessageBefore = new Date(before).toISOString();

    setSaving(true);
    try {
      if (editing === 'new') {
        await apiFetch('/contacts/segments', {
          method: 'POST',
          body: { name: name.trim(), filter },
        });
        toast.success('Segment created');
      } else if (editing) {
        await apiFetch(`/contacts/segments/${editing.id}`, {
          method: 'PATCH',
          body: { name: name.trim(), filter },
        });
        toast.success('Segment updated');
      }
      setEditing(null);
      await load();
      onChanged();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to save segment',
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await apiFetch(`/contacts/segments/${id}`, { method: 'DELETE' });
      toast.success('Segment deleted');
      await load();
      onChanged();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to delete segment',
      );
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[95] flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <aside className="relative bg-white w-full max-w-md h-full flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">
            Manage segments
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-600"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {editing ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Status
                </label>
                <select
                  value={status}
                  onChange={(e) =>
                    setStatus(e.target.value as ContactStatus | '')
                  }
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s === '' ? 'Any' : s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Tags
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {tags.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 rounded-full bg-green-100 text-green-800 px-2.5 py-0.5 text-xs"
                    >
                      {t}
                      <button
                        type="button"
                        onClick={() =>
                          setTags((c) => c.filter((x) => x !== t))
                        }
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const t = tagDraft.trim();
                        if (t && !tags.includes(t))
                          setTags((c) => [...c, t]);
                        setTagDraft('');
                      }
                    }}
                    placeholder="Add tag and press Enter"
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Last msg after
                  </label>
                  <input
                    type="date"
                    value={after}
                    onChange={(e) => setAfter(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Last msg before
                  </label>
                  <input
                    type="date"
                    value={before}
                    onChange={(e) => setBefore(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={hasEmail}
                  onChange={(e) => setHasEmail(e.target.checked)}
                />
                Has an email address
              </label>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => setEditing(null)}
                  className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={saving}
                  className="px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save segment'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                onClick={() => startEdit('new')}
                className="mb-4 inline-flex items-center gap-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm px-4 py-2"
              >
                <Plus size={16} /> New segment
              </button>
              {loading ? (
                <p className="text-sm text-gray-500">Loading…</p>
              ) : segments.length === 0 ? (
                <p className="text-sm text-gray-500">No segments yet.</p>
              ) : (
                <ul className="space-y-2">
                  {segments.map((s) => (
                    <li
                      key={s.id}
                      className="border border-gray-200 rounded-lg p-3 flex items-start gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-900 truncate">
                          {s.name}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {summarize(s.filter)}
                        </p>
                      </div>
                      <button
                        onClick={() => startEdit(s)}
                        className="text-gray-400 hover:text-gray-700"
                        aria-label="Edit segment"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => remove(s.id)}
                        className="text-gray-400 hover:text-red-600"
                        aria-label="Delete segment"
                      >
                        <Trash2 size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
