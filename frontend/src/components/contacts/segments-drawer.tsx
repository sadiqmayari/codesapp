'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Megaphone, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { ContactStatus, Segment, SegmentFilter } from '@/lib/crm-types';
import { TagEditor } from './tag-editor';

const inputCls =
  'w-full h-9 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink focus:border-brand-500 focus:outline-none';

function summary(f: SegmentFilter): string {
  const parts: string[] = [];
  if (f.status) parts.push(f.status);
  if (f.tags?.length) parts.push(`${f.tagMode === 'any' ? 'any of' : 'tags'}: ${f.tags.join(', ')}`);
  if (f.excludeTags?.length) parts.push(`not: ${f.excludeTags.join(', ')}`);
  if (f.city) parts.push(`city: ${f.city}`);
  if (f.hasEmail === true) parts.push('has email');
  if (f.hasEmail === false) parts.push('no email');
  if (f.optedOut === false) parts.push('subscribed');
  if (f.optedOut === true) parts.push('opted out');
  if (f.lastMessageAfter) parts.push(`active after ${f.lastMessageAfter.slice(0, 10)}`);
  if (f.lastMessageBefore) parts.push(`active before ${f.lastMessageBefore.slice(0, 10)}`);
  return parts.join(' · ') || 'All contacts';
}

/**
 * Segment manager (Contacts 360): list with live member counts, create/edit
 * with tag suggestions and include/exclude tags, delete behind a confirm, and
 * a "Use in broadcast" deep link. Built on the shared `Modal` (dialog a11y).
 * Editing is owner/admin (`canManage`); everyone can view + use.
 */
