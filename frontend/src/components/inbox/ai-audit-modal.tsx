'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, RefreshCw, User } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { apiFetch, ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';

interface AuditEvent {
  seq: number;
  type: string;
  actorType: string;
  payload: unknown;
  createdAt: string;
}

/**
 * Human-readable label + tone per event type. Anything not listed falls back to
 * the raw type, so a newly-instrumented event still renders sensibly.
 */
const LABELS: Record<string, { label: string; tone: string }> = {
  'conversation.handoff': {
    label: 'Handed off to a human',
    tone: 'bg-amber-50 text-amber-800 border-amber-200',
  },
  'order.created': {
    label: 'Order created',
    tone: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  },
  'order.duplicate_prevented': {
    label: 'Duplicate order prevented',
    tone: 'bg-sky-50 text-sky-800 border-sky-200',
  },
  'tool.failed': {
    label: 'Tool call failed',
    tone: 'bg-red-50 text-red-700 border-red-200',
  },
  'image.routed': {
    label: 'Image classified',
    tone: 'bg-violet-50 text-violet-800 border-violet-200',
  },
};

/** Pull the most useful one-line detail out of an event payload. */
function detailOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  for (const k of ['reason', 'orderName', 'imageType', 'tool', 'error']) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * "Why this reply?" — the per-conversation AI event timeline.
 *
 * Reads the append-only event log via the existing tenant-scoped endpoint
 * `GET /api/ai/audit/:conversationId` (any authenticated tenant user; agents
 * review their own chats). Read-only.
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
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setEvents(await apiFetch<AuditEvent[]>(`/ai/audit/${conversationId}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  if (!open) return null;

  return (
    <Modal open onClose={onClose} title="Why this reply?">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500">
            What the AI did on this chat, newest last.
          </p>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {loading && !events && (
          <p className="text-sm text-gray-500 py-4">Loading&hellip;</p>
        )}

        {events && events.length === 0 && (
          <p className="text-sm text-gray-500 py-4">
            No AI activity recorded on this conversation yet.
          </p>
        )}

        {events && events.length > 0 && (
          <ol className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
            {events.map((ev) => {
              const meta = LABELS[ev.type];
              const detail = detailOf(ev.payload);
              return (
                <li
                  key={ev.seq}
                  className={
                    'rounded-lg border px-3 py-2 ' +
                    (meta?.tone ?? 'bg-gray-50 text-gray-700 border-gray-200')
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium flex items-center gap-1.5">
                      {ev.actorType === 'AI' ? (
                        <Bot size={14} />
                      ) : (
                        <User size={14} />
                      )}
                      {meta?.label ?? ev.type}
                    </span>
                    <span className="text-[11px] opacity-70 shrink-0">
                      {fmtDateTime(ev.createdAt)}
                    </span>
                  </div>
                  {detail && (
                    <p className="text-xs mt-1 opacity-90 break-words">
                      {detail}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Modal>
  );
}
