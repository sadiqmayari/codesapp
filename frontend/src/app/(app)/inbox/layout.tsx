'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Bot,
  Check,
  CheckCheck,
  Clock,
  FileText,
  Image as ImageIcon,
  Mic,
  Pin,
  Search,
  Sticker,
  Video,
} from 'lucide-react';
import { apiFetch, apiFetchEnvelope, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';
import { cn, fmtListTime } from '@/lib/utils';
import type {
  ConversationRow,
  MessageStatus,
  MessageType,
} from '@/lib/inbox-types';
import type { TeamMember } from '@/lib/crm-types';

const STATUSES = ['all', 'unread', 'open', 'pending', 'resolved'] as const;

export default function InboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const params = useParams();
  const activeId = params?.id ? Number(params.id) : null;
  const { user } = useAuth();
  const { on, status: socketStatus } = useSocket();
  const toast = useToast();

  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all');
  const [mine, setMine] = useState(false);
  // Owner/admin assignee filter: '' = all, 'unassigned', or an agent's user id.
  const canManage = user?.role === 'owner' || user?.role === 'admin';
  const [assignee, setAssignee] = useState('');
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [label, setLabel] = useState('');
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState(0);
  // Live count of unread conversations, kept in sync via socket events so the
  // "unread (N)" chip always has a number instantly — no empty→number flash on
  // tab switch (the previous approach reset it to 0 and waited for a fetch).
  // null = not yet known (chip shows plain "unread").
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const limit = 20;

  const rowsRef = useRef<ConversationRow[]>([]);
  rowsRef.current = rows;

  // Read inside load()/realtime without making them depend on activeId
  // (depending on it would refetch the whole list on every chat open).
  const activeIdRef = useRef<number | null>(activeId);
  activeIdRef.current = activeId;

  // Optimistically clear the opened chat's unread badge the instant it's opened,
  // instead of waiting for the mark-read POST → message.read.bulk socket
  // round-trip (which lagged, so the badge lingered until a refresh). The
  // backend mark-read still runs from the thread page to persist + sync devices.
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

  // Seed the live unread-conversation count once on mount (authoritative
  // server total). Kept fresh afterwards by socket deltas + every unread-tab
  // load. One cheap query (limit 1, we only read meta.total).
  useEffect(() => {
    apiFetchEnvelope<ConversationRow[]>('/inbox/conversations', {
      params: { status: 'unread', page: 1, limit: 1 },
    })
      .then((env) => setUnreadCount((env.meta?.total as number) ?? 0))
      .catch(() => {});
  }, []);

  // Team roster for the owner/admin assignee filter.
  useEffect(() => {
    if (!canManage) return;
    apiFetch<TeamMember[]>('/team')
      .then((r) => setMembers(Array.isArray(r) ? r : []))
      .catch(() => setMembers([]));
  }, [canManage]);

  // (Re)load from page 1 — replaces the list. `silent` skips the loading flag
  // for background (socket-triggered) refreshes so the list doesn't flicker.
  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      // Clear the stale count so the Unread chip doesn't briefly show the
      // previous view's total (e.g. all-chats 10,915) before the new filter's
      // count arrives.
      setTotal(0);
    }
    pageRef.current = 1;
    try {
      const { data, total: t } = await fetchPage(1);
      // WhatsApp-style sticky unread: when the Unread filter is active and
      // the user has a conversation open, that conversation must stay
      // visible even after it's been marked read — until they open the
      // NEXT unread chat. The server's unread filter excludes it once read,
      // so re-insert the cached row here; displayRows keeps it pinned via
      // `id === activeId`.
      let merged = data;
      const aid = activeIdRef.current;
      if (
        status === 'unread' &&
        aid != null &&
        !data.some((r) => r.id === aid)
      ) {
        const cached = rowsRef.current.find((r) => r.id === aid);
        if (cached) merged = [cached, ...data];
      }
      setRows(merged);
      setTotal(t);
      // On the unread tab the server total IS the unread-conversation count —
      // adopt it as the authoritative value for the chip.
      if (status === 'unread') setUnreadCount(t);
    } catch (e) {
      if (!silent)
        toast.error(
          e instanceof ApiError ? e.userMessage : 'Failed to load conversations',
        );
    } finally {
      if (!silent) setLoading(false);
    }
  }, [fetchPage, toast]);

  // Coalesce bursty socket-triggered refreshes (conversation.updated fires a
  // LOT on a busy tenant) into one silent refetch, instead of hammering
  // GET /conversations + re-rendering the whole list per event. Short window
  // (120ms) so a new chat still appears near-instantly while a burst is still
  // collapsed into one fetch.
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleLoad = useCallback(() => {
    if (loadTimer.current) clearTimeout(loadTimer.current);
    loadTimer.current = setTimeout(() => {
      loadTimer.current = null;
      void load(true);
    }, 120);
  }, [load]);
  useEffect(
    () => () => {
      if (loadTimer.current) clearTimeout(loadTimer.current);
    },
    [],
  );

  // Append the next page (infinite scroll).
  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    if (rowsRef.current.length >= total) return;
    setLoadingMore(true);
    try {
      const next = pageRef.current + 1;
      const { data, total: t } = await fetchPage(next);
      pageRef.current = next;
      setTotal(t);
      setRows((cur) => {
        const seen = new Set(cur.map((r) => r.id));
        return [...cur, ...data.filter((r) => !seen.has(r.id))];
      });
    } catch {
      /* keep what we have; user can scroll again to retry */
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, loadingMore, total]);

  useEffect(() => {
    load();
  }, [load]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      loadMore();
    }
  }, [loadMore]);

  // Realtime list updates.
  useEffect(() => {
    const offRecv = on<{
      conversationId: number;
      contactId?: number;
      contactName?: string;
      contactPhone?: string;
      message?: { content?: string | null; message_type?: string | null };
    }>('message.received', (p) => {
      const idx = rowsRef.current.findIndex(
        (r) => r.id === p.conversationId,
      );
      // Not on the loaded page → build the row from the socket payload and
      // splice it in, instead of refetching the whole list. On a big tenant
      // most inbound messages are for off-page chats, so a refetch here (× every
      // connected agent) was the multi-agent slowdown. A brand-new inbound chat
      // is always unassigned (pool) so it's RBAC-safe for every agent to see;
      // any missing fields self-correct on the next real load.
      if (idx === -1) {
        // Under a non-"all" filter we can't be sure the new chat belongs in the
        // current view (e.g. an assignee filter) — fall back to a debounced
        // refetch there. The common case (All / Unread) patches with no fetch.
        if (status !== 'all' && status !== 'unread') {
          scheduleLoad();
          return;
        }
        const now = new Date().toISOString();
        const isActive = p.conversationId === activeIdRef.current;
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
          status: 'open',
          last_message: p.message?.content ?? null,
          last_message_at: now,
          last_message_type: (p.message?.message_type as MessageType) ?? null,
          last_message_direction: 'inbound',
          last_message_status: null,
          unread_count: isActive ? 0 : 1,
          window_expires_at: null,
          pinned_at: null,
          ai_autoreply: null,
          updated_at: now,
        };
        setRows((cur) =>
          cur.some((r) => r.id === p.conversationId)
            ? cur
            : [newRow, ...cur],
        );
        if (!isActive) setUnreadCount((c) => (c == null ? c : c + 1));
        return;
      }
      // If a currently-read chat just became unread (and isn't the open one),
      // it adds one to the live unread count.
      const prev = rowsRef.current.find((r) => r.id === p.conversationId);
      if (
        prev &&
        (prev.unread_count ?? 0) === 0 &&
        p.conversationId !== activeIdRef.current
      ) {
        setUnreadCount((c) => (c == null ? c : c + 1));
      }
      setRows((cur) => {
        const i = cur.findIndex((r) => r.id === p.conversationId);
        if (i === -1) return cur;
        const existing = cur[i];
        const now = new Date().toISOString();
        const updated = {
          ...existing,
          unread_count:
            existing.id === activeId ? 0 : (existing.unread_count ?? 0) + 1,
          updated_at: now,
          last_message_at: now,
          last_message:
            p.message?.content ?? existing.last_message ?? null,
          last_message_type:
            (p.message?.message_type as MessageType) ?? null,
          last_message_direction: 'inbound' as const,
          last_message_status: null,
        };
        // Re-sort to mirror the server order: pinned conversations stay
        // sticky-top (Shell-Polish-B), then most-recent-first. A new message
        // on an unpinned chat must not jump above pinned ones.
        const next = [updated, ...cur.slice(0, i), ...cur.slice(i + 1)];
        const t = (s: string | null) => (s ? new Date(s).getTime() : 0);
        return next.slice().sort((a, b) => {
          const ap = t(a.pinned_at);
          const bp = t(b.pinned_at);
          if (ap !== bp) return bp - ap; // pinned (non-zero) first, newest pin first
          return (
            t(b.last_message_at ?? b.updated_at) -
            t(a.last_message_at ?? a.updated_at)
          );
        });
      });
    });
    const offRead = on<{ conversationId: number }>(
      'message.read.bulk',
      (p) => {
        const wasUnread = rowsRef.current.some(
          (r) => r.id === p.conversationId && (r.unread_count ?? 0) > 0,
        );
        if (wasUnread) {
          setUnreadCount((c) => (c == null ? c : Math.max(0, c - 1)));
        }
        setRows((cur) =>
          cur.map((r) =>
            r.id === p.conversationId ? { ...r, unread_count: 0 } : r,
          ),
        );
      },
    );
    const offAssigned = on<{ conversationId: number; userId: number }>(
      'conversation.assigned',
      () => scheduleLoad(),
    );
    const offUpdated = on<{ conversationId: number }>(
      'conversation.updated',
      () => scheduleLoad(),
    );
    return () => {
      offRecv();
      offRead();
      offAssigned();
      offUpdated();
    };
  }, [on, activeId, scheduleLoad, status]);

  // Catch up after a reconnect.
  const prevSocket = useRef(socketStatus);
  useEffect(() => {
    if (prevSocket.current !== 'connected' && socketStatus === 'connected') {
      load();
    }
    prevSocket.current = socketStatus;
  }, [socketStatus, load]);

  const hasMore = rows.length < total;

  // Under the Unread filter, show conversations that are still unread PLUS
  // the one currently open (so opening an unread chat doesn't make it
  // vanish from the list). It drops out only when the next chat is opened.
  const displayRows = useMemo(() => {
    if (status !== 'unread') return rows;
    return rows.filter(
      (r) => (r.unread_count ?? 0) > 0 || r.id === activeId,
    );
  }, [rows, status, activeId]);

  // Count shown on the Unread tab = the live unread-conversation count, kept in
  // sync via socket deltas + seeded on mount, so it's populated BEFORE the tab
  // is opened — no empty→number flash, and never the previous view's total.
  const unreadTabCount = unreadCount ?? 0;

  return (
    <div className="flex h-full">
      {/* Conversation list */}
      <div
        className={cn(
          'w-full md:w-80 lg:w-96 shrink-0 border-r border-gray-200 bg-white flex flex-col',
          activeId != null && 'hidden md:flex',
        )}
      >
        <div className="p-3 border-b border-gray-200 space-y-2">
          <div className="relative">
            <Search
              size={16}
              className="absolute left-3 top-2.5 text-gray-400"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, phone or message"
              type="search"
              name="inbox-conversation-search"
              autoComplete="off"
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            {STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={cn(
                  'px-2.5 py-1 text-xs rounded-full capitalize',
                  status === s
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
                )}
              >
                {s === 'unread' && status === 'unread' && unreadTabCount > 0
                  ? `unread (${unreadTabCount})`
                  : s}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={mine}
                onChange={(e) => setMine(e.target.checked)}
              />
              Assigned to me
            </label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label filter"
              className="w-28 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-green-500"
            />
          </div>
          {canManage && (
            <div className="mt-2">
              <select
                value={mine ? '' : assignee}
                disabled={mine}
                onChange={(e) => setAssignee(e.target.value)}
                title="Filter by assigned agent"
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-green-500 disabled:bg-gray-50 disabled:text-gray-400"
              >
                <option value="">All chats</option>
                <option value="unassigned">Unassigned</option>
                {members.map((mem) => (
                  <option key={mem.id} value={String(mem.id)}>
                    {mem.name}
                    {mem.id === user?.id ? ' (me)' : ''} · {mem.role}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto"
        >
          {loading && rows.length === 0 ? (
            <div className="p-6 flex justify-center">
              <div className="w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : displayRows.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-400">
              {status === 'unread'
                ? 'No unread conversations.'
                : 'No conversations yet.'}
            </div>
          ) : (
            displayRows.map((r) => (
              <button
                key={r.id}
                onClick={() => router.push(`/inbox/${r.id}`)}
                className={cn(
                  'w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 flex flex-col gap-0.5',
                  activeId === r.id && 'bg-green-50',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-gray-900 truncate flex items-center gap-1">
                    {r.pinned_at && (
                      <Pin
                        size={12}
                        className="text-green-600 fill-green-600 shrink-0"
                        aria-label="Pinned"
                      />
                    )}
                    {r.ai_autoreply === true && (
                      <Bot
                        size={12}
                        className="text-emerald-600 shrink-0"
                        aria-label="AI auto-pilot on"
                      />
                    )}
                    {r.contact?.name || r.contact?.phone || 'Unknown'}
                  </span>
                  <span className="text-[11px] text-gray-400 shrink-0">
                    {fmtListTime(r.last_message_at ?? r.updated_at)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-gray-500 truncate flex items-center gap-1 min-w-0">
                    <PreviewLine row={r} />
                  </span>
                  {r.unread_count > 0 && (
                    <span className="bg-green-600 text-white text-[10px] rounded-full px-1.5 min-w-[18px] text-center shrink-0">
                      {r.unread_count}
                    </span>
                  )}
                </div>
                {r.labels?.length > 0 && (
                  <div className="flex gap-1 flex-wrap mt-1">
                    {r.labels.map((l) => (
                      <span
                        key={l.label}
                        className="text-[10px] bg-gray-100 text-gray-600 rounded px-1.5 py-0.5"
                      >
                        {l.label}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            ))
          )}

          {loadingMore && (
            <div className="p-4 flex justify-center">
              <div className="w-5 h-5 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {!loading && rows.length > 0 && !hasMore && (
            <p className="p-4 text-center text-[11px] text-gray-400">
              No more conversations
            </p>
          )}
        </div>
      </div>

      {/* Thread / placeholder */}
      <div
        className={cn(
          'flex-1 min-w-0',
          activeId == null && 'hidden md:block',
        )}
      >
        {children}
      </div>
    </div>
  );
}

// WhatsApp-style media preview: an icon + friendly label per message type.
// A real caption (when present) wins over the generic label, mirroring
// WhatsApp — which shows the caption text when a photo/video has one.
const MEDIA_PREVIEW: Partial<
  Record<MessageType, { Icon: typeof Mic; label: string }>
> = {
  audio: { Icon: Mic, label: 'Voice message' },
  image: { Icon: ImageIcon, label: 'Photo' },
  video: { Icon: Video, label: 'Video' },
  document: { Icon: FileText, label: 'Document' },
  sticker: { Icon: Sticker, label: 'Sticker' },
};

// The backend stores `[audio]`/`[video]`/… in last_message when a media
// message has no caption. Detect that sentinel so we render the friendly
// label instead of the raw bracketed token.
const SENTINEL_RE = /^\[(audio|video|image|document|sticker|template)\]$/i;

/** Tiny delivery tick for an outbound last message, like WhatsApp's list. */
function PreviewTick({ status }: { status?: MessageStatus | null }) {
  if (status === 'sending')
    return <Clock size={13} className="shrink-0 text-gray-400" />;
  if (status === 'failed')
    return <span className="shrink-0 text-red-500 text-[11px]">✕</span>;
  if (status === 'read' || status === 'played')
    return <CheckCheck size={13} className="shrink-0 text-blue-500" />;
  if (status === 'delivered')
    return <CheckCheck size={13} className="shrink-0 text-gray-400" />;
  return <Check size={13} className="shrink-0 text-gray-400" />; // sent
}

/** Renders the last-message preview: [tick] [media icon] text/label. */
function PreviewLine({ row }: { row: ConversationRow }) {
  const raw = (row.last_message ?? '').trim();
  const hasCaption = raw !== '' && !SENTINEL_RE.test(raw);
  const media = row.last_message_type
    ? MEDIA_PREVIEW[row.last_message_type]
    : undefined;
  const tick =
    row.last_message_direction === 'outbound' ? (
      <PreviewTick status={row.last_message_status} />
    ) : null;

  if (media) {
    const Icon = media.Icon;
    return (
      <>
        {tick}
        <Icon size={13} className="shrink-0 text-gray-400" />
        <span className="truncate">{hasCaption ? raw : media.label}</span>
      </>
    );
  }
  return (
    <>
      {tick}
      <span className="truncate">
        {hasCaption ? raw : row.contact?.phone}
      </span>
    </>
  );
}