export function SegmentsDrawer({
  open,
  onClose,
  onChanged,
  canManage = true,
  tagSuggestions = [],
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  canManage?: boolean;
  tagSuggestions?: string[];
  /** Filter the contacts list by this segment. */
  onApply?: (segmentId: number) => void;
}) {
  const toast = useToast();
  const [segments, setSegments] = useState<Segment[]>([]);
  const [counts, setCounts] = useState<Record<number, { total: number; sendable: number }>>({});
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Segment | 'new' | null>(null);
  const [confirmDel, setConfirmDel] = useState<Segment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [name, setName] = useState('');
  const [f, setF] = useState<SegmentFilter>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiFetch<Segment[]>('/contacts/segments');
      setSegments(list);
      // Counts load per segment; failures just leave the count blank.
      list.forEach((s) => {
        apiFetch<{ total: number; sendable: number }>(`/contacts/segments/${s.id}/count`)
          .then((c) => setCounts((cur) => ({ ...cur, [s.id]: c })))
          .catch(() => undefined);
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not load segments');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (open) {
      setEditing(null);
      void load();
    }
  }, [open, load]);

  const startEdit = (s: Segment | 'new') => {
    setEditing(s);
    setFormError('');
    setName(s === 'new' ? '' : s.name);
    setF(s === 'new' ? { status: 'active', optedOut: false } : { ...s.filter });
  };

  const save = async () => {
    if (!name.trim()) return setFormError('Give the segment a name');
    if (f.lastMessageAfter && f.lastMessageBefore && f.lastMessageAfter > f.lastMessageBefore) {
      return setFormError('"Active after" must be before "Active before"');
    }
    setFormError('');
    setSaving(true);
    // Drop empty values so the stored filter stays clean.
    const filter = Object.fromEntries(
      Object.entries(f).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)),
    );
    try {
      if (editing === 'new') {
        await apiFetch('/contacts/segments', { method: 'POST', body: { name: name.trim(), filter } });
        toast.success('Segment created');
      } else if (editing) {
        await apiFetch(`/contacts/segments/${editing.id}`, {
          method: 'PATCH',
          body: { name: name.trim(), filter },
        });
        toast.success('Segment saved');
      }
      setEditing(null);
      await load();
      onChanged();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.userMessage : 'Could not save the segment');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirmDel) return;
    setDeleting(true);
    try {
      await apiFetch(`/contacts/segments/${confirmDel.id}`, { method: 'DELETE' });
      toast.success('Segment deleted');
      setConfirmDel(null);
      await load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not delete');
    } finally {
      setDeleting(false);
    }
  };

  const set = (patch: Partial<SegmentFilter>) => setF((cur) => ({ ...cur, ...patch }));
  const triState = (v: boolean | undefined) => (v === true ? 'yes' : v === false ? 'no' : '');
  const fromTri = (v: string) => (v === 'yes' ? true : v === 'no' ? false : undefined);

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={editing ? (editing === 'new' ? 'New segment' : `Edit “${editing.name}”`) : 'Segments'}
        size="lg"
        footer={
          editing ? (
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)} disabled={saving}>
                Back
              </Button>
              <Button onClick={save} loading={saving}>
                Save segment
              </Button>
            </div>
          ) : undefined
        }
      >
        {!editing && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted">Saved filters you can apply to the list or send a broadcast to.</p>
              {canManage && (
                <Button size="sm" onClick={() => startEdit('new')}>
                  <Plus size={14} /> New segment
                </Button>
              )}
            </div>
            {loading && !segments.length ? (
              <SkeletonRows rows={3} />
            ) : segments.length === 0 ? (
              <EmptyState
                compact
                icon={Users}
                title="No segments yet"
                description="Group contacts by tag, city, activity or consent — e.g. “VIP in Lahore, active this month”."
              />
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {segments.map((s) => {
                  const c = counts[s.id];
                  return (
                    <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-ink truncate">{s.name}</span>
                          {c && (
                            <Badge tone="neutral" title={`${c.sendable.toLocaleString()} can receive broadcasts`}>
                              {c.total.toLocaleString()} contacts
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted truncate">{summary(s.filter)}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        {onApply && (
                          <Button size="sm" variant="secondary" onClick={() => onApply(s.id)}>
                            Show contacts
                          </Button>
                        )}
                        <Link
                          href={`/broadcasts/new?segment=${s.id}`}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-ink hover:bg-sunken"
                        >
                          <Megaphone size={13} /> Broadcast
                        </Link>
                        {canManage && (
                          <>
                            <button
                              type="button"
                              onClick={() => startEdit(s)}
                              aria-label={`Edit segment ${s.name}`}
                              className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-muted hover:text-ink hover:bg-sunken"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDel(s)}
                              aria-label={`Delete segment ${s.name}`}
                              className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-muted hover:text-red-600 hover:bg-sunken"
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {editing && (
          <div className="space-y-4">
            {formError && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {formError}
              </div>
            )}
            <div>
              <label htmlFor="seg-name" className="block text-xs font-semibold text-ink mb-1">
                Name
              </label>
              <input id="seg-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} className={inputCls} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="seg-status" className="block text-xs font-semibold text-ink mb-1">
                  Status
                </label>
                <select
                  id="seg-status"
                  value={f.status ?? ''}
                  onChange={(e) => set({ status: (e.target.value || undefined) as ContactStatus | undefined })}
                  className={inputCls}
                >
                  <option value="">Any status</option>
                  <option value="active">Active</option>
                  <option value="blocked">Blocked</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
              <div>
                <label htmlFor="seg-city" className="block text-xs font-semibold text-ink mb-1">
                  City
                </label>
                <input
                  id="seg-city"
                  value={f.city ?? ''}
                  onChange={(e) => set({ city: e.target.value || undefined })}
                  placeholder="Any city"
                  className={inputCls}
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-ink">Has tags</span>
                <div className="inline-flex rounded-lg border border-line overflow-hidden text-xs" role="group" aria-label="Tag match">
                  {(['all', 'any'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={(f.tagMode ?? 'all') === m}
                      onClick={() => set({ tagMode: m })}
                      className={cn(
                        'px-2.5 py-1 font-semibold',
                        (f.tagMode ?? 'all') === m ? 'bg-ink text-surface' : 'text-muted hover:bg-sunken',
                      )}
                    >
                      {m === 'all' ? 'All of' : 'Any of'}
                    </button>
                  ))}
                </div>
              </div>
              <TagEditor tags={f.tags ?? []} onChange={(t) => set({ tags: t })} suggestions={tagSuggestions} label="Add required tag" />
            </div>
            <div>
              <span className="block text-xs font-semibold text-ink mb-1">Doesn’t have tags</span>
              <TagEditor
                tags={f.excludeTags ?? []}
                onChange={(t) => set({ excludeTags: t })}
                suggestions={tagSuggestions}
                label="Add excluded tag"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="seg-after" className="block text-xs font-semibold text-ink mb-1">
                  Last message on or after
                </label>
                <input
                  id="seg-after"
                  type="date"
                  value={f.lastMessageAfter?.slice(0, 10) ?? ''}
                  onChange={(e) => set({ lastMessageAfter: e.target.value || undefined })}
                  className={inputCls}
                />
              </div>
              <div>
                <label htmlFor="seg-before" className="block text-xs font-semibold text-ink mb-1">
                  Last message on or before
                </label>
                <input
                  id="seg-before"
                  type="date"
                  value={f.lastMessageBefore?.slice(0, 10) ?? ''}
                  onChange={(e) => set({ lastMessageBefore: e.target.value || undefined })}
                  className={inputCls}
                />
              </div>
              <div>
                <label htmlFor="seg-email" className="block text-xs font-semibold text-ink mb-1">
                  Email
                </label>
                <select
                  id="seg-email"
                  value={triState(f.hasEmail)}
                  onChange={(e) => set({ hasEmail: fromTri(e.target.value) })}
                  className={inputCls}
                >
                  <option value="">Any</option>
                  <option value="yes">Has email</option>
                  <option value="no">No email</option>
                </select>
              </div>
              <div>
                <label htmlFor="seg-consent" className="block text-xs font-semibold text-ink mb-1">
                  Marketing consent
                </label>
                <select
                  id="seg-consent"
                  value={triState(f.optedOut === undefined ? undefined : !f.optedOut)}
                  onChange={(e) => {
                    const v = fromTri(e.target.value);
                    set({ optedOut: v === undefined ? undefined : !v });
                  }}
                  className={inputCls}
                >
                  <option value="">Any</option>
                  <option value="yes">Subscribed</option>
                  <option value="no">Opted out</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-muted">
              Broadcasts always skip blocked and opted-out contacts, whatever the segment says.
            </p>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirmDel}
        title="Delete segment?"
        message={`“${confirmDel?.name ?? ''}” will be removed. Contacts are not affected. Scheduled broadcasts that use it will have no audience.`}
        confirmLabel="Delete"
        danger
        busy={deleting}
        onConfirm={remove}
        onCancel={() => setConfirmDel(null)}
      />
    </>
  );
}
