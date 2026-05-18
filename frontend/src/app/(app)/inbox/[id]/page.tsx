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
  ArrowLeft,
  Check,
  CheckCheck,
  CornerUpLeft,
  FileText,
  Send,
  StickyNote,
  Tag,
  X,
} from 'lucide-react';
import { apiFetch, ApiError, postMultipart } from '@/lib/api';
import AttachmentPicker, {
  type MediaKind,
} from '@/components/inbox/attachment-picker';
import AttachmentPreview from '@/components/inbox/attachment-preview';
import ReplyQuoteStrip from '@/components/inbox/reply-quote-strip';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';
import {
  cn,
  dayKey,
  dayLabel,
  fmtTime,
  mediaUrl,
  windowCountdown,
} from '@/lib/utils';
import type {
  ConversationDetail,
  Message,
  ConversationNote,
  TemplateItem,
} from '@/lib/inbox-types';

const PAGE = 30;

export default function ThreadPage() {
  const params = useParams();
  const router = useRouter();
  const id = Number(params?.id);
  const { user } = useAuth();
  const { on, emit, status: socketStatus } = useSocket();
  const toast = useToast();

  const [convo, setConvo] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [staged, setStaged] = useState<{ file: File; kind: MediaKind } | null>(
    null,
  );
  const [caption, setCaption] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [viewers, setViewers] = useState<number[]>([]);
  const [typingFrom, setTypingFrom] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  // tick for countdown
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el)
        el.scrollTo({
          top: el.scrollHeight,
          behavior: smooth ? 'smooth' : 'auto',
        });
    });
  }, []);

  const loadConvo = useCallback(async () => {
    try {
      const c = await apiFetch<ConversationDetail>(
        `/inbox/conversations/${id}`,
      );
      setConvo(c);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load conversation',
      );
    }
  }, [id, toast]);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ rows: Message[]; nextCursor: number | null }>(
        `/inbox/conversations/${id}/messages`,
        { params: { limit: PAGE } },
      );
      setMessages([...res.rows].reverse());
      setNextCursor(res.nextCursor);
      scrollToBottom();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Failed to load messages',
      );
    } finally {
      setLoading(false);
    }
  }, [id, scrollToBottom, toast]);

  const markRead = useCallback(async () => {
    try {
      await apiFetch(`/inbox/conversations/${id}/mark-read`, {
        method: 'POST',
      });
    } catch {
      /* non-critical */
    }
  }, [id]);

  useEffect(() => {
    if (!Number.isFinite(id)) return;
    setLoading(true);
    loadConvo();
    loadMessages().then(() => markRead());
  }, [id, loadConvo, loadMessages, markRead]);

  // Collision detection + typing.
  useEffect(() => {
    if (!Number.isFinite(id)) return;
    emit('agent.viewing', { conversationId: id });

    const offViewing = on<{ conversationId: number; userId: number }>(
      'agent.viewing',
      (p) => {
        if (p.conversationId === id && p.userId !== user?.id) {
          setViewers((v) => (v.includes(p.userId) ? v : [...v, p.userId]));
        }
      },
    );
    const offLeft = on<{ conversationId: number; userId: number }>(
      'agent.left',
      (p) => {
        if (p.conversationId === id)
          setViewers((v) => v.filter((u) => u !== p.userId));
      },
    );
    const offTypingStart = on<{ conversationId: number; userId: number }>(
      'typing.start',
      (p) => {
        if (p.conversationId === id && p.userId !== user?.id)
          setTypingFrom(p.userId);
      },
    );
    const offTypingStop = on<{ conversationId: number }>(
      'typing.stop',
      (p) => {
        if (p.conversationId === id) setTypingFrom(null);
      },
    );

    return () => {
      emit('agent.left', { conversationId: id });
      offViewing();
      offLeft();
      offTypingStart();
      offTypingStop();
      setViewers([]);
      setTypingFrom(null);
    };
  }, [id, emit, on, user?.id]);

  // Message + conversation realtime.
  useEffect(() => {
    const appendIfActive = (m: Message | undefined) => {
      if (!m || m.conversation_id !== id) return;
      setMessages((cur) =>
        cur.some((x) => x.id === m.id) ? cur : [...cur, m],
      );
      scrollToBottom(true);
    };
    const offRecv = on<{ message: Message; conversationId: number }>(
      'message.received',
      (p) => {
        if (p.conversationId === id || p.message?.conversation_id === id) {
          appendIfActive(p.message);
          markRead();
        }
      },
    );
    const offSent = on<{ message: Message }>('message.sent', (p) =>
      appendIfActive(p.message),
    );
    const offStatus = on<{ messageId: number; status: Message['status'] }>(
      'message.status',
      (p) => {
        setMessages((cur) =>
          cur.map((m) =>
            m.id === p.messageId ? { ...m, status: p.status } : m,
          ),
        );
      },
    );
    const offReadBulk = on<{ conversationId: number }>(
      'message.read.bulk',
      (p) => {
        if (p.conversationId !== id) return;
        setMessages((cur) =>
          cur.map((m) =>
            m.direction === 'inbound' && !m.read_at
              ? { ...m, read_at: new Date().toISOString() }
              : m,
          ),
        );
      },
    );
    const offAssigned = on<{ conversationId: number }>(
      'conversation.assigned',
      (p) => {
        if (p.conversationId === id) loadConvo();
      },
    );
    const offUpdated = on<{ conversationId: number }>(
      'conversation.updated',
      (p) => {
        if (p.conversationId === id) loadConvo();
      },
    );
    return () => {
      offRecv();
      offSent();
      offStatus();
      offReadBulk();
      offAssigned();
      offUpdated();
    };
  }, [id, on, scrollToBottom, loadConvo, markRead]);

  // Reconnect catch-up.
  const prevSock = useRef(socketStatus);
  useEffect(() => {
    if (prevSock.current !== 'connected' && socketStatus === 'connected') {
      loadConvo();
      loadMessages();
    }
    prevSock.current = socketStatus;
  }, [socketStatus, loadConvo, loadMessages]);

  const onScroll = async () => {
    const el = scrollRef.current;
    if (!el || el.scrollTop > 60 || loadingOlder || nextCursor == null) return;
    setLoadingOlder(true);
    const prevH = el.scrollHeight;
    try {
      const res = await apiFetch<{
        rows: Message[];
        nextCursor: number | null;
      }>(`/inbox/conversations/${id}/messages`, {
        params: { cursor: nextCursor, limit: PAGE },
      });
      setMessages((cur) => [...[...res.rows].reverse(), ...cur]);
      setNextCursor(res.nextCursor);
      requestAnimationFrame(() => {
        if (scrollRef.current)
          scrollRef.current.scrollTop =
            scrollRef.current.scrollHeight - prevH;
      });
    } catch {
      /* ignore */
    } finally {
      setLoadingOlder(false);
    }
  };

  const win = useMemo(
    () => windowCountdown(convo?.window_expires_at, now),
    [convo?.window_expires_at, now],
  );

  const clearReply = () => setReplyTo(null);
  const clearStaged = () => {
    setStaged(null);
    setCaption('');
  };

  const scrollToMessage = (mid: number) => {
    const el = document.getElementById(`msg-${mid}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-green-400');
      setTimeout(() => el.classList.remove('ring-2', 'ring-green-400'), 1500);
    }
  };

  const sendText = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await apiFetch(`/inbox/conversations/${id}/send`, {
        method: 'POST',
        body: {
          type: 'text',
          content: body,
          ...(replyTo ? { contextMessageId: replyTo.id } : {}),
        },
      });
      setText('');
      clearReply();
      emit('typing.stop', { conversationId: id });
      // message.sent socket event appends it
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Send failed');
    } finally {
      setSending(false);
    }
  };

  const sendMedia = async () => {
    if (!staged || sending) return;
    setSending(true);
    try {
      const fd = new FormData();
      fd.append('file', staged.file, staged.file.name);
      if (caption.trim()) fd.append('caption', caption.trim());
      if (replyTo) fd.append('contextMessageId', String(replyTo.id));
      await postMultipart(`/inbox/conversations/${id}/send-media`, fd);
      clearStaged();
      clearReply();
      // message.sent socket event appends it
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Upload failed');
    } finally {
      setSending(false);
    }
  };

  const assignToMe = async () => {
    if (!user) return;
    try {
      await apiFetch(`/inbox/conversations/${id}/assign`, {
        method: 'POST',
        body: { userId: user.id },
      });
      toast.success('Assigned to you');
      loadConvo();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Assign failed');
    }
  };

  const toggleResolve = async () => {
    const resolved = convo?.status === 'resolved';
    try {
      await apiFetch(
        `/inbox/conversations/${id}/${resolved ? 'reopen' : 'resolve'}`,
        { method: 'POST' },
      );
      loadConvo();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    }
  };

  const addLabel = async () => {
    const label = prompt('New label')?.trim();
    if (!label) return;
    try {
      await apiFetch(`/inbox/conversations/${id}/labels`, {
        method: 'POST',
        body: { label },
      });
      loadConvo();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    }
  };

  const removeLabel = async (label: string) => {
    try {
      await apiFetch(
        `/inbox/conversations/${id}/labels/${encodeURIComponent(label)}`,
        { method: 'DELETE' },
      );
      loadConvo();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    }
  };

  const grouped = useMemo(() => {
    const out: Array<{ day: string; items: Message[] }> = [];
    for (const m of messages) {
      const k = dayKey(m.timestamp || m.created_at);
      const last = out[out.length - 1];
      if (last && last.day === k) last.items.push(m);
      else out.push({ day: k, items: [m] });
    }
    return out;
  }, [messages]);

  if (!Number.isFinite(id)) return null;

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3">
        <button
          className="md:hidden text-gray-500"
          onClick={() => router.push('/inbox')}
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900 truncate">
            {convo?.contact?.name || convo?.contact?.phone || 'Conversation'}
          </p>
          <p className="text-xs text-gray-500 truncate">
            {convo?.contact?.phone}
            {convo?.assigned_user
              ? ` · ${convo.assigned_user.name}`
              : ' · Unassigned'}
          </p>
        </div>
        <span
          className={cn(
            'text-xs px-2 py-1 rounded-full',
            win.open
              ? 'bg-green-100 text-green-700'
              : 'bg-gray-200 text-gray-600',
          )}
        >
          {win.label}
        </span>
        <button
          onClick={assignToMe}
          className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50"
        >
          Assign to me
        </button>
        <button
          onClick={toggleResolve}
          className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50"
        >
          {convo?.status === 'resolved' ? 'Reopen' : 'Resolve'}
        </button>
        <button
          onClick={() => setNotesOpen(true)}
          className="text-gray-500 hover:text-gray-800"
          title="Internal notes"
        >
          <StickyNote size={18} />
        </button>
      </div>

      {/* Labels + banners */}
      <div className="bg-white border-b border-gray-100 px-4 py-2 flex items-center gap-2 flex-wrap">
        <Tag size={14} className="text-gray-400" />
        {convo?.labels?.map((l) => (
          <span
            key={l.id}
            className="text-xs bg-gray-100 text-gray-700 rounded-full px-2 py-0.5 flex items-center gap-1"
          >
            {l.label}
            <button
              onClick={() => removeLabel(l.label)}
              className="text-gray-400 hover:text-red-500"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <button
          onClick={addLabel}
          className="text-xs text-green-600 hover:underline"
        >
          + label
        </button>
      </div>

      {viewers.length > 0 && (
        <div className="bg-yellow-50 text-yellow-800 text-xs px-4 py-1.5 border-b border-yellow-200">
          Another agent is also viewing this conversation.
        </div>
      )}
      {socketStatus !== 'connected' && (
        <div className="bg-orange-50 text-orange-700 text-xs px-4 py-1.5 border-b border-orange-200">
          Reconnecting…
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-1"
      >
        {loadingOlder && (
          <p className="text-center text-xs text-gray-400 py-2">Loading…</p>
        )}
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <p className="text-center text-sm text-gray-400 py-10">
            No messages yet.
          </p>
        ) : (
          grouped.map((g) => (
            <div key={g.day}>
              <div className="flex justify-center my-3">
                <span className="text-[11px] bg-gray-200 text-gray-600 rounded-full px-3 py-0.5">
                  {dayLabel(g.day)}
                </span>
              </div>
              {g.items.map((m) => (
                <Bubble
                  key={m.id}
                  m={m}
                  onReply={() => setReplyTo(m)}
                  onJump={scrollToMessage}
                />
              ))}
            </div>
          ))
        )}
        {typingFrom && (
          <p className="text-xs text-gray-400 italic px-2">
            {convo?.contact?.name || 'Someone'} is typing…
          </p>
        )}
      </div>

      {/* Composer */}
      <div className="bg-white border-t border-gray-200 p-3">
        {win.open ? (
          <div>
            {replyTo && (
              <ReplyQuoteStrip
                message={replyTo}
                contactName={convo?.contact?.name || 'Customer'}
                onClear={clearReply}
              />
            )}
            {staged ? (
              <AttachmentPreview
                file={staged.file}
                kind={staged.kind}
                caption={caption}
                onCaptionChange={setCaption}
                onClear={clearStaged}
                onSend={sendMedia}
                sending={sending}
              />
            ) : (
              <div className="flex items-end gap-2">
                <AttachmentPicker
                  onPick={(p) => {
                    setStaged(p);
                    setCaption('');
                  }}
                />
                <textarea
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    emit('typing.start', { conversationId: id });
                  }}
                  onBlur={() => emit('typing.stop', { conversationId: id })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendText();
                    }
                  }}
                  rows={1}
                  placeholder="Type a message"
                  className="flex-1 resize-none border border-gray-300 rounded-lg px-3 py-2 text-sm max-h-32 focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <button
                  onClick={() => setTplOpen(true)}
                  title="Send template"
                  className="p-2 text-gray-500 hover:text-gray-800"
                >
                  <FileText size={20} />
                </button>
                <button
                  onClick={sendText}
                  disabled={sending || !text.trim()}
                  className="bg-green-600 hover:bg-green-700 text-white p-2.5 rounded-lg disabled:opacity-40"
                >
                  <Send size={18} />
                </button>
              </div>
            )}
          </div>
        ) : (
          <div>
            {replyTo && (
              <ReplyQuoteStrip
                message={replyTo}
                contactName={convo?.contact?.name || 'Customer'}
                onClear={clearReply}
              />
            )}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <AttachmentPicker
                  disabled
                  onPick={() => {
                    /* disabled outside 24hr window */
                  }}
                />
                <p className="text-xs text-gray-500">
                  24-hour window expired — only approved templates can be sent.
                </p>
              </div>
              <button
                onClick={() => setTplOpen(true)}
                className="bg-green-600 hover:bg-green-700 text-white text-sm px-4 py-2 rounded-lg flex items-center gap-2"
              >
                <FileText size={16} /> Send template
              </button>
            </div>
          </div>
        )}
      </div>

      {notesOpen && (
        <NotesDrawer id={id} onClose={() => setNotesOpen(false)} />
      )}
      {tplOpen && (
        <TemplatePicker
          id={id}
          onClose={() => setTplOpen(false)}
          onSent={() => {
            setTplOpen(false);
            toast.success('Template sent');
          }}
        />
      )}
    </div>
  );
}

function Ticks({ m }: { m: Message }) {
  if (m.direction !== 'outbound') return null;
  if (m.status === 'failed')
    return <span className="text-red-500 text-[11px]">failed</span>;
  if (m.status === 'read')
    return <CheckCheck size={14} className="text-blue-500" />;
  if (m.status === 'delivered')
    return <CheckCheck size={14} className="text-gray-400" />;
  return <Check size={14} className="text-gray-400" />;
}

function ContextQuote({
  ctx,
  out,
  onJump,
}: {
  ctx: NonNullable<Message['context_message']>;
  out: boolean;
  onJump: (id: number) => void;
}) {
  let label = ctx.content?.trim();
  if (!label) {
    label =
      ctx.message_type === 'image'
        ? '[image]'
        : ctx.message_type === 'video'
          ? '[video]'
          : ctx.message_type === 'audio'
            ? '[audio]'
            : ctx.message_type === 'document'
              ? '[document]'
              : '[message]';
  }
  return (
    <button
      type="button"
      onClick={() => onJump(ctx.id)}
      className={cn(
        'block w-full text-left border-l-4 rounded px-2 py-1 mb-1 text-xs truncate',
        out
          ? 'border-green-200 bg-green-700/40 text-green-50'
          : 'border-green-500 bg-gray-100 text-gray-600',
      )}
      title="Jump to original"
    >
      {label.slice(0, 80)}
    </button>
  );
}

function Bubble({
  m,
  onReply,
  onJump,
}: {
  m: Message;
  onReply: () => void;
  onJump: (id: number) => void;
}) {
  const out = m.direction === 'outbound';
  const url = mediaUrl(m.media_url);
  const isMedia = ['image', 'audio', 'video', 'document'].includes(
    m.message_type,
  );
  return (
    <div
      id={`msg-${m.id}`}
      className={cn(
        'group flex mb-1.5 items-center gap-1.5 rounded-lg transition-shadow',
        out ? 'justify-end' : 'justify-start',
      )}
    >
      {out && (
        <button
          type="button"
          onClick={onReply}
          title="Reply"
          className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-700 transition-opacity"
        >
          <CornerUpLeft size={15} />
        </button>
      )}
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-3 py-2 text-sm',
          out
            ? 'bg-green-600 text-white rounded-br-sm'
            : 'bg-white border border-gray-200 text-gray-900 rounded-bl-sm',
        )}
      >
        {m.context_message && (
          <ContextQuote ctx={m.context_message} out={out} onJump={onJump} />
        )}
        {isMedia && m.media_expired && (
          <div
            className={cn(
              'text-xs italic mb-1',
              out ? 'text-green-100' : 'text-gray-400',
            )}
          >
            Media expired
          </div>
        )}
        {isMedia && !m.media_expired && url && (
          <div className="mb-1">
            {m.message_type === 'image' && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt="attachment"
                className="rounded-lg max-w-full max-h-72"
              />
            )}
            {m.message_type === 'video' && (
              <video src={url} controls className="rounded-lg max-w-full" />
            )}
            {m.message_type === 'audio' && (
              <audio src={url} controls className="w-56" />
            )}
            {m.message_type === 'document' && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'flex items-center gap-2 underline',
                  out ? 'text-white' : 'text-green-700',
                )}
              >
                <FileText size={16} /> Download document
              </a>
            )}
          </div>
        )}
        {m.content && <p className="whitespace-pre-wrap break-words">{m.content}</p>}
        <div
          className={cn(
            'flex items-center gap-1 justify-end mt-1 text-[10px]',
            out ? 'text-green-100' : 'text-gray-400',
          )}
        >
          <span>{fmtTime(m.timestamp || m.created_at)}</span>
          <Ticks m={m} />
        </div>
      </div>
      {!out && (
        <button
          type="button"
          onClick={onReply}
          title="Reply"
          className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-700 transition-opacity"
        >
          <CornerUpLeft size={15} />
        </button>
      )}
    </div>
  );
}

function NotesDrawer({
  id,
  onClose,
}: {
  id: number;
  onClose: () => void;
}) {
  const toast = useToast();
  const [notes, setNotes] = useState<ConversationNote[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const n = await apiFetch<ConversationNote[]>(
        `/inbox/conversations/${id}/notes`,
      );
      setNotes(n);
    } catch {
      /* ignore */
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await apiFetch(`/inbox/conversations/${id}/notes`, {
        method: 'POST',
        body: { body: body.trim() },
      });
      setBody('');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} aria-hidden />
      <div className="w-full max-w-md bg-yellow-50 h-full flex flex-col shadow-xl">
        <div className="p-4 border-b border-yellow-200 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-gray-900">Internal notes</h3>
            <p className="text-xs text-yellow-700">
              Internal — not visible to customer
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500">
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {notes.length === 0 && (
            <p className="text-sm text-gray-400">No notes yet.</p>
          )}
          {notes.map((n) => (
            <div
              key={n.id}
              className="bg-yellow-100 border border-yellow-200 rounded-lg p-3 text-sm text-gray-800"
            >
              <p className="whitespace-pre-wrap">{n.body}</p>
              <p className="text-[11px] text-yellow-700 mt-1">
                {new Date(n.created_at).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-yellow-200">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="Add an internal note…"
            className="w-full border border-yellow-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
          />
          <button
            onClick={add}
            disabled={busy || !body.trim()}
            className="mt-2 w-full bg-yellow-600 hover:bg-yellow-700 text-white text-sm py-2 rounded-lg disabled:opacity-50"
          >
            Add note
          </button>
        </div>
      </div>
    </div>
  );
}

function extractVars(tpl: TemplateItem): string[] {
  const body = tpl.content?.components?.find(
    (c) => (c.type || '').toLowerCase() === 'body',
  );
  const text = body?.text ?? '';
  const found = new Set<string>();
  const re = /\{\{(\d+)\}\}/g;
  let mtch: RegExpExecArray | null;
  while ((mtch = re.exec(text))) found.add(mtch[1]);
  return Array.from(found).sort((a, b) => Number(a) - Number(b));
}

function TemplatePicker({
  id,
  onClose,
  onSent,
}: {
  id: number;
  onClose: () => void;
  onSent: () => void;
}) {
  const toast = useToast();
  const [tpls, setTpls] = useState<TemplateItem[]>([]);
  const [sel, setSel] = useState<TemplateItem | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<TemplateItem[]>('/templates', {
      params: { status: 'approved' },
    })
      .then(setTpls)
      .catch((e) =>
        toast.error(
          e instanceof ApiError ? e.userMessage : 'Failed to load templates',
        ),
      )
      .finally(() => setLoading(false));
  }, [toast]);

  const varNames = sel ? extractVars(sel) : [];

  const send = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      await apiFetch(`/inbox/conversations/${id}/send`, {
        method: 'POST',
        body: {
          type: 'template',
          templateId: sel.id,
          variables: vars,
        },
      });
      onSent();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Send failed');
    } finally {
      setBusy(false);
    }
  };

  const bodyText =
    sel?.content?.components?.find(
      (c) => (c.type || '').toLowerCase() === 'body',
    )?.text ?? '';
  const preview = bodyText.replace(/\{\{(\d+)\}\}/g, (_, n) =>
    vars[n] ? vars[n] : `{{${n}}}`,
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">Send a template</h3>
          <button onClick={onClose} className="text-gray-500">
            <X size={20} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto space-y-4">
          {loading ? (
            <p className="text-sm text-gray-400">Loading templates…</p>
          ) : tpls.length === 0 ? (
            <p className="text-sm text-gray-400">
              No approved templates available.
            </p>
          ) : (
            <select
              value={sel?.id ?? ''}
              onChange={(e) => {
                const t = tpls.find((x) => x.id === Number(e.target.value));
                setSel(t ?? null);
                setVars({});
              }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Select a template…</option>
              {tpls.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.category})
                </option>
              ))}
            </select>
          )}

          {sel && varNames.length > 0 && (
            <div className="space-y-2">
              {varNames.map((v) => (
                <div key={v}>
                  <label className="block text-xs text-gray-500 mb-1">
                    Variable {`{{${v}}}`}
                  </label>
                  <input
                    value={vars[v] ?? ''}
                    onChange={(e) =>
                      setVars((cur) => ({ ...cur, [v]: e.target.value }))
                    }
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              ))}
            </div>
          )}

          {sel && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm text-gray-700">
              <p className="text-xs text-gray-400 mb-1">Preview</p>
              <p className="whitespace-pre-wrap">{preview}</p>
            </div>
          )}
        </div>
        <div className="p-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={!sel || busy}
            className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
