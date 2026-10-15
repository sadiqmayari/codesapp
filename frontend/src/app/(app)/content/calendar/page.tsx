'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import {
  ContentItem,
  ContentStatus,
  STATUS_META,
  getContentCalendar,
} from '@/lib/content';

export default function ContentCalendarPage() {
  const toast = useToast();
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);

  const { from, to, label } = useMemo(() => {
    const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59);
    return {
      from: start.toISOString(),
      to: end.toISOString(),
      label: start.toLocaleDateString(undefined, {
        month: 'long',
        year: 'numeric',
      }),
    };
  }, [cursor]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await getContentCalendar(from, to));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load calendar');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  // Build the month grid (weeks starting Sunday).
  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const daysInMonth = new Date(
      cursor.getFullYear(),
      cursor.getMonth() + 1,
      0,
    ).getDate();
    const lead = first.getDay();
    const byDay: Record<number, ContentItem[]> = {};
    for (const it of items) {
      if (!it.scheduled_publish_at) continue;
      const d = new Date(it.scheduled_publish_at).getDate();
      (byDay[d] ||= []).push(it);
    }
    const out: { day: number | null; items: ContentItem[] }[] = [];
    for (let i = 0; i < lead; i++) out.push({ day: null, items: [] });
    for (let d = 1; d <= daysInMonth; d++) out.push({ day: d, items: byDay[d] ?? [] });
    return out;
  }, [cursor, items]);

  const shift = (delta: number) =>
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <Link
        href="/content"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-4"
      >
        <ArrowLeft size={16} /> Back to content
      </Link>

      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Content calendar</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => shift(-1)}
            className="p-2 rounded-lg border border-gray-300 hover:bg-gray-50"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-sm font-medium w-36 text-center">{label}</span>
          <button
            onClick={() => shift(1)}
            className="p-2 rounded-lg border border-gray-300 hover:bg-gray-50"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-gray-400">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-px bg-gray-200 border border-gray-200 rounded-xl overflow-hidden text-sm">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div
              key={d}
              className="bg-gray-50 px-2 py-1.5 text-xs font-medium text-gray-500 text-center"
            >
              {d}
            </div>
          ))}
          {cells.map((c, i) => (
            <div
              key={i}
              className="bg-white min-h-[88px] p-1.5 align-top"
            >
              {c.day && (
                <span className="text-xs text-gray-400">{c.day}</span>
              )}
              <div className="mt-1 space-y-1">
                {c.items.map((it) => {
                  const meta =
                    STATUS_META[it.status as ContentStatus] ??
                    STATUS_META.uploaded;
                  return (
                    <Link
                      key={it.id}
                      href={`/content/${it.id}`}
                      className={`block truncate text-[11px] px-1.5 py-0.5 rounded ${meta.cls}`}
                      title={it.title}
                    >
                      {it.title}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
