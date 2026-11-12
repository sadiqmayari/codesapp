'use client';

import { useSyncExternalStore } from 'react';

/**
 * Per-conversation composer drafts (Inbox-v2).
 *
 * The thread page is REMOUNTED on every chat switch (Next gives each `[id]` its
 * own React key), so a half-written reply, the reply-to quote and a staged
 * attachment used to vanish the moment an agent clicked another chat. Drafts
 * now live here, keyed by conversation id:
 *
 *  - `text` + `replyTo` are mirrored to sessionStorage (survive a reload of the
 *    tab, never shared across tabs/devices, cleared when the tab closes).
 *  - `staged` (a File + preview URL) is memory-only — Files can't be serialised.
 *
 * The conversation list subscribes (`useDraftText`) to show a "Draft:" preview.
 */

export interface DraftReplyRef {
  id: number;
  direction: 'inbound' | 'outbound';
  message_type: string;
  content?: string | null;
  media_url?: string | null;
}

export interface Draft<TStaged = unknown> {
  text: string;
  replyTo: DraftReplyRef | null;
  staged?: TStaged | null;
}

const KEY = 'ca_inbox_drafts_v1';
const drafts = new Map<number, Draft>();
const listeners = new Set<() => void>();
let hydrated = false;

function hydrate() {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, Draft>;
    for (const [k, v] of Object.entries(obj)) {
      if (v && (v.text || v.replyTo)) {
        drafts.set(Number(k), { text: v.text ?? '', replyTo: v.replyTo ?? null });
      }
    }
  } catch {
    /* corrupt / unavailable storage — start empty */
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (typeof window === 'undefined') return;
  if (persistTimer) clearTimeout(persistTimer);
  // Debounced: typing writes on every keystroke otherwise.
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const obj: Record<string, Pick<Draft, 'text' | 'replyTo'>> = {};
      drafts.forEach((d, k) => {
        if (d.text.trim() || d.replyTo) obj[k] = { text: d.text, replyTo: d.replyTo };
      });
      window.sessionStorage.setItem(KEY, JSON.stringify(obj));
    } catch {
      /* quota / private mode — drafts still work in memory */
    }
  }, 400);
}

function emit() {
  listeners.forEach((l) => l());
}

export function getDraft<TStaged = unknown>(id: number): Draft<TStaged> | null {
  hydrate();
  return (drafts.get(id) as Draft<TStaged> | undefined) ?? null;
}

/** Merge a partial update into a chat's draft. Empty drafts are dropped. */
export function setDraft<TStaged = unknown>(
  id: number,
  patch: Partial<Draft<TStaged>>,
) {
  hydrate();
  const cur = drafts.get(id) ?? { text: '', replyTo: null, staged: null };
  const next = { ...cur, ...patch } as Draft;
  const prevText = cur.text;
  if (!next.text.trim() && !next.replyTo && !next.staged) drafts.delete(id);
  else drafts.set(id, next);
  persist();
  // Only the text affects the list preview — don't wake every row on a
  // staged-file or reply change that leaves the text unchanged.
  if (prevText !== next.text) emit();
}

export function clearDraft(id: number) {
  hydrate();
  if (!drafts.has(id)) return;
  drafts.delete(id);
  persist();
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Draft text for a conversation (list "Draft:" preview). SSR-safe. */
export function useDraftText(id: number): string {
  return useSyncExternalStore(
    subscribe,
    () => getDraft(id)?.text ?? '',
    () => '',
  );
}
