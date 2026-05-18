'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { apiFetchEnvelope, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';
import { cn, fmtDateTime } from '@/lib/utils';
import type { ConversationRow } from '@/lib/inbox-types';

const STATUSES = ['all', 'open', 'pending', 'resolved'] as const;

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
  const [label, setLabel] = useState('');
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const limit = 20;

  const rowsRef = useRef<ConversationRow[]>([]);
  rowsRef.current = rows;

  const fetchPage = useCallback(
    async (pageNum: number) => {
      const env = await apiFetchEnvelope<ConversationRow[]>(
        '/inbox/conversations',
        {
          params: {
            status: status === 'all' ? undefined : status,
            assignedUserId: mine && user ? user.id : undefined,
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
    [status, mine, label, search, user],
  );

  // (Re)load from page 1 — replaces the list.
  const load = useCallback(async () => {
    setLoading(true);
    pageRef.current = 1;
    try {
      const { data, total: t } = await fetchPage(1);
      setRows(data);
      setTotal(t);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load conversations',
      );
    } finally {
      setLoading(false);
    }
  }, [fetchPage, toast]);

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
      message?: { content?: string | null };
    }>('message.received', (p) => {
      const idx = rowsRef.current.findIndex(
        (r) => r.id === p.conversationId,
      );
      // Not on the current page/filter → refetch so a brand-new
      // conversation shows up (server applies sort + filters).
      if (idx === -1) {
        load();
        return;
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
        };
        // Move it to the top (most-recent-first), like every chat app.
        return [updated, ...cur.slice(0, i), ...cur.slice(i + 1)];
      });
    });
    const offRead = on<{ conversationId: number }>(
      'message.read.bulk',
      (p) => {
        setRows((cur) =>
          cur.map((r) =>
            r.id === p.conversationId ? { ...r, unread_count: 0 } : r,
          ),
        );
      },
    );
    const offAssigned = on<{ conversationId: number; userId: number }>(
      'conversation.assigned',
      () => load(),
    );
    const offUpdated = on<{ conversationId: number }>(
      'conversation.updated',
      () => load(),
    );
    return () => {
      offRecv();
      offRead();
      offAssigned();
      offUpdated();
    };
  }, [on, activeId, load]);

  // Catch up after a reconnect.
  const prevSocket = useRef(socketStatus);
  useEffect(() => {
    if (prevSocket.current !== 'connected' && socketStatus === 'connected') {
      load();
    }
    prevSocket.current = socketStatus;
  }, [socketStatus, load]);

  const hasMore = rows.length < total;

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
              placeholder="Search name or phone"
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
                {s}
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
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-400">
              No conversations yet.
            </div>
          ) : (
            rows.map((r) => (
              <button
                key={r.id}
                onClick={() => router.push(`/inbox/${r.id}`)}
                className={cn(
                  'w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 flex flex-col gap-0.5',
                  activeId === r.id && 'bg-green-50',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-gray-900 truncate">
                    {r.contact?.name || r.contact?.phone || 'Unknown'}
                  </span>
                  <span className="text-[11px] text-gray-400 shrink-0">
                    {fmtDateTime(r.last_message_at ?? r.updated_at)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-gray-500 truncate">
                    {r.last_message || r.contact?.phone}
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
