'use client';

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowUp,
  Bot,
  Check,
  CheckCheck,
  CheckCircle2,
  Clock,
  FileText,
  Image as ImageIcon,
  LayoutTemplate,
  MailOpen,
  MessageSquare,
  MessagesSquare,
  Mic,
  MoreVertical,
  Phone,
  Pin,
  PinOff,
  RotateCcw,
  Search,
  SearchX,
  Sticker,
  Tag,
  UserCheck,
  Video,
  WifiOff,
  X,
} from 'lucide-react';
import CallsPanel from '@/components/inbox/calls-panel';
import { apiFetch, apiFetchEnvelope, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';
import { cn, fmtListTime } from '@/lib/utils';
import { stripWaFormatting } from '@/lib/url-detect';
import { prefetchThread } from '@/lib/thread-cache';
import { useDraftText } from '@/lib/draft-store';
import { avatarColor, initialsOf } from '@/lib/avatar';
import type {
  ConversationRow,
  MessageStatus,
  MessageType,
} from '@/lib/inbox-types';
import type { TeamMember } from '@/lib/crm-types';
import { PinnedByTeam } from '@/components/inbox/pinned-by-team';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Dropdown, type DropdownItem } from '@/components/ui/dropdown';

const STATUSES = ['all', 'unread', 'open', 'pending', 'resolved'] as const;
type ListStatus = (typeof STATUSES)[number];
const STATUS_LABEL: Record<ListStatus, string> = {
  all: 'All',
  unread: 'Unread',
  open: 'Open',
  pending: 'Pending',
  resolved: 'Resolved',
};

// useLayoutEffect on the client (to correct scroll before paint), useEffect on
// the server (avoids the SSR "useLayoutEffect does nothing" warning).
const useIsoLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Server-mirrored list order (Shell-Polish-B): pinned conversations sticky-top
// (newest pin first), then most-recent message first. Used by the realtime
// splice so a new/updated chat lands exactly where the server would put it.
function sortConversationRows(rows: ConversationRow[]): ConversationRow[] {
  const t = (s: string | null) => (s ? new Date(s).getTime() : 0);
  return rows.slice().sort((a, b) => {
    const ap = t(a.pinned_at);
    const bp = t(b.pinned_at);
    if (ap !== bp) return bp - ap;
    return (
      t(b.last_message_at ?? b.updated_at) - t(a.last_message_at ?? a.updated_at)
    );
  });
}

// Filters persist in the URL query (Inbox-v2) so a reload / shared link keeps
// the view. Read once on mount from window.location (useSearchParams would
// force a Suspense boundary around the whole inbox layout).
interface ListFilters {
  status: ListStatus;
  mine: boolean;
  assignee: string;
  label: string;
  search: string;
}
const DEFAULT_FILTERS: ListFilters = {
  status: 'all',
  mine: false,
  assignee: '',
  label: '',
  search: '',
};
function readFiltersFromUrl(): ListFilters {
  if (typeof window === 'undefined') return DEFAULT_FILTERS;
  const q = new URLSearchParams(window.location.search);
  const st = q.get('status') as ListStatus | null;
  return {
    status: st && STATUSES.includes(st) ? st : 'all',
    mine: q.get('mine') === '1',
    assignee: q.get('assignee') ?? '',
    label: q.get('label') ?? '',
    search: q.get('q') ?? '',
  };
}
function filtersToQuery(f: ListFilters): string {
  const q = new URLSearchParams();
  if (f.status !== 'all') q.set('status', f.status);
  if (f.mine) q.set('mine', '1');
  if (f.assignee) q.set('assignee', f.assignee);
  if (f.label) q.set('label', f.label);
  if (f.search) q.set('q', f.search);
  const s = q.toString();
  return s ? `?${s}` : '';
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}

