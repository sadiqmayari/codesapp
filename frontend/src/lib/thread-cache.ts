// Shared in-memory per-conversation thread cache (stale-while-revalidate).
//
// Opening a chat you've seen this session renders its messages instantly from
// here instead of blanking + waiting on the network every switch. It's also
// warmed by the conversation list on hover / pointer-down (see prefetchThread),
// so even a FIRST open feels instant — the fetch starts before the click
// resolves, exactly how WhatsApp switches chats without a visible reload.
//
// LRU-capped; session-scoped (cleared on full reload). Lives in a module so
// both the thread page and the list share ONE cache.

import { apiFetch } from '@/lib/api';
import type { ConversationDetail, Message } from '@/lib/inbox-types';

const PAGE = 30;

export interface ThreadCacheEntry {
  convo: ConversationDetail | null;
  messages: Message[];
  nextCursor: number | null;
}

const THREAD_CACHE = new Map<number, ThreadCacheEntry>();
const THREAD_CACHE_MAX = 30;

export function getThread(cid: number): ThreadCacheEntry | undefined {
  return THREAD_CACHE.get(cid);
}

export function cacheThread(cid: number, entry: ThreadCacheEntry): void {
  THREAD_CACHE.delete(cid);
  THREAD_CACHE.set(cid, entry); // re-insert = most-recently-used
  if (THREAD_CACHE.size > THREAD_CACHE_MAX) {
    const oldest = THREAD_CACHE.keys().next().value;
    if (oldest !== undefined) THREAD_CACHE.delete(oldest);
  }
}

// De-dup concurrent prefetches for the same chat (hover fires repeatedly).
const inFlight = new Set<number>();

/**
 * Warm the cache for a conversation WITHOUT navigating. Called on row
 * hover/pointer-down so the messages are already fetched by the time the chat
 * opens. Best-effort and silent: never throws, never shows a spinner/toast, and
 * skips work when the chat is already cached or a fetch is already in flight.
 */
export async function prefetchThread(cid: number): Promise<void> {
  if (!Number.isFinite(cid) || THREAD_CACHE.has(cid) || inFlight.has(cid)) {
    return;
  }
  inFlight.add(cid);
  try {
    const [convo, msgRes] = await Promise.all([
      apiFetch<ConversationDetail>(`/inbox/conversations/${cid}`).catch(
        () => null,
      ),
      apiFetch<{ rows: Message[]; nextCursor: number | null }>(
        `/inbox/conversations/${cid}/messages`,
        { params: { limit: PAGE } },
      ).catch(() => null),
    ]);
    // Only seed the cache when we actually got messages; a half-result would
    // make the open render an empty thread. If the chat got opened (and thus
    // cached with live state) while we were fetching, don't clobber it.
    if (msgRes && !THREAD_CACHE.has(cid)) {
      cacheThread(cid, {
        convo,
        messages: [...msgRes.rows].reverse(),
        nextCursor: msgRes.nextCursor,
      });
    }
  } finally {
    inFlight.delete(cid);
  }
}
