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
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const limit = 20;

  const filtersRef = useRef({ status, mine, label, search, page });
  filtersRef.current = { status, mine, label, search, page };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const env = await apiFetchEnvelope<ConversationRow[]>(
        '/inbox/conversations',
        {
          params: {
            status: status === 'all' ? undefined : status,
            assignedUserId: mine && user ? user.id : undefined,
            label: label || undefined,
            search: search || undefined,
            page,
            limit,
          },
        },
      );
      setRows(env.data);
      setTotal((env.meta?.total as number) ?? env.data.length);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load conversations',
      );
    } finally {
      setLoading(false);
    }
  }, [status, mine, label, search, page, user, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Realtime list updates.
  useEffect(() => {
    const offRecv = on<{ conversationId: number }>(
      'message.received',
      (p) => {
        setRows((cur) =>
          cur.map((r) =>
            r.id === p.conversationId
              ? {
                  ...r,
                  unread_count:
                    r.id === activeId ? 0 : (r.unread_count ?? 0) + 1,
                  updated_at: new Date().toISOString(),
                }
              : r,
          ),
        );
      },
    );
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

  const totalPages = Math.max(1, Math.ceil(total / limit));

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
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
              placeholder="Search name or phone"
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            {STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setPage(1);
                  setStatus(s);
                }}
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
                onChange={(e) => {
                  setPage(1);
                  setMine(e.target.checked);
                }}
              />
              Assigned to me
            </label>
            <input
              value={label}
              onChange={(e) => {
                setPage(1);
                setLabel(e.target.value);
              }}
              placeholder="Label filter"
              className="w-28 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-green-500"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
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
                    {fmtDateTime(r.updated_at)}
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
        </div>

        <div className="p-2 border-t border-gray-200 flex items-center justify-between text-xs text-gray-500">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="px-2 py-1 disabled:opacity-40 hover:bg-gray-100 rounded"
          >
            Prev
          </button>
          <span>
            {page} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="px-2 py-1 disabled:opacity-40 hover:bg-gray-100 rounded"
          >
            Next
          </button>
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
