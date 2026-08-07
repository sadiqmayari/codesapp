'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Send,
  Smile,
  Paperclip,
  Megaphone,
  Search,
  ArrowLeft,
  Users,
  X,
  Loader2,
} from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { cn, mediaUrl, fmtListTime, fmtTime, dayKey, dayLabel } from '@/lib/utils';
import VoiceRecorder from '@/components/inbox/voice-recorder';
import EmojiPicker from '@/components/inbox/emoji-picker';
import AudioMessage from '@/components/inbox/audio-message';
import {
  type ThreadItem,
  type RosterUser,
  type ChatMessage,
  type ChatMessageType,
  getRoster,
  getThreads,
  openDm,
  getThreadMessages,
  sendTeamText,
  sendTeamMedia,
  markThreadRead,
} from '@/lib/team-chat';

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

export default function TeamChatPage() {
  const { user } = useAuth();
  const { on, emit } = useSocket();
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const meId = user?.id ?? 0;
  const privileged = user?.role === 'owner' || user?.role === 'admin';

  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [roster, setRoster] = useState<RosterUser[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [text, setText] = useState('');
  const [staged, setStaged] = useState<File | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [typingFrom, setTypingFrom] = useState<number | null>(null);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;

  const active = useMemo(
    () => threads.find((t) => t.id === activeId) ?? null,
    [threads, activeId],
  );
  const canPost = active ? active.kind === 'dm' || privileged : false;

  // ── initial load ──
  const loadThreads = useCallback(async () => {
    try {
      setThreads(await getThreads());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load chats');
    }
  }, [toast]);

  useEffect(() => {
    loadThreads();
    getRoster()
      .then(setRoster)
      .catch(() => undefined);
  }, [loadThreads]);

  // open thread from ?t= (deep link from notifications)
  useEffect(() => {
    const t = Number(params.get('t'));
    if (Number.isFinite(t) && t > 0) setActiveId(t);
  }, [params]);

  // ── load messages when active thread changes ──
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let alive = true;
    setLoadingMsgs(true);
    setTypingFrom(null);
    getThreadMessages(activeId)
      .then((r) => {
        if (alive) setMessages(r.messages);
      })
      .catch(() => {
        if (alive) setMessages([]);
      })
      .finally(() => {
        if (alive) setLoadingMsgs(false);
      });
    // mark read + zero the local unread badge
    markThreadRead(activeId).catch(() => undefined);
    setThreads((prev) =>
      prev.map((t) => (t.id === activeId ? { ...t, unreadCount: 0 } : t)),
    );
    return () => {
      alive = false;
    };
  }, [activeId]);

  // keep scrolled to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loadingMsgs]);

  // ── realtime ──
  useEffect(() => {
    const offs = [
      on('dm.message', (p: { threadId: number; message: ChatMessage }) => {
        const { threadId, message } = p;
        if (threadId === activeIdRef.current) {
          setMessages((prev) => {
            // reconcile optimistic temp by client_id
            if (message.clientId && prev.some((m) => m.clientId === message.clientId)) {
              return prev.map((m) => (m.clientId === message.clientId ? message : m));
            }
            if (prev.some((m) => m.id === message.id)) return prev;
            return [...prev, message];
          });
          if (message.senderId !== meId) markThreadRead(threadId).catch(() => undefined);
        }
        // refresh the thread list ordering + previews + unread
        loadThreads();
      }),
      on('dm.read', () => loadThreads()),
      on('dm.typing', (p: { threadId: number; userId: number }) => {
        if (p.threadId === activeIdRef.current && p.userId !== meId) {
          setTypingFrom(p.userId);
          window.setTimeout(() => setTypingFrom(null), 3000);
        }
      }),
      on('presence.update', (p: { userId: number; online: boolean }) => {
        setRoster((prev) =>
          prev.map((u) => (u.id === p.userId ? { ...u, online: p.online } : u)),
        );
        setThreads((prev) =>
          prev.map((t) =>
            t.otherUserId === p.userId ? { ...t, online: p.online } : t,
          ),
        );
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [on, meId, loadThreads]);

  // ── select / start ──
  const selectThread = (id: number) => {
    setActiveId(id);
    router.replace(`/team-chat?t=${id}`);
  };

  const startDm = async (u: RosterUser) => {
    setPickerOpen(false);
    try {
      const t = await openDm(u.id);
      setThreads((prev) => (prev.some((x) => x.id === t.id) ? prev : [t, ...prev]));
      selectThread(t.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not start chat');
    }
  };

  // ── send ──
  const pushOptimistic = (msg: ChatMessage) => setMessages((p) => [...p, msg]);

  const sendText = async () => {
    const body = text.trim();
    if (!body || !activeId) return;
    const clientId = uid();
    setText('');
    pushOptimistic({
      id: -Date.now(),
      threadId: activeId,
      senderId: meId,
      type: 'text',
      content: body,
      mediaUrl: null,
      mediaMime: null,
      mediaName: null,
      clientId,
      createdAt: new Date().toISOString(),
    });
    try {
      await sendTeamText(activeId, body, clientId);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to send');
      setMessages((p) => p.filter((m) => m.clientId !== clientId));
    }
  };

  const sendFile = async (file: File, kind: ChatMessageType) => {
    if (!activeId) return;
    const clientId = uid();
    pushOptimistic({
      id: -Date.now(),
      threadId: activeId,
      senderId: meId,
      type: kind,
      content: null,
      mediaUrl: URL.createObjectURL(file),
      mediaMime: file.type,
      mediaName: file.name,
      clientId,
      createdAt: new Date().toISOString(),
    });
    setStaged(null);
    try {
      await sendTeamMedia(activeId, file, kind, clientId);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to send file');
      setMessages((p) => p.filter((m) => m.clientId !== clientId));
    }
  };

  const onPickFile = (f: File | null) => {
    if (!f) return;
    const kind: ChatMessageType = f.type.startsWith('image/') ? 'image' : 'file';
    sendFile(f, kind);
  };

  const onType = () => {
    if (active?.kind === 'dm' && active.otherUserId) {
      emit('dm.typing', { threadId: active.id, toUserId: active.otherUserId });
    }
  };

  // group messages by day
  const grouped = useMemo(() => {
    const out: Array<{ day: string; items: ChatMessage[] }> = [];
    for (const m of messages) {
      const k = dayKey(m.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === k) last.items.push(m);
      else out.push({ day: k, items: [m] });
    }
    return out;
  }, [messages]);

  return (
    <div className="h-full flex bg-gray-50">
      {/* ── Left: thread list ── */}
      <div
        className={cn(
          'w-full md:w-80 lg:w-96 border-r border-gray-200 bg-white flex flex-col',
          activeId && 'hidden md:flex',
        )}
      >
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h1 className="font-semibold text-gray-900">Team chat</h1>
          <button
            onClick={() => setPickerOpen(true)}
            title="New direct message"
            className="inline-flex items-center gap-1 text-xs font-medium text-green-700 hover:bg-green-50 rounded-lg px-2 py-1"
          >
            <Users size={15} /> New chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {threads.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-400">
              No chats yet. Start one with “New chat”.
            </p>
          ) : (
            threads.map((t) => (
              <button
                key={t.id}
                onClick={() => selectThread(t.id)}
                className={cn(
                  'w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 flex items-center gap-3',
                  activeId === t.id && 'bg-green-50',
                )}
              >
                <span
                  className={cn(
                    'relative w-10 h-10 rounded-full flex items-center justify-center font-semibold shrink-0',
                    t.kind === 'broadcast'
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-green-600 text-white',
                  )}
                >
                  {t.kind === 'broadcast' ? (
                    <Megaphone size={18} />
                  ) : (
                    (t.title[0] ?? '?').toUpperCase()
                  )}
                  {t.kind === 'dm' && t.online && (
                    <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-green-500 ring-2 ring-white" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-900 truncate">{t.title}</span>
                    <span className="text-[11px] text-gray-400 shrink-0">
                      {t.lastMessageAt ? fmtListTime(t.lastMessageAt) : ''}
                    </span>
                  </span>
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-xs text-gray-500 truncate">
                      {t.lastMessage || (t.kind === 'broadcast' ? 'Company-wide channel' : 'No messages yet')}
                    </span>
                    {t.unreadCount > 0 && (
                      <span className="bg-green-600 text-white text-[10px] rounded-full px-1.5 min-w-[18px] text-center shrink-0">
                        {t.unreadCount > 99 ? '99+' : t.unreadCount}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Right: active thread ── */}
      <div className={cn('flex-1 flex-col min-w-0', activeId ? 'flex' : 'hidden md:flex')}>
        {!active ? (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
            Select a chat to start messaging
          </div>
        ) : (
          <>
            {/* header */}
            <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3">
              <button
                className="md:hidden text-gray-500"
                onClick={() => {
                  setActiveId(null);
                  router.replace('/team-chat');
                }}
                aria-label="Back"
              >
                <ArrowLeft size={20} />
              </button>
              <span
                className={cn(
                  'w-9 h-9 rounded-full flex items-center justify-center font-semibold shrink-0',
                  active.kind === 'broadcast'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-green-600 text-white',
                )}
              >
                {active.kind === 'broadcast' ? (
                  <Megaphone size={16} />
                ) : (
                  (active.title[0] ?? '?').toUpperCase()
                )}
              </span>
              <div className="min-w-0">
                <p className="font-semibold text-gray-900 truncate">{active.title}</p>
                <p className="text-xs text-gray-500 truncate">
                  {typingFrom
                    ? 'typing…'
                    : active.kind === 'broadcast'
                      ? 'Everyone in your team'
                      : active.online
                        ? 'Online'
                        : active.lastSeen
                          ? `Last seen ${fmtListTime(active.lastSeen)}`
                          : 'Offline'}
                </p>
              </div>
            </div>

            {/* messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1">
              {loadingMsgs ? (
                <div className="h-full flex items-center justify-center text-gray-300">
                  <Loader2 className="animate-spin" size={22} />
                </div>
              ) : messages.length === 0 ? (
                <div className="h-full flex items-center justify-center text-gray-400 text-sm">
                  No messages yet — say hello 👋
                </div>
              ) : (
                grouped.map((g) => (
                  <div key={g.day}>
                    <div className="flex justify-center my-3">
                      <span className="text-[11px] bg-gray-200 text-gray-600 rounded-full px-2 py-0.5">
                        {dayLabel(g.day)}
                      </span>
                    </div>
                    {g.items.map((m, i) => (
                      <Bubble
                        key={m.id}
                        m={m}
                        mine={m.senderId === meId}
                        showSender={active.kind === 'broadcast' && m.senderId !== meId}
                        senderName={roster.find((u) => u.id === m.senderId)?.name}
                        nextAudioId={
                          g.items[i + 1]?.type === 'audio' ? g.items[i + 1].id : null
                        }
                      />
                    ))}
                  </div>
                ))
              )}
            </div>

            {/* composer */}
            {canPost ? (
              <div className="bg-white border-t border-gray-200 p-3">
                <div className="relative flex items-end gap-2 bg-gray-100 rounded-2xl px-2 py-1.5">
                  <div className="relative">
                    <button
                      onClick={() => setEmojiOpen((o) => !o)}
                      className="text-gray-500 hover:text-gray-700 p-1"
                      aria-label="Emoji"
                    >
                      <Smile size={20} />
                    </button>
                    {emojiOpen && (
                      <EmojiPicker
                        onPick={(e) => {
                          setText((t) => t + e);
                          composerRef.current?.focus();
                        }}
                        onClose={() => setEmojiOpen(false)}
                      />
                    )}
                  </div>
                  <textarea
                    ref={composerRef}
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      onType();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendText();
                      }
                    }}
                    rows={1}
                    placeholder="Message…"
                    className="flex-1 bg-transparent resize-none outline-none text-sm py-1.5 max-h-32"
                  />
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="text-gray-500 hover:text-gray-700 p-1"
                    aria-label="Attach"
                  >
                    <Paperclip size={20} />
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      onPickFile(e.target.files?.[0] ?? null);
                      e.target.value = '';
                    }}
                  />
                  {text.trim() ? (
                    <button
                      onClick={sendText}
                      className="bg-green-600 text-white rounded-full w-9 h-9 flex items-center justify-center hover:bg-green-700 shrink-0"
                      aria-label="Send"
                    >
                      <Send size={17} />
                    </button>
                  ) : (
                    <VoiceRecorder
                      hidden={!!text.trim() || !!staged}
                      onComplete={(file) => sendFile(file, 'audio')}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-white border-t border-gray-200 p-3 text-center text-xs text-gray-500">
                Only owners and admins can post to the broadcast channel.
              </div>
            )}
          </>
        )}
      </div>

      {/* ── New-chat roster picker ── */}
      {pickerOpen && (
        <RosterPicker
          roster={roster}
          onPick={startDm}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function Bubble({
  m,
  mine,
  showSender,
  senderName,
  nextAudioId,
}: {
  m: ChatMessage;
  mine: boolean;
  showSender: boolean;
  senderName?: string;
  nextAudioId: number | null;
}) {
  const bubble = cn(
    'max-w-[80%] sm:max-w-[75%] rounded-2xl px-3 py-2 text-sm break-words whitespace-pre-wrap',
    mine
      ? 'bg-green-600 text-white rounded-br-sm'
      : 'bg-white border border-gray-200 text-gray-900 rounded-bl-sm',
  );
  const time = (
    <span className={cn('text-[10px] ml-2 align-bottom', mine ? 'text-green-100' : 'text-gray-400')}>
      {fmtTime(m.createdAt)}
    </span>
  );
  return (
    <div className={cn('flex my-0.5', mine ? 'justify-end' : 'justify-start')}>
      <div className={bubble}>
        {showSender && senderName && (
          <div className="text-[11px] font-semibold text-emerald-600 mb-0.5">{senderName}</div>
        )}
        {m.type === 'audio' && m.mediaUrl ? (
          <AudioMessage
            src={mediaUrl(m.mediaUrl) ?? m.mediaUrl}
            out={mine}
            messageId={m.id}
            nextAudioId={nextAudioId}
            trailing={time}
          />
        ) : m.type === 'image' && m.mediaUrl ? (
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mediaUrl(m.mediaUrl) ?? m.mediaUrl}
              alt={m.mediaName ?? 'image'}
              className="rounded-lg max-w-full max-h-80 object-cover"
            />
            <div className="text-right">{time}</div>
          </div>
        ) : m.type === 'file' && m.mediaUrl ? (
          <a
            href={mediaUrl(m.mediaUrl) ?? m.mediaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn('inline-flex items-center gap-2 underline', mine ? 'text-white' : 'text-blue-700')}
          >
            <Paperclip size={14} /> {m.mediaName ?? 'File'}
            {time}
          </a>
        ) : (
          <span>
            {m.content}
            {time}
          </span>
        )}
      </div>
    </div>
  );
}

function RosterPicker({
  roster,
  onPick,
  onClose,
}: {
  roster: RosterUser[];
  onPick: (u: RosterUser) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const filtered = roster.filter((u) =>
    u.name.toLowerCase().includes(q.trim().toLowerCase()),
  );
  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div className="relative bg-white w-full sm:max-w-sm sm:rounded-2xl shadow-xl flex flex-col max-h-full sm:max-h-[80vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">New message</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="p-3 border-b border-gray-100">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search teammates…"
              className="w-full rounded-lg border border-gray-300 py-2 pl-8 pr-3 text-sm"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-400">No teammates found.</p>
          ) : (
            filtered.map((u) => (
              <button
                key={u.id}
                onClick={() => onPick(u)}
                className="w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 flex items-center gap-3"
              >
                <span className="relative w-9 h-9 rounded-full bg-green-600 text-white flex items-center justify-center font-semibold">
                  {(u.name[0] ?? '?').toUpperCase()}
                  {u.online && (
                    <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-green-500 ring-2 ring-white" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block font-medium text-gray-900 truncate">{u.name}</span>
                  <span className="block text-xs text-gray-500 capitalize">
                    {u.role} · {u.online ? 'online' : 'offline'}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
