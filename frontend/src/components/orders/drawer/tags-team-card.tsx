'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Tag, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import {
  setOrderTags,
  updateOrderNote,
  type AssignableUser,
  type OrderDetail,
} from '@/lib/orders';
import { Section } from './shared';

export function TagsTeamCard({
  d,
  liveTags,
  team,
  assigning,
  onAssign,
  readOnly,
  onNoteSaved,
}: {
  d: OrderDetail;
  /** Shopify tags from the live hydrate; undefined while loading / unavailable. */
  liveTags: string[] | undefined;
  team: AssignableUser[];
  assigning: boolean;
  onAssign: (userId: number | null) => void;
  readOnly: boolean;
  onNoteSaved: (note: string) => void;
}) {
  const toast = useToast();
  const o = d.order;
  const [tags, setTags] = useState<string[] | undefined>(liveTags);
  const [busyTag, setBusyTag] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState(o.internalNote ?? '');
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const savedNote = useRef(o.internalNote ?? '');

  useEffect(() => setTags(liveTags), [liveTags]);
  useEffect(() => {
    setNote(o.internalNote ?? '');
    savedNote.current = o.internalNote ?? '';
  }, [o.internalNote]);

  const changeTags = async (add: string[], remove: string[], key: string) => {
    const prev = tags ?? [];
    const next = [...prev.filter((t) => !remove.includes(t)), ...add.filter((t) => !prev.includes(t))];
    setTags(next);
    setBusyTag(key);
    try {
      await setOrderTags(o.orderGid, add, remove);
    } catch (e) {
      setTags(prev);
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not update tags in Shopify');
    } finally {
      setBusyTag(null);
    }
  };

  const submitTag = () => {
    const t = draft.trim();
    setDraft('');
    setAdding(false);
    if (!t || (tags ?? []).some((x) => x.toLowerCase() === t.toLowerCase())) return;
    void changeTags([t], [], `+${t}`);
  };

  const saveNote = async () => {
    if (note === savedNote.current) return;
    setNoteState('saving');
    try {
      await updateOrderNote(o.orderGid, note);
      savedNote.current = note;
      onNoteSaved(note);
      setNoteState('saved');
      setTimeout(() => setNoteState('idle'), 1500);
    } catch (e) {
      setNoteState('idle');
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not save the note');
    }
  };

  return (
    <Section title="Tags & team" icon={<Tag size={13} />}>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags === undefined ? (
          <span className="text-xs text-muted">Loading Shopify tags…</span>
        ) : (
          <>
            {tags.length === 0 && !adding && <span className="text-xs text-muted">No tags</span>}
            {tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-lg border border-line bg-sunken py-0.5 pl-2.5 pr-1 text-xs font-bold text-ink"
              >
                {t}
                {!readOnly &&
                  (busyTag === `-${t}` ? (
                    <Loader2 size={12} className="animate-spin text-muted" />
                  ) : (
                    <button
                      type="button"
                      aria-label={`Remove tag ${t}`}
                      onClick={() => changeTags([], [t], `-${t}`)}
                      disabled={!!busyTag}
                      className="rounded p-0.5 text-muted hover:bg-surface hover:text-rose-600"
                    >
                      <X size={12} />
                    </button>
                  ))}
              </span>
            ))}
            {!readOnly &&
              (adding ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={submitTag}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submitTag();
                    } else if (e.key === 'Escape') {
                      e.stopPropagation();
                      setDraft('');
                      setAdding(false);
                    }
                  }}
                  placeholder="New tag"
                  aria-label="New tag"
                  className="h-7 w-32 rounded-lg border border-line bg-surface px-2 text-xs text-ink"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  disabled={!!busyTag}
                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-dashed border-line px-2.5 text-xs font-bold text-muted hover:text-ink"
                >
                  {busyTag?.startsWith('+') ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                  Add tag
                </button>
              ))}
          </>
        )}
      </div>

      <div className="mt-3">
        <label htmlFor="order-internal-note" className="mb-1 block text-xs text-muted">
          Internal note <span className="text-muted/80">· only your team sees this</span>
        </label>
        {readOnly ? (
          <div className="min-h-[40px] rounded-xl border border-dashed border-amber-200 bg-amber-50/60 px-3 py-2 text-[13px] text-amber-900 [overflow-wrap:anywhere]">
            {o.internalNote || <span className="text-muted">No note</span>}
          </div>
        ) : (
          <>
            <textarea
              id="order-internal-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={saveNote}
              rows={2}
              placeholder="Add a note for your team…"
              className="w-full resize-y rounded-xl border border-dashed border-amber-300 bg-amber-50/60 px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:border-amber-400 focus:outline-none"
            />
            <div className="h-4 text-xs text-muted" aria-live="polite">
              {noteState === 'saving' ? 'Saving…' : noteState === 'saved' ? 'Saved' : note !== savedNote.current ? 'Saves when you click away' : ''}
            </div>
          </>
        )}
      </div>

      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="order-assignee" className="mb-1 block text-xs text-muted">
            Assigned to
          </label>
          {readOnly ? (
            <div className="text-[13px] font-bold text-ink">{d.assignedAgent?.name ?? 'Unassigned'}</div>
          ) : (
            <select
              id="order-assignee"
              value={d.assignedAgent?.id ?? ''}
              disabled={assigning}
              onChange={(e) => onAssign(e.target.value ? Number(e.target.value) : null)}
              className="h-8 w-full rounded-lg border border-line bg-surface px-2 text-[13px] font-bold text-ink disabled:opacity-60"
            >
              <option value="">Unassigned</option>
              {team.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <span className="mb-1 block text-xs text-muted">Created by</span>
          <div className="pt-1 text-[13px] font-bold text-ink">
            {d.createdByAgent?.name ??
              (o.source === 'codesapp' ? 'Agent (unknown)' : o.source ? `${o.source} checkout` : '—')}
          </div>
        </div>
      </div>
    </Section>
  );
}