export default function InboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const params = useParams();
  const activeId = params?.id ? Number(params.id) : null;
  const { user } = useAuth();
  const { on, reconnectSeq } = useSocket();
  const toast = useToast();

  const [panel, setPanel] = useState<'chats' | 'calls'>('chats');
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [filters, setFilters] = useState<ListFilters>(DEFAULT_FILTERS);
  const { status, mine, assignee, label, search } = filters;
  // The search box updates instantly; the QUERY follows 300ms later so typing
  // "ayesha" is one request, not six (and an older slow response can never
  // overwrite a newer one — see filterSeq below).
  const [searchInput, setSearchInput] = useState('');
  const canManage = user?.role === 'owner' || user?.role === 'admin';
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [labelOptions, setLabelOptions] = useState<{ label: string; count: number }[]>([]);
  const [total, setTotal] = useState(0);
  // Live count of unread conversations (chip count on every tab). null = unknown.
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  // Teammates currently replying in a chat (from typing.start/stop), keyed by
  // conversation. Names are shown to owners/admins only (collision rule).
  const [typingMap, setTypingMap] = useState<Record<number, { name: string; at: number }>>({});
  // "N new chats ↑" pill when the agent is scrolled down and new activity
  // lands at the top out of view.
  const [newAbove, setNewAbove] = useState(0);
  const pageRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const limit = 20;

  const rowsRef = useRef<ConversationRow[]>([]);
  rowsRef.current = rows;
  const activeIdRef = useRef<number | null>(activeId);
  activeIdRef.current = activeId;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // Bumped on every filter change. A response is only applied if the filter
  // it was requested under is still the current one — stops a slow search /
  // loadMore from an old filter landing in the new list.
  const filterSeq = useRef(0);

  // Restore filters from the URL once on mount.
  const hydratedRef = useRef(false);
  useEffect(() => {
    const f = readFiltersFromUrl();
    hydratedRef.current = true;
    setFilters(f);
    setSearchInput(f.search);
  }, []);

  // Mirror filters into the URL (replaceState keeps history clean).
  const queryString = filtersToQuery(filters);
  useEffect(() => {
    if (!hydratedRef.current || typeof window === 'undefined') return;
    const url = `${window.location.pathname}${queryString}`;
    if (url !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(window.history.state, '', url);
    }
  }, [queryString, activeId]);

  // Debounce search input → filter.
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.search === searchInput.trim() ? f : { ...f, search: searchInput.trim() }));
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const patchFilters = useCallback((p: Partial<ListFilters>) => {
    setFilters((f) => ({ ...f, ...p }));
  }, []);
  const clearFilters = useCallback(() => {
    setSearchInput('');
    setFilters(DEFAULT_FILTERS);
  }, []);
  const filtersActive =
    !!search || !!label || mine || (canManage && !!assignee);

  // Optimistically clear the opened chat's unread badge the instant it opens.
  useEffect(() => {
    if (activeId == null) return;
    const wasUnread = rowsRef.current.some(
      (r) => r.id === activeId && (r.unread_count ?? 0) > 0,
    );
    if (wasUnread) {
      setRows((cur) =>
        cur.map((r) => (r.id === activeId ? { ...r, unread_count: 0 } : r)),
      );
      setUnreadCount((c) => (c == null ? c : Math.max(0, c - 1)));
    }
  }, [activeId]);

  const fetchPage = useCallback(
    async (pageNum: number) => {
      const env = await apiFetchEnvelope<ConversationRow[]>(
        '/inbox/conversations',
        {
          params: {
            status: status === 'all' ? undefined : status,
            assignedUserId: mine
              ? user?.id
              : canManage && assignee && assignee !== 'unassigned'
                ? Number(assignee)
                : undefined,
            unassigned:
              !mine && canManage && assignee === 'unassigned'
                ? 'true'
                : undefined,
            label: label || undefined,
            search: search || undefined,
            page: pageNum,
            limit,
          },
        },
      );
      return {
        data: env.data,
        total: (env.meta?.total as number) ?? env.data.length,
      };
    },
    [status, mine, assignee, canManage, label, search, user],
  );

  // Authoritative unread-conversation count (cheap: limit 1, read meta.total).
  // Seeded on mount, after every reconnect and when the tab regains focus, so
  // socket-delta drift (off-page chats, other agents) self-heals.
  const refreshUnreadCount = useCallback(() => {
    apiFetchEnvelope<ConversationRow[]>('/inbox/conversations', {
      params: { status: 'unread', page: 1, limit: 1 },
    })
      .then((env) => setUnreadCount((env.meta?.total as number) ?? 0))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshUnreadCount();
    let last = Date.now();
    const onFocus = () => {
      if (Date.now() - last < 30_000) return;
      last = Date.now();
      refreshUnreadCount();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshUnreadCount]);

  useEffect(() => {
    if (!canManage) return;
    apiFetch<TeamMember[]>('/team')
      .then((r) => setMembers(Array.isArray(r) ? r : []))
      .catch(() => setMembers([]));
  }, [canManage]);

  const loadLabelOptions = useCallback(() => {
    apiFetch<{ label: string; count: number }[]>('/inbox/labels')
      .then((r) => setLabelOptions(Array.isArray(r) ? r : []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadLabelOptions();
  }, [loadLabelOptions]);

  // (Re)load. `silent` = background refresh of every loaded page (keeps scroll
  // and pagination); non-silent = fresh page 1 for a new filter.
  const load = useCallback(
    async (silent = false) => {
      const seq = filterSeq.current;
      if (!silent) {
        setLoading(true);
        setLoadError(false);
      }
      const pagesToLoad = silent ? Math.max(1, pageRef.current) : 1;
      try {
        const results = await Promise.all(
          Array.from({ length: pagesToLoad }, (_, i) => fetchPage(i + 1)),
        );
        if (seq !== filterSeq.current) return; // filter changed mid-flight
        if (!silent) pageRef.current = 1;
        const seen = new Set<number>();
        const data = results
          .flatMap((r) => r.data)
          .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
        const t = results[results.length - 1]?.total ?? data.length;
        // WhatsApp-style sticky unread: keep the open chat visible under the
        // Unread filter even after it's read — placed in its sorted slot, not
        // forced to the top.
        let merged = data;
        const aid = activeIdRef.current;
        if (status === 'unread' && aid != null && !data.some((r) => r.id === aid)) {
          const cached = rowsRef.current.find((r) => r.id === aid);
          if (cached) merged = sortConversationRows([cached, ...data]);
        }
        setRows((prev) => reconcileRows(prev, merged));
        setTotal(t);
        setLoadError(false);
        if (status === 'unread') setUnreadCount(t);
      } catch (e) {
        if (seq !== filterSeq.current) return;
        if (!silent) {
          setLoadError(true);
          toast.error(
            e instanceof ApiError ? e.userMessage : 'Failed to load conversations',
          );
        }
      } finally {
        if (!silent && seq === filterSeq.current) setLoading(false);
      }
    },
    [fetchPage, toast, status],
  );

  // Coalesce bursty socket-triggered refreshes into one silent refetch.
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleLoad = useCallback(
    (delay = 500) => {
      if (loadTimer.current) clearTimeout(loadTimer.current);
      loadTimer.current = setTimeout(() => {
        loadTimer.current = null;
        void load(true);
      }, delay);
    },
    [load],
  );
  useEffect(
    () => () => {
      if (loadTimer.current) clearTimeout(loadTimer.current);
    },
    [],
  );

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    if (rowsRef.current.length >= total) return;
    const seq = filterSeq.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const next = pageRef.current + 1;
      const { data, total: t } = await fetchPage(next);
      if (seq !== filterSeq.current) return;
      pageRef.current = next;
      if (data.length === 0) {
        // Nothing more on the server — stop asking (an inflated total used to
        // keep firing empty-page requests on every scroll).
        setTotal(rowsRef.current.length);
        return;
      }
      setTotal(t);
      setRows((cur) => {
        const seen = new Set(cur.map((r) => r.id));
        return [...cur, ...data.filter((r) => !seen.has(r.id))];
      });
    } catch {
      /* keep what we have; scroll again to retry */
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [fetchPage, total]);

  // New filter → fresh list from the top.
  useEffect(() => {
    filterSeq.current += 1;
    anchorsRef.current = [];
    setNewAbove(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPage]);

  // ── Scroll-anchor preservation (unchanged behaviour) ─────────────────────
  const anchorsRef = useRef<{ id: number; delta: number }[]>([]);
  const captureAnchors = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      anchorsRef.current = [];
      return;
    }
    const s = el.scrollTop;
    if (s <= 4) {
      anchorsRef.current = [];
      return;
    }
    const out: { id: number; delta: number }[] = [];
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const cid = child.dataset?.cid;
      if (!cid) continue;
      const top = child.offsetTop;
      if (top + child.offsetHeight > s + 1) {
        out.push({ id: Number(cid), delta: top - s });
        if (out.length >= 4) break;
      }
    }
    anchorsRef.current = out;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    captureAnchors();
    if (el.scrollTop <= 4) setNewAbove(0);
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      void loadMore();
    }
  }, [loadMore, captureAnchors]);

  /** Note activity that landed above the viewport while scrolled down. */
  const noteNewAbove = useCallback(() => {
    const el = scrollRef.current;
    if (el && el.scrollTop > 120) setNewAbove((n) => n + 1);
  }, []);

  // ── Realtime ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const offRecv = on<{
      conversationId: number;
      contactId?: number;
      contactName?: string;
      contactPhone?: string;
      windowExpiresAt?: string;
      status?: ConversationRow['status'];
      unreadCount?: number;
      message?: {
        id?: number;
        content?: string | null;
        message_type?: string | null;
        timestamp?: string | null;
      };
    }>('message.received', (p) => {
      const f = filtersRef.current;
      const isActive = p.conversationId === activeIdRef.current;
      const when = p.message?.timestamp ?? new Date().toISOString();
      const idx = rowsRef.current.findIndex((r) => r.id === p.conversationId);
      // A typing teammate is no longer "replying" once the customer writes
      // again? No — keep it; only typing.stop / expiry clears it.
      if (idx === -1) {
        // Only splice when the row is guaranteed to belong in this view. Under
        // any narrowing filter we can't tell (assignee/label/search), so refetch.
        const narrow =
          !!f.search || !!f.label || f.mine || !!f.assignee ||
          (f.status !== 'all' && f.status !== 'unread' && f.status !== 'open');
        if (narrow) {
          scheduleLoad();
          return;
        }
        const newRow: ConversationRow = {
          id: p.conversationId,
          contact: {
            id: p.contactId ?? 0,
            name: p.contactName ?? p.contactPhone ?? 'Unknown',
            phone: p.contactPhone ?? '',
            email: null,
          },
          assigned_user: null,
          labels: [],
          status: p.status ?? 'open',
          last_message: p.message?.content ?? null,
          last_message_at: when,
          last_message_id: p.message?.id ?? null,
          last_message_type: (p.message?.message_type as MessageType) ?? null,
          last_message_direction: 'inbound',
          last_message_status: null,
          unread_count: isActive ? 0 : p.unreadCount ?? 1,
          window_expires_at: p.windowExpiresAt ?? null,
          pinned_at: null,
          ai_autoreply: null,
          updated_at: when,
        };
        setRows((cur) =>
          cur.some((r) => r.id === p.conversationId)
            ? cur
            : sortConversationRows([newRow, ...cur]),
        );
        if (!isActive && (p.unreadCount ?? 1) <= 1) {
          setUnreadCount((c) => (c == null ? c : c + 1));
        }
        noteNewAbove();
        // The placeholder lacks labels/assignee/AI flag — fill them in with a
        // slow, coalesced background refetch (never a per-message storm).
        scheduleLoad(3000);
        return;
      }
      const prev = rowsRef.current[idx];
      if (prev && (prev.unread_count ?? 0) === 0 && !isActive) {
        setUnreadCount((c) => (c == null ? c : c + 1));
      }
      if (idx > 0) noteNewAbove();
      setRows((cur) => {
        const i = cur.findIndex((r) => r.id === p.conversationId);
        if (i === -1) return cur;
        const existing = cur[i];
        const updated: ConversationRow = {
          ...existing,
          // The backend reopens a resolved chat on inbound + extends the window.
          status: p.status ?? (existing.status === 'resolved' ? 'open' : existing.status),
          window_expires_at: p.windowExpiresAt ?? existing.window_expires_at,
          unread_count: isActive
            ? 0
            : p.unreadCount ?? (existing.unread_count ?? 0) + 1,
          updated_at: when,
          last_message_at: when,
          last_message: p.message?.content ?? existing.last_message ?? null,
          last_message_id: p.message?.id ?? existing.last_message_id ?? null,
          last_message_type: (p.message?.message_type as MessageType) ?? null,
          last_message_direction: 'inbound',
          last_message_status: null,
        };
        return sortConversationRows([updated, ...cur.slice(0, i), ...cur.slice(i + 1)]);
      });
    });

    const offSent = on<{
      message: {
        id?: number;
        conversation_id: number;
        content?: string | null;
        message_type?: MessageType | null;
        status?: MessageStatus | null;
        timestamp?: string | null;
      };
    }>('message.sent', (p) => {
      const m = p.message;
      if (!m || typeof m.conversation_id !== 'number') return;
      const idx = rowsRef.current.findIndex((r) => r.id === m.conversation_id);
      if (idx === -1) {
        scheduleLoad();
        return;
      }
      setRows((cur) => {
        const i = cur.findIndex((r) => r.id === m.conversation_id);
        if (i === -1) return cur;
        const existing = cur[i];
        const when = m.timestamp ?? new Date().toISOString();
        const updated: ConversationRow = {
          ...existing,
          updated_at: when,
          last_message_at: when,
          last_message: m.content ?? existing.last_message ?? null,
          last_message_id: m.id ?? existing.last_message_id ?? null,
          last_message_type: (m.message_type as MessageType) ?? null,
          last_message_direction: 'outbound',
          last_message_status: (m.status as MessageStatus) ?? 'sent',
        };
        return sortConversationRows([updated, ...cur.slice(0, i), ...cur.slice(i + 1)]);
      });
    });

    // Live preview ticks (✓ → ✓✓ → blue, ✕ on failure). The row only changes
    // when the status is for ITS latest message.
    const offStatus = on<{
      messageId: number;
      conversationId?: number;
      status: MessageStatus;
    }>('message.status', (p) => {
      setRows((cur) => {
        let changed = false;
        const next = cur.map((r) => {
          if (
            r.last_message_id === p.messageId &&
            r.last_message_direction === 'outbound' &&
            r.last_message_status !== p.status
          ) {
            changed = true;
            return { ...r, last_message_status: p.status };
          }
          return r;
        });
        return changed ? next : cur;
      });
    });

    const offRemoved = on<{ conversationId: number; messageId: number }>(
      'message.removed',
      (p) => {
        if (rowsRef.current.some((r) => r.id === p.conversationId && r.last_message_id === p.messageId)) {
          scheduleLoad();
        }
      },
    );

    const offRead = on<{ conversationId: number }>('message.read.bulk', (p) => {
      const wasUnread = rowsRef.current.some(
        (r) => r.id === p.conversationId && (r.unread_count ?? 0) > 0,
      );
      if (wasUnread) {
        setUnreadCount((c) => (c == null ? c : Math.max(0, c - 1)));
        setRows((cur) =>
          cur.map((r) =>
            r.id === p.conversationId ? { ...r, unread_count: 0 } : r,
          ),
        );
      } else if (!rowsRef.current.some((r) => r.id === p.conversationId)) {
        // Off-page chat read elsewhere — our delta can't know; re-seed.
        refreshUnreadCount();
      }
    });

    const offAssigned = on('conversation.assigned', () => scheduleLoad());
    const offUpdated = on<{ conversationId: number; markedUnread?: boolean }>(
      'conversation.updated',
      (p) => {
        if (p?.markedUnread) refreshUnreadCount();
        scheduleLoad();
      },
    );
    const offReassigned = on('conversations.reassigned', () => scheduleLoad());
    const offContact = on<{ contactId: number }>('contact.updated', (p) => {
      if (rowsRef.current.some((r) => r.contact?.id === p.contactId)) scheduleLoad();
    });

    // Teammate typing → "Sara is replying…" on the row (expires after 6s).
    const offTypeStart = on<{ conversationId: number; userId: number; userName?: string }>(
      'typing.start',
      (p) => {
        if (p.userId === user?.id) return;
        setTypingMap((m) => ({
          ...m,
          [p.conversationId]: { name: p.userName ?? '', at: Date.now() },
        }));
      },
    );
    const offTypeStop = on<{ conversationId: number; userId: number }>(
      'typing.stop',
      (p) => {
        if (p.userId === user?.id) return;
        setTypingMap((m) => {
          if (!m[p.conversationId]) return m;
          const n = { ...m };
          delete n[p.conversationId];
          return n;
        });
      },
    );
    return () => {
      offRecv();
      offSent();
      offStatus();
      offRemoved();
      offRead();
      offAssigned();
      offUpdated();
      offReassigned();
      offContact();
      offTypeStart();
      offTypeStop();
    };
  }, [on, scheduleLoad, noteNewAbove, refreshUnreadCount, user?.id]);

  // Expire stale "replying…" markers (a teammate who closed the tab mid-typing
  // never sends typing.stop).
  useEffect(() => {
    if (Object.keys(typingMap).length === 0) return;
    const t = setInterval(() => {
      setTypingMap((m) => {
        const now = Date.now();
        let changed = false;
        const n: typeof m = {};
        for (const [k, v] of Object.entries(m)) {
          if (now - v.at < 6000) n[Number(k)] = v;
          else changed = true;
        }
        return changed ? n : m;
      });
    }, 2000);
    return () => clearInterval(t);
  }, [typingMap]);

  // Catch up after ANY reconnect (raw, not debounced): socket.io never replays
  // events missed while offline. Silent = keeps loaded pages + scroll.
  const seenReconnect = useRef(reconnectSeq);
  useEffect(() => {
    if (reconnectSeq === seenReconnect.current) return;
    seenReconnect.current = reconnectSeq;
    void load(true);
    refreshUnreadCount();
  }, [reconnectSeq, load, refreshUnreadCount]);

  const hasMore = rows.length < total;

  const displayRows = useMemo(() => {
    if (status !== 'unread') return rows;
    return rows.filter((r) => (r.unread_count ?? 0) > 0 || r.id === activeId);
  }, [rows, status, activeId]);

  useIsoLayoutEffect(() => {
    const el = scrollRef.current;
    const anchors = anchorsRef.current;
    if (!el || anchors.length === 0) return;
    for (const a of anchors) {
      const rowEl = el.querySelector<HTMLElement>(`[data-cid="${a.id}"]`);
      if (!rowEl) continue;
      const target = rowEl.offsetTop - a.delta;
      if (Math.abs(target - el.scrollTop) < 1) return;
      if (target < 24) continue;
      el.scrollTop = target;
      return;
    }
  }, [displayRows]);

  const routerRef = useRef(router);
  routerRef.current = router;
  const queryRef = useRef(queryString);
  queryRef.current = queryString;
  const openConversation = useCallback((rowId: number) => {
    // Keep the list's filters in the URL across chat opens.
    routerRef.current.push(`/inbox/${rowId}${queryRef.current}`);
  }, []);

  // ── Row actions (row menu) ────────────────────────────────────────────────
  const rowAction = useCallback(
    async (row: ConversationRow, action: 'unread' | 'read' | 'pin' | 'unpin' | 'resolve' | 'reopen' | 'assign-me') => {
      const paths: Record<typeof action, string> = {
        unread: `/inbox/conversations/${row.id}/unread`,
        read: `/inbox/conversations/${row.id}/mark-read`,
        pin: `/inbox/conversations/${row.id}/pin`,
        unpin: `/inbox/conversations/${row.id}/unpin`,
        resolve: `/inbox/conversations/${row.id}/resolve`,
        reopen: `/inbox/conversations/${row.id}/reopen`,
        'assign-me': `/inbox/conversations/${row.id}/assign`,
      };
      // Optimistic patch for the instant-feedback ones.
      if (action === 'unread' || action === 'read') {
        setRows((cur) =>
          cur.map((r) =>
            r.id === row.id ? { ...r, unread_count: action === 'unread' ? Math.max(1, r.unread_count) : 0 } : r,
          ),
        );
        setUnreadCount((c) =>
          c == null ? c : action === 'unread' ? (row.unread_count > 0 ? c : c + 1) : Math.max(0, c - (row.unread_count > 0 ? 1 : 0)),
        );
      }
      try {
        await apiFetch(paths[action], {
          method: 'POST',
          body: action === 'assign-me' ? { userId: user?.id } : undefined,
        });
        if (action === 'pin' || action === 'unpin' || action === 'resolve' || action === 'reopen' || action === 'assign-me') {
          scheduleLoad(150);
        }
        const msg: Partial<Record<typeof action, string>> = {
          unread: 'Marked as unread',
          resolve: 'Conversation resolved',
          reopen: 'Conversation reopened',
          'assign-me': 'Assigned to you',
        };
        if (msg[action]) toast.success(msg[action]!);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.userMessage : 'Action failed');
        scheduleLoad(0);
      }
    },
    [toast, scheduleLoad, user?.id],
  );

  const displayRowsRef = useRef(displayRows);
  displayRowsRef.current = displayRows;

  // ── Keyboard: j/k (or ↑/↓ outside inputs) step chats, "/" focuses search ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // Never steal keys from an open drawer/dialog (CLAUDE.md rule).
      if (document.querySelector('[data-order-drawer],[aria-modal="true"]')) return;
      if (panel !== 'chats') return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key !== 'j' && e.key !== 'k') return;
      const list = displayRowsRef.current;
      if (!list.length) return;
      const i = list.findIndex((r) => r.id === activeIdRef.current);
      const next =
        e.key === 'j'
          ? list[Math.min(list.length - 1, i + 1)]
          : list[Math.max(0, i === -1 ? 0 : i - 1)];
      if (next && next.id !== activeIdRef.current) {
        e.preventDefault();
        openConversation(next.id);
        scrollRef.current
          ?.querySelector<HTMLElement>(`[data-cid="${next.id}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openConversation, panel]);
  const unreadTabCount = unreadCount ?? 0;
  const assigneeName = (id: string) =>
    id === 'unassigned' ? 'Unassigned' : members.find((m) => String(m.id) === id)?.name ?? 'Agent';

  const busy = loading && rows.length > 0;

  return (
    <div className="flex h-full">
      <div
        className={cn(
          'w-full md:w-80 lg:w-96 shrink-0 border-r border-line bg-surface flex flex-col',
          activeId != null && 'hidden md:flex',
        )}
      >
        <div className="px-2 pt-2">
          <div role="tablist" aria-label="Inbox view" className="flex gap-1 rounded-lg bg-sunken p-1">
            {(['chats', 'calls'] as const).map((p) => (
              <button
                key={p}
                role="tab"
                aria-selected={panel === p}
                onClick={() => setPanel(p)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-semibold',
                  panel === p
                    ? 'bg-surface text-brand-700 shadow-sm'
                    : 'text-muted hover:text-ink',
                )}
              >
                {p === 'chats' ? <MessageSquare size={15} /> : <Phone size={15} />}
                {p === 'chats' ? 'Chats' : 'Calls'}
              </button>
            ))}
          </div>
        </div>

        {panel === 'calls' ? (
          <CallsPanel onOpen={openConversation} activeId={activeId} />
        ) : (
          <>
            <div className="p-3 border-b border-line space-y-2">
              <div className="relative">
                <Search size={16} className="absolute left-3 top-2.5 text-muted" aria-hidden />
                <input
                  ref={searchRef}
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSearchInput('');
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  placeholder="Search name, phone or message"
                  aria-label="Search conversations"
                  type="search"
                  name="inbox-conversation-search"
                  autoComplete="off"
                  className="w-full pl-9 pr-10 py-2 text-sm bg-surface border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <kbd className="pointer-events-none absolute right-2.5 top-2 hidden rounded border border-line px-1.5 text-xs text-muted md:inline">
                  /
                </kbd>
              </div>
              <div className="flex gap-1 flex-wrap" role="group" aria-label="Filter by status">
                {STATUSES.map((s) => (
                  <button
                    key={s}
                    onClick={() => patchFilters({ status: s })}
                    aria-pressed={status === s}
                    className={cn(
                      'inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-full',
                      status === s
                        ? 'bg-brand-600 text-white'
                        : 'bg-sunken text-muted hover:text-ink',
                    )}
                  >
                    {STATUS_LABEL[s]}
                    {s === 'unread' && unreadTabCount > 0 && (
                      <span
                        className={cn(
                          'rounded-full px-1.5 tabular-nums',
                          status === s ? 'bg-white/25' : 'bg-brand-600 text-white',
                        )}
                        aria-label={`${unreadTabCount} unread conversations`}
                      >
                        {unreadTabCount}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => patchFilters({ mine: !mine, assignee: '' })}
                  aria-pressed={mine}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-semibold',
                    mine ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-dashed border-line text-muted hover:text-ink',
                  )}
                >
                  <UserCheck size={13} /> Mine
                </button>
                <LabelFilter
                  value={label}
                  options={labelOptions}
                  onOpen={loadLabelOptions}
                  onChange={(v) => patchFilters({ label: v })}
                />
                {canManage && !mine && (
                  <select
                    value={assignee}
                    onChange={(e) => patchFilters({ assignee: e.target.value })}
                    aria-label="Filter by assigned agent"
                    className={cn(
                      'rounded-lg border px-2 py-1 text-xs font-semibold bg-surface max-w-[9.5rem]',
                      assignee ? 'border-brand-600 text-brand-700' : 'border-dashed border-line text-muted',
                    )}
                  >
                    <option value="">Anyone</option>
                    <option value="unassigned">Unassigned</option>
                    {members.map((mem) => (
                      <option key={mem.id} value={String(mem.id)}>
                        {mem.name}
                        {mem.id === user?.id ? ' (me)' : ''}
                      </option>
                    ))}
                  </select>
                )}
                {filtersActive && (
                  <button
                    onClick={clearFilters}
                    className="ml-auto text-xs font-semibold text-brand-700 hover:underline"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            <div className="relative flex-1 min-h-0">
              {/* Thin progress bar while a new filter loads over the old rows. */}
              {busy && (
                <div className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-brand-100" aria-hidden>
                  <div className="h-full w-1/3 animate-[inboxbar_1s_ease-in-out_infinite] bg-brand-600" />
                </div>
              )}
              {newAbove > 0 && (
                <button
                  onClick={() => {
                    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                    setNewAbove(0);
                  }}
                  className="absolute left-1/2 top-2 z-20 -translate-x-1/2 inline-flex items-center gap-1 rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white shadow-md"
                >
                  <ArrowUp size={13} /> {newAbove} new {newAbove === 1 ? 'update' : 'updates'}
                </button>
              )}
              <div
                ref={scrollRef}
                onScroll={onScroll}
                className={cn('relative h-full overflow-y-auto', busy && 'opacity-60 transition-opacity')}
                aria-busy={loading}
              >
                {canManage && <PinnedByTeam onOpen={openConversation} />}
                {loading && rows.length === 0 ? (
                  <SkeletonRows rows={8} avatar />
                ) : loadError && rows.length === 0 ? (
                  <EmptyState
                    compact
                    icon={WifiOff}
                    title="Couldn't load conversations"
                    description="Check your connection and try again."
                    action={
                      <button
                        onClick={() => void load()}
                        className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white"
                      >
                        Retry
                      </button>
                    }
                  />
                ) : displayRows.length === 0 ? (
                  filtersActive ? (
                    <EmptyState
                      compact
                      icon={SearchX}
                      title="No conversations match"
                      description={search ? `Nothing found for "${search}".` : 'Try a different filter.'}
                      action={
                        <button
                          onClick={clearFilters}
                          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold"
                        >
                          Clear filters
                        </button>
                      }
                    />
                  ) : (
                    <EmptyState
                      compact
                      icon={MessagesSquare}
                      title={status === 'unread' ? 'No unread conversations' : status === 'all' ? 'No conversations yet' : `No ${STATUS_LABEL[status].toLowerCase()} conversations`}
                      description={
                        status === 'unread'
                          ? 'You are all caught up.'
                          : status === 'all'
                            ? 'New WhatsApp chats appear here as customers message you.'
                            : undefined
                      }
                    />
                  )
                ) : (
                  displayRows.map((r) => (
                    <ConversationRowItem
                      key={r.id}
                      row={r}
                      active={activeId === r.id}
                      onOpen={openConversation}
                      onAction={rowAction}
                      showAssignee={canManage}
                      isMine={r.assigned_user?.id === user?.id}
                      typingName={
                        typingMap[r.id]
                          ? canManage && typingMap[r.id].name
                            ? `${typingMap[r.id].name.split(' ')[0]} is replying…`
                            : 'Teammate replying…'
                          : null
                      }
                    />
                  ))
                )}

                {loadingMore && (
                  <div className="p-4 flex justify-center">
                    <div className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
                {!loading && rows.length > 0 && !hasMore && (
                  <p className="p-4 text-center text-xs text-muted">
                    {filtersActive ? 'End of results' : 'No more conversations'}
                  </p>
                )}
              </div>
            </div>
            {canManage && assignee && !mine && (
              <p className="sr-only" aria-live="polite">Showing chats for {assigneeName(assignee)}</p>
            )}
          </>
        )}
      </div>

      <div className={cn('flex-1 min-w-0', activeId == null && 'hidden md:block')}>
        {children}
      </div>
    </div>
  );
}

/** Label filter: a picker of labels in use (was free text). */
function LabelFilter({
  value,
  options,
  onOpen,
  onChange,
}: {
  value: string;
  options: { label: string; count: number }[];
  onOpen: () => void;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const filtered = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => {
          if (!open) onOpen();
          setOpen((o) => !o);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-semibold max-w-[9rem]',
          value ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-dashed border-line text-muted hover:text-ink',
        )}
      >
        <Tag size={13} />
        <span className="truncate">{value || 'Label'}</span>
        {value && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear label filter"
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                onChange('');
              }
            }}
            className="-mr-0.5 rounded hover:bg-brand-100"
          >
            <X size={12} />
          </span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 z-40 mt-1 w-56 rounded-xl border border-line bg-surface p-1 shadow-lg">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'Enter' && filtered[0]) {
                onChange(filtered[0].label);
                setOpen(false);
              }
            }}
            placeholder="Find a label"
            aria-label="Find a label"
            className="mb-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <ul role="listbox" className="max-h-60 overflow-y-auto">
            {filtered.length === 0 && (
              <li className="px-2 py-2 text-xs text-muted">No labels yet</li>
            )}
            {filtered.map((o) => (
              <li key={o.label}>
                <button
                  role="option"
                  aria-selected={o.label === value}
                  onClick={() => {
                    onChange(o.label);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-sunken',
                    o.label === value && 'bg-brand-50 text-brand-700',
                  )}
                >
                  <span className="truncate">{o.label}</span>
                  <span className="tabular-nums text-muted">{o.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Merge a freshly-fetched list into the previous one, REUSING the previous
// object for byte-identical rows so memoized rows skip re-rendering.
function reconcileRows(
  prev: ConversationRow[],
  next: ConversationRow[],
): ConversationRow[] {
  const prevById = new Map(prev.map((r) => [r.id, r]));
  const out = next.map((r) => {
    const old = prevById.get(r.id);
    return old && JSON.stringify(old) === JSON.stringify(r) ? old : r;
  });
  const identical =
    out.length === prev.length && out.every((r, i) => r === prev[i]);
  return identical ? prev : out;
}

/**
 * One conversation row, MEMOIZED (unchanged rows keep their object reference,
 * so a busy tenant's socket churn only repaints the row that changed).
 * Structure: a full-width open button + a sibling hover menu (a menu button
 * nested inside a button was invalid markup).
 */
const ConversationRowItem = memo(function ConversationRowItem({
  row: r,
  active,
  onOpen,
  onAction,
  showAssignee,
  isMine,
  typingName,
}: {
  row: ConversationRow;
  active: boolean;
  onOpen: (id: number) => void;
  onAction: (row: ConversationRow, action: 'unread' | 'read' | 'pin' | 'unpin' | 'resolve' | 'reopen' | 'assign-me') => void;
  showAssignee: boolean;
  isMine: boolean;
  typingName: string | null;
}) {
  const draft = useDraftText(r.id);
  const name = r.contact?.name || r.contact?.phone || 'Unknown';
  const unread = r.unread_count > 0;
  const windowClosed =
    r.status !== 'resolved' &&
    r.last_message_direction === 'inbound' &&
    !!r.window_expires_at &&
    new Date(r.window_expires_at).getTime() < Date.now();

  const items: DropdownItem[] = [
    unread
      ? { key: 'read', label: 'Mark as read', icon: CheckCheck, onSelect: () => onAction(r, 'read') }
      : { key: 'unread', label: 'Mark as unread', icon: MailOpen, onSelect: () => onAction(r, 'unread') },
    r.pinned_at
      ? { key: 'unpin', label: 'Unpin', icon: PinOff, onSelect: () => onAction(r, 'unpin') }
      : { key: 'pin', label: 'Pin to top', icon: Pin, onSelect: () => onAction(r, 'pin') },
    ...(isMine
      ? []
      : [{ key: 'assign-me', label: 'Assign to me', icon: UserCheck, onSelect: () => onAction(r, 'assign-me') }]),
    r.status === 'resolved'
      ? { key: 'reopen', label: 'Reopen', icon: RotateCcw, onSelect: () => onAction(r, 'reopen') }
      : { key: 'resolve', label: 'Resolve', icon: CheckCircle2, onSelect: () => onAction(r, 'resolve') },
  ];

  return (
    <div
      data-cid={r.id}
      className={cn(
        'group relative border-b border-line',
        active ? 'bg-brand-50' : 'hover:bg-sunken',
      )}
    >
      {active && (
        <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-brand-600" aria-hidden />
      )}
      <button
        onClick={() => onOpen(r.id)}
        onMouseEnter={() => prefetchThread(r.id)}
        onPointerDown={() => prefetchThread(r.id)}
        aria-current={active ? 'true' : undefined}
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
      >
        <span
          aria-hidden
          className={cn(
            'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white',
            avatarColor(name),
          )}
        >
          {initialsOf(name)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center justify-between gap-2">
            <span
              className={cn(
                'flex min-w-0 items-center gap-1 truncate text-ink',
                unread ? 'font-bold' : 'font-medium',
              )}
            >
              {r.pinned_at && (
                <Pin size={12} className="shrink-0 fill-brand-600 text-brand-600" aria-label="Pinned" />
              )}
              {r.ai_autoreply === true && (
                <Bot size={12} className="shrink-0 text-emerald-600" aria-label="AI auto-pilot on" />
              )}
              <span className="truncate">{name}</span>
            </span>
            <ListTime row={r} unread={unread} />
          </span>
          <span className="flex items-center justify-between gap-2">
            <span
              className={cn(
                'flex min-w-0 items-center gap-1 truncate text-[13px]',
                unread ? 'text-ink' : 'text-muted',
              )}
            >
              {typingName ? (
                <span className="truncate font-semibold italic text-brand-700">{typingName}</span>
              ) : draft.trim() && !active ? (
                <>
                  <span className="shrink-0 font-semibold text-red-600">Draft:</span>
                  <span className="truncate">{draft}</span>
                </>
              ) : (
                <PreviewLine row={r} />
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <WaitChip row={r} />
              {unread && (
                <span
                  className="min-w-[20px] rounded-full bg-brand-600 px-1.5 text-center text-xs font-bold text-white tabular-nums"
                  aria-label={`${r.unread_count} unread messages`}
                >
                  {r.unread_count}
                </span>
              )}
            </span>
          </span>
          {(r.labels?.length > 0 || r.status === 'pending' || windowClosed || (showAssignee && r.assigned_user)) && (
            <span className="mt-1 flex flex-wrap items-center gap-1">
              {r.status === 'pending' && (
                <span className="rounded bg-amber-100 px-1.5 text-xs font-semibold text-amber-800">Pending</span>
              )}
              {windowClosed && (
                <span className="rounded bg-sunken px-1.5 text-xs font-semibold text-muted" title="The 24h window closed — only templates can be sent">
                  Window closed
                </span>
              )}
              {r.labels?.slice(0, 3).map((l) => (
                <span key={l.label} className="rounded bg-sky-50 px-1.5 text-xs font-medium text-sky-800">
                  {l.label}
                </span>
              ))}
              {r.labels?.length > 3 && (
                <span className="text-xs text-muted">+{r.labels.length - 3}</span>
              )}
              {showAssignee && r.assigned_user && (
                <span className="inline-flex items-center gap-1 rounded bg-sunken px-1 text-xs font-medium text-ink" title={`Assigned to ${r.assigned_user.name}`}>
                  <span className={cn('flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white', avatarColor(r.assigned_user.name))}>
                    {initialsOf(r.assigned_user.name)}
                  </span>
                  {r.assigned_user.name.split(' ')[0]}
                </span>
              )}
            </span>
          )}
        </span>
      </button>
      {/* Desktop hover menu, over the timestamp. Touch devices open the chat
          and use the thread header for these actions. */}
      <div className="absolute right-2 top-2 hidden opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 md:block">
        <Dropdown
          label={`Actions for ${name}`}
          items={items}
          trigger={
            <span className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface text-muted shadow-sm hover:text-ink">
              <MoreVertical size={15} />
            </span>
          }
        />
      </div>
    </div>
  );
});

// ── Shared 60s ticker: wait chips + row times re-render on the minute ───────
let nowTick = Date.now();
const nowListeners = new Set<() => void>();
let nowTimer: ReturnType<typeof setInterval> | null = null;
function subscribeNow(cb: () => void) {
  nowListeners.add(cb);
  if (!nowTimer) {
    nowTimer = setInterval(() => {
      nowTick = Date.now();
      nowListeners.forEach((l) => l());
    }, 60_000);
  }
  return () => {
    nowListeners.delete(cb);
    if (nowListeners.size === 0 && nowTimer) {
      clearInterval(nowTimer);
      nowTimer = null;
    }
  };
}
function useNowMinute(): number {
  return useSyncExternalStore(subscribeNow, () => nowTick, () => nowTick);
}

/** Row time — subscribes to the ticker so "Yesterday"/weekday roll over at midnight. */
function ListTime({ row, unread }: { row: ConversationRow; unread: boolean }) {
  useNowMinute();
  return (
    <span className={cn('shrink-0 text-xs tabular-nums', unread ? 'font-semibold text-brand-700' : 'text-muted')}>
      {fmtListTime(row.last_message_at ?? row.updated_at)}
    </span>
  );
}

function WaitChip({ row }: { row: ConversationRow }) {
  const now = useNowMinute();
  if (row.last_message_direction !== 'inbound' || row.status === 'resolved') {
    return null;
  }
  const at = row.last_message_at ? new Date(row.last_message_at).getTime() : NaN;
  if (!Number.isFinite(at)) return null;
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 5 || mins >= 24 * 60) return null;
  const label = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`;
  return (
    <span
      title={`Customer waiting ${label} for a reply`}
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1 text-xs font-semibold leading-4 tabular-nums',
        mins < 15
          ? 'bg-sunken text-muted'
          : mins < 60
            ? 'bg-amber-100 text-amber-800'
            : 'bg-red-100 text-red-700',
      )}
    >
      <Clock size={11} aria-hidden />
      {label}
    </span>
  );
}

