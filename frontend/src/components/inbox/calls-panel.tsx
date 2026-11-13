'use client';

// The inbox "Calls" tab: a company-wide call log (pool-model RBAC) that lives
// inside the inbox left panel. Clicking a call opens that contact's chat; the
// call-back button dials from the in-browser softphone. Data: GET /api/calls.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { SearchInput } from '@/components/ui/search-input';
import { useSocket } from '@/context/socket-context';
import { useSip } from '@/context/sip-context';
import { dayKey, dayLabel, fmtTime } from '@/lib/utils';

type CallItem = {
  id: number;
  conversationId: number | null;
  contactId: number | null;
  contactName: string | null;
  contactPhone: string | null;
  direction: 'inbound' | 'outbound';
  status: 'ringing' | 'answered' | 'missed' | 'failed' | 'completed';
  durationSec: number | null;
  startedAt: string | null;
  createdAt: string;
  agentId: number | null;
  agentName: string | null;
};

type CallFilter = 'all' | 'missed' | 'incoming' | 'outgoing';
const FILTERS: CallFilter[] = ['all', 'missed', 'incoming', 'outgoing'];

const AV_COLORS = [
  '#2563eb', '#dc2626', '#7c3aed', '#0891b2', '#059669', '#d97706', '#db2777', '#4f46e5',
];
function avatarColor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}
function fmtDur(sec: number | null) {
  if (!sec || sec <= 0) return null;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export default function CallsPanel({
  onOpen,
  activeId,
}: {
  onOpen: (conversationId: number) => void;
  activeId: number | null;
}) {
  const { on } = useSocket();
  const sip = useSip();
  const [rows, setRows] = useState<CallItem[]>([]);
  const [filter, setFilter] = useState<CallFilter>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const pageRef = useRef(1);
  const limit = 30;

  // Server-side search (debounced): a match on an unloaded page used to be
  // invisible because search only filtered the rows already fetched.
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const seqRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback(
    async (page: number) => {
      const res = await apiFetch<{
        rows: CallItem[];
        total: number;
        page: number;
        limit: number;
      }>('/calls', {
        params: {
          page,
          limit,
          filter: filter === 'all' ? undefined : filter,
          search: query || undefined,
        },
      });
      return res;
    },
    [filter, query],
  );

  const [error, setError] = useState(false);
  // `silent` re-fetches every loaded page in place (a live call.updated used to
  // reset the log to page 1 and throw away the agent's scroll position).
  const load = useCallback(
    async (silent = false) => {
      const seq = ++seqRef.current;
      if (!silent) {
        setLoading(true);
        setError(false);
        pageRef.current = 1;
        if (listRef.current) listRef.current.scrollTop = 0;
      }
      try {
        const pages = silent ? Math.max(1, pageRef.current) : 1;
        const results = await Promise.all(
          Array.from({ length: pages }, (_, i) => fetchPage(i + 1)),
        );
        if (seq !== seqRef.current) return;
        const seen = new Set<number>();
        setRows(
          results
            .flatMap((r) => r.rows ?? [])
            .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))),
        );
        setTotal(results[results.length - 1]?.total ?? 0);
        setError(false);
      } catch {
        if (seq !== seqRef.current) return;
        if (!silent) {
          setRows([]);
          setError(true);
        }
      } finally {
        // Clear the spinner whenever THIS is the latest request — silent or
        // not. A live call.updated refresh used to bump the seq while a
        // filter-change load was in flight; that load was then discarded and
        // nothing ever turned `loading` off (spinner stuck on an empty list).
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const off = on<{ conversationId: number | null }>('call.updated', () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(true), 600);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [on, load]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || rows.length >= total) return;
    const seq = seqRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const next = pageRef.current + 1;
      const res = await fetchPage(next);
      if (seq !== seqRef.current) return;
      pageRef.current = next;
      if (!(res.rows ?? []).length) {
        setTotal(rows.length);
        return;
      }
      setTotal(res.total ?? total);
      setRows((cur) => {
        const seen = new Set(cur.map((r) => r.id));
        return [...cur, ...(res.rows ?? []).filter((r) => !seen.has(r.id))];
      });
    } catch {
      /* keep what we have */
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [fetchPage, rows.length, total]);

  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) void loadMore();
    },
    [loadMore],
  );

  const filtered = rows;

  // Group into day buckets, preserving the newest-first order.
  const groups = useMemo(() => {
    const out: Array<{ day: string; items: CallItem[] }> = [];
    for (const r of filtered) {
      const k = dayKey(r.startedAt || r.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === k) last.items.push(r);
      else out.push({ day: k, items: [r] });
    }
    return out;
  }, [filtered]);

  const canCallBack = (phone: string | null): phone is string =>
    !!(sip?.available && phone);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="p-3 border-b border-gray-200 space-y-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search calls by name or number"
          aria-label="Search calls"
          loading={loading && !!search}
        />
        <div className="flex gap-1 flex-wrap">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={`px-2.5 py-1 text-xs rounded-full capitalize ${
                filter === f
                  ? 'bg-green-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto" onScroll={onScroll}>
        {loading && rows.length === 0 ? (
          <div className="p-6 flex justify-center">
            <div className="w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-muted">
            Couldn&apos;t load calls.{' '}
            <button onClick={() => void load()} className="font-semibold text-brand-700 hover:underline">
              Retry
            </button>
          </div>
        ) : groups.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted">
            {query
              ? `No calls match "${query}".`
              : filter !== 'all'
                ? `No ${filter} calls.`
                : 'No calls yet.'}
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.day}>
              <div className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
                {dayLabel(g.day)}
              </div>
              {g.items.map((c) => {
                const missed = c.status === 'missed' || c.status === 'failed';
                const inbound = c.direction === 'inbound';
                const Icon = missed ? PhoneMissed : inbound ? PhoneIncoming : PhoneOutgoing;
                const dur = fmtDur(c.durationSec);
                const name = c.contactName || c.contactPhone || 'Unknown';
                const openable = c.conversationId != null;
                return (
                  <div
                    key={c.id}
                    role={openable ? 'button' : undefined}
                    tabIndex={openable ? 0 : undefined}
                    aria-label={openable ? `Open chat with ${name}` : undefined}
                    onKeyDown={(e) => {
                      if (openable && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        onOpen(c.conversationId as number);
                      }
                    }}
                    onClick={() => openable && onOpen(c.conversationId as number)}
                    className={`flex items-center gap-3 px-4 py-2.5 border-b border-gray-50 ${
                      openable ? 'cursor-pointer hover:bg-gray-50' : ''
                    } ${activeId != null && c.conversationId === activeId ? 'bg-green-50' : ''}`}
                  >
                    <span
                      className="flex h-10 w-10 flex-none items-center justify-center rounded-full text-sm font-bold text-white"
                      style={{ background: avatarColor(name) }}
                    >
                      {initials(name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div
                        className={`truncate text-sm font-semibold ${
                          missed ? 'text-red-500' : 'text-gray-900'
                        }`}
                      >
                        {name}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
                        <Icon
                          size={13}
                          className={missed ? 'text-red-500' : 'text-green-600'}
                        />
                        <span className="truncate">
                          {missed
                            ? inbound
                              ? 'Missed'
                              : 'No answer'
                            : `${inbound ? 'Incoming' : 'Outgoing'}${dur ? ` · ${dur}` : ''}`}
                        </span>
                        {c.agentName && (
                          <span className="rounded bg-gray-100 px-1.5 py-px text-xs text-gray-500">
                            {c.agentName}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 text-right">
                      <span className="text-xs text-gray-400 whitespace-nowrap">
                        {fmtTime(c.startedAt || c.createdAt)}
                      </span>
                      {canCallBack(c.contactPhone) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            sip!.placeCall(c.contactPhone as string);
                          }}
                          title="Call back"
                          aria-label={`Call back ${name}`}
                          className="flex h-7 w-7 items-center justify-center rounded-full bg-green-50 text-green-600 hover:bg-green-100"
                        >
                          <Phone size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
        {loadingMore && (
          <div className="p-4 flex justify-center">
            <div className="w-5 h-5 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}
