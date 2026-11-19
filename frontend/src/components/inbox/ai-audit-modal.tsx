'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';
import { getTrace, type TraceEvent } from '@/lib/ai-agent';
import { TraceView } from '@/components/settings/ai-agent';

/** Labels for every AI event the timeline can contain. */
const LABELS: Record<string, { label: string; tone: string }> = {
  'ai.reply': { label: 'AI reply', tone: 'bg-violet-50 text-violet-800 border-violet-200' },
  'ai.shadow': { label: 'New agent (shadow, not sent)', tone: 'bg-sky-50 text-sky-800 border-sky-200' },
  'conversation.handoff': { label: 'Handed to the team', tone: 'bg-amber-50 text-amber-800 border-amber-200' },
  'order.created': { label: 'Order created by AI', tone: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  'tool.failed': { label: 'A tool failed', tone: 'bg-red-50 text-red-700 border-red-200' },
  'ai.reply.ungrounded_price': { label: 'Price not found in any tool result', tone: 'bg-red-50 text-red-700 border-red-200' },
  'ai.knowledge_miss': { label: 'Knowledge had no answer', tone: 'bg-amber-50 text-amber-800 border-amber-200' },
  'lead.qualified': { label: 'Lead qualified', tone: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
};

function detailOf(e: TraceEvent): string | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (e.type === 'ai.knowledge_miss' && typeof p.query === 'string') return `“${p.query}”`;
  if (e.type === 'ai.reply.ungrounded_price' && Array.isArray(p.prices)) return p.prices.join(', ');
  for (const k of ['reason', 'orderName', 'tool', 'error', 'category']) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * "Why this reply?" — every AI turn in this chat with its real trace: the
 * tools it called, the knowledge it read, memory stage, model, latency and
 * cost — plus handoffs, orders, knowledge misses and failures.
 */
export default function AiAuditModal({
  conversationId,
  open,
  onClose,
}: {
  conversationId: number;
  open: boolean;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<TraceEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await getTrace(conversationId);
      setEvents(r.events);
      const firstReply = r.events.find((e) => e.type === 'ai.reply' || e.type === 'ai.shadow');
      setOpenId(firstReply?.id ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not load the AI timeline');
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <Modal open={open} onClose={onClose} title="Why this reply?">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-muted">Newest first. Expand an AI reply to see its sources and tools.</p>
        <button type="button" onClick={load} className="inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-ink" aria-label="Refresh">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {events && events.length === 0 && (
        <p className="py-6 text-center text-sm text-muted">The AI hasn’t acted in this chat yet.</p>
      )}
      <ol className="flex flex-col gap-2">
        {(events ?? []).map((e) => {
          const meta = LABELS[e.type] ?? { label: e.type, tone: 'bg-sunken text-ink border-line' };
          const isTurn = e.type === 'ai.reply' || e.type === 'ai.shadow';
          const detail = detailOf(e);
          return (
            <li key={e.id} className="rounded-xl border border-line">
              <button
                type="button"
                disabled={!isTurn}
                onClick={() => setOpenId(openId === e.id ? null : e.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${meta.tone}`}>
                  {isTurn && <Sparkles size={11} />} {meta.label}
                </span>
                {detail && <span className="min-w-0 flex-1 truncate text-xs text-muted">{detail}</span>}
                <span className="ml-auto shrink-0 text-xs tabular-nums text-muted">{fmtDateTime(e.at)}</span>
              </button>
              {isTurn && openId === e.id && e.payload && (
                <div className="border-t border-line px-3 py-3">
                  {e.type === 'ai.shadow' && typeof e.payload.reply === 'string' && (
                    <p className="mb-3 whitespace-pre-wrap rounded-lg bg-sunken px-3 py-2 text-[13px] text-ink">{e.payload.reply}</p>
                  )}
                  <TraceView trace={e.payload} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </Modal>
  );
}