const MEDIA_PREVIEW: Partial<
  Record<MessageType, { Icon: typeof Mic; label: string }>
> = {
  audio: { Icon: Mic, label: 'Voice message' },
  image: { Icon: ImageIcon, label: 'Photo' },
  video: { Icon: Video, label: 'Video' },
  document: { Icon: FileText, label: 'Document' },
  sticker: { Icon: Sticker, label: 'Sticker' },
  template: { Icon: LayoutTemplate, label: 'Template' },
};

const SENTINEL_RE = /^\[(audio|video|image|document|sticker|template)\]$/i;

function PreviewTick({ status }: { status?: MessageStatus | null }) {
  if (status === 'sending')
    return <Clock size={13} className="shrink-0 text-muted" aria-label="Sending" />;
  if (status === 'failed')
    return <X size={13} className="shrink-0 text-red-600" aria-label="Not delivered" />;
  if (status === 'read' || status === 'played')
    return <CheckCheck size={13} className="shrink-0 text-blue-500" aria-label="Read" />;
  if (status === 'delivered')
    return <CheckCheck size={13} className="shrink-0 text-muted" aria-label="Delivered" />;
  return <Check size={13} className="shrink-0 text-muted" aria-label="Sent" />;
}

function PreviewLine({ row }: { row: ConversationRow }) {
  const raw = stripWaFormatting((row.last_message ?? '').trim());
  const hasCaption = raw !== '' && !SENTINEL_RE.test(raw);
  const media = row.last_message_type
    ? MEDIA_PREVIEW[row.last_message_type]
    : undefined;
  const outbound = row.last_message_direction === 'outbound';
  const failed = outbound && row.last_message_status === 'failed';
  const tick = outbound ? <PreviewTick status={row.last_message_status} /> : null;

  if (failed) {
    return (
      <>
        {tick}
        <span className="truncate font-medium text-red-600">Not delivered · open to retry</span>
      </>
    );
  }
  if (media) {
    const Icon = media.Icon;
    return (
      <>
        {tick}
        <Icon size={13} className="shrink-0 text-muted" aria-hidden />
        <span className="truncate">{hasCaption ? raw : media.label}</span>
      </>
    );
  }
  return (
    <>
      {tick}
      {/* Never fall back to the phone number — it read as a message. */}
      <span className={cn('truncate', !hasCaption && 'italic')}>{hasCaption ? raw : 'Message'}</span>
    </>
  );
}
