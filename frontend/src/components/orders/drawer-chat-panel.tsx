'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, Send } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { useSocket } from '@/context/socket-context';
import { cn, fmtTime, mediaUrl } from '@/lib/utils';
import type { Message } from '@/lib/inbox-types';

/**
 * Embedded WhatsApp thread shown INSIDE the order-detail drawer, so "Open chat"
 * opens the conversation in place instead of navigating to /inbox (which loses
 * the agent's spot on the orders board). Focused by design: message history +
 * live socket updates + a text composer. Templates / media / AI live in the full
 * inbox; a "full inbox" link is provided for those. Reuses the exact inbox REST
 * + socket contract (`/inbox/conversations/:id/messages|send|mark-read`,
 * `message.received|sent|status`).
 */
export function DrawerChatPanel({
  conversationId,
  title,
  onBack,
}: {
  conversationId: number;
  title?: string | null;
  onBack: () => void;
}) {
  const toast = useToast();
  const { on } = useSocket();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const markRead = useCallback(() => {
    apiFetch(`/inbox/conversations/${conversationId}/mark-read`, {
      method: 'POST',
    }).catch(() => undefined);
  }, [conversationId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ rows: Message[]; nextCursor: number | null }>(
        `/inbox/conversations/${conversationId}/messages`,
        { params: { limit: 30 } },
      );
      setMessages([...res.rows].reverse());
      scrollToBottom();
      markRead();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load messages');
    } finally {
      setLoading(false);
    }
  }, [conversationId, scrollToBottom, markRead, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Live updates for THIS conversation.
  useEffect(() => {
    const append = (m?: Message) => {
      if (!m || m.conversation_id !== conversationId) return;
      setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
      scrollToBottom();
    };
    const offRecv = on<{ message: Message; conversationId: number }>(
      'message.received',
      (p) => {
        if (p.conversationId === conversationId || p.message?.conversation_id === conversationId) {
          append(p.message);
          markRead();
        }
      },
    );
    const offSent = on<{ message: Message }>('message.sent', (p) => append(p.message));
    const offStatus = on<{ messageId: number; status: Message['status']; error?: string }>(
      'message.status',
      (p) => {
        setMessages((cur) =>
          cur.map((m) =>
            m.id === p.messageId
              ? { ...m, status: p.status, error: p.error ?? m.error ?? null }
              : m,
          ),
        );
      },
    );
    return () => {
      offRecv();
      offSent();
      offStatus();
    };
  }, [conversationId, on, scrollToBottom, markRead]);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    const clientId = `c${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const nowIso = new Date().toISOString();
    const optimistic: Message = {
      id: -Date.now(),
      client_id: clientId,
      conversation_id: conversationId,
      message_type: 'text',
      direction: 'outbound',
      content: trimmed,
      media_url: null,
      media_expired: false,
      status: 'sending',
      read_at: null,
      timestamp: nowIso,
      created_at: nowIso,
    };
    setMessages((cur) => [...cur, optimistic]);
    setText('');
    setSending(true);
    scrollToBottom();
    try {
      const real = await apiFetch<Message | undefined>(
        `/inbox/conversations/${conversationId}/send`,
        { method: 'POST', body: { type: 'text', content: trimmed, clientId } },
      );
      if (real && typeof real === 'object' && 'id' in real) {
        setMessages((cur) =>
          cur.map((m) =>
            m.client_id === clientId ? { ...(real as Message), client_id: clientId } : m,
          ),
        );
      }
    } catch (e) {
      setMessages((cur) =>
        cur.map((m) => (m.client_id === clientId ? { ...m, status: 'failed' } : m)),
      );
      toast.error(
        e instanceof ApiError
          ? e.userMessage
          : 'Could not send — the 24-hour window may be closed. Use a template from the full inbox.',
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#efeae2]">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-3 py-2.5">
        <button
          onClick={onBack}
          className="rounded-lg p-1 text-gray-500 hover:bg-gray-100"
          title="Back to order"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-gray-800">
            {title || 'Conversation'}
          </div>
          <div className="text-[11px] text-gray-400">WhatsApp chat</div>
        </div>
        <a
          href={`/inbox/${conversationId}`}
          className="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
          title="Open in the full inbox (templates, media, AI…)"
        >
          Full inbox
        </a>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="flex h-full items-center justify-center text-gray-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-sm text-gray-400">
            No messages yet.
          </div>
        ) : (
          messages.map((m) => <ChatBubble key={m.id} m={m} />)
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-gray-200 bg-white p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder="Type a message…"
            className="max-h-28 min-h-[38px] flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
          />
          <button
            onClick={send}
            disabled={!text.trim() || sending}
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg bg-[#22c35e] text-white hover:brightness-95 disabled:opacity-50"
            title="Send"
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ m }: { m: Message }) {
  const out = m.direction === 'outbound';
  const isImage = m.message_type === 'image' || m.message_type === 'sticker';
  const src = m.media_url ? mediaUrl(m.media_url) : null;
  return (
    <div className={cn('flex', out ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-2.5 py-1.5 text-sm shadow-sm',
          out ? 'bg-[#d9fdd3] text-gray-800' : 'bg-white text-gray-800',
        )}
      >
        {isImage && src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            className="mb-1 max-h-56 w-auto rounded-md"
          />
        )}
        {!isImage && m.media_url && (
          <a
            href={src ?? '#'}
            target="_blank"
            rel="noreferrer"
            className="block text-xs font-medium text-blue-600 underline"
          >
            📎 {m.message_type} attachment
          </a>
        )}
        {m.content && <div className="whitespace-pre-wrap break-words">{m.content}</div>}
        <div
          className={cn(
            'mt-0.5 text-right text-[10px]',
            out ? 'text-green-700/70' : 'text-gray-400',
          )}
        >
          {fmtTime(m.timestamp)}
          {out && m.status === 'sending' && ' · sending…'}
          {out && m.status === 'failed' && ' · failed'}
        </div>
      </div>
    </div>
  );
}
