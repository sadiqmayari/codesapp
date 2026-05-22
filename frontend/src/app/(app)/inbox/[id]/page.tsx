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
  Ban,
  Check,
  CheckCheck,
  CornerUpLeft,
  Eraser,
  FileText,
  MoreVertical,
  Pin,
  PinOff,
  Plus,
  Send,
  StickyNote,
  Tag,
  X,
  Zap,
} from 'lucide-react';
import { apiFetch, ApiError, postMultipart } from '@/lib/api';
import AttachmentPicker, {
  type MediaKind,
} from '@/components/inbox/attachment-picker';
import AttachmentPreview from '@/components/inbox/attachment-preview';
import ReplyQuoteStrip from '@/components/inbox/reply-quote-strip';
import VoiceRecorder from '@/components/inbox/voice-recorder';
import OgPreviewCard from '@/components/inbox/og-preview-card';
import QuickReplyPicker from '@/components/inbox/quick-reply-picker';
import CreateOrderModal from '@/components/inbox/create-order-modal';
import { ShopifyIcon } from '@/components/icons/shopify-icon';
import { ConfirmDialog } from '@/components/ui/modal';
import { autolinkText, extractUrls } from '@/lib/url-detect';
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
import type { TeamMember, CannedReply } from '@/lib/crm-types';

const PAGE = 30;

export default function ThreadPage() {
  const params = useParams();
  const router = useRouter();
  const id = Number(params?.id);
  const { user } = useAuth();
  const { on, emit, status: socketStatus } = useSocket();
  const toast = useToast();

  const canManageAssign =
    user?.role === 'owner' || user?.role === 'admin';
  const [members, setMembers] = useState<TeamMember[]>([]);
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
  const [voiceActive, setVoiceActive] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const composerMenuRef = useRef<HTMLDivElement>(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const [shopifyReady, setShopifyReady] = useState(false);
  // Slash (/) quick-reply autocomplete (WhatsApp-style).
  const [cannedReplies, setCannedReplies] = useState<CannedReply[]>([]);
  const [slashHidden, setSlashHidden] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [clearOpen, setClearOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [viewers, setViewers] = useState<number[]>([]);
  const [typingFrom, setTypingFrom] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  // Auto-focus the composer when a chat opens (like WhatsApp — no extra
  // click needed). Deliberately NOT keyed on the countdown tick.
  useEffect(() => {
    if (!loading) composerRef.current?.focus();
  }, [id, loading]);

  // Focus when a reply context is staged so the agent can type immediately.
  useEffect(() => {
    if (replyTo) composerRef.current?.focus();
  }, [replyTo]);

  // tick for countdown
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Close the mobile action menu on outside click / route change.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  useEffect(() => {
    setMenuOpen(false);
  }, [id]);

  // Close the composer "add" menu (quick reply / template) on outside click.
  useEffect(() => {
    if (!composerMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        composerMenuRef.current &&
        !composerMenuRef.current.contains(e.target as Node)
      ) {
        setComposerMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [composerMenuOpen]);

  // Drop a saved quick-reply body into the composer (append if mid-draft),
  // then focus so the agent can tweak before sending.
  const insertQuickReply = useCallback((body: string) => {
    setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${body}` : body));
    requestAnimationFrame(() => composerRef.current?.focus());
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
    const offStatus = on<{
      messageId: number;
      status: Message['status'];
      error?: string;
    }>('message.status', (p) => {
      setMessages((cur) =>
        cur.map((m) =>
          m.id === p.messageId
            ? { ...m, status: p.status, error: p.error ?? m.error ?? null }
            : m,
        ),
      );
      if (p.status === 'failed' && p.error) {
        toast.error(`Message failed: ${p.error}`);
      }
    });
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
  }, [id, on, scrollToBottom, loadConvo, markRead, toast]);

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

  const sendVoice = useCallback(
    async (file: File) => {
      setSending(true);
      try {
        const fd = new FormData();
        fd.append('file', file, file.name);
        if (replyTo) fd.append('contextMessageId', String(replyTo.id));
        await postMultipart(`/inbox/conversations/${id}/send-media`, fd);
        setReplyTo(null);
        // message.sent socket event appends it
      } catch (e) {
        toast.error(e instanceof ApiError ? e.userMessage : 'Voice send failed');
      } finally {
        setSending(false);
      }
    },
    [id, replyTo, toast],
  );

  const handleVoiceActive = useCallback((a: boolean) => setVoiceActive(a), []);

  useEffect(() => {
    if (!canManageAssign) return;
    apiFetch<TeamMember[]>('/team')
      .then((rows) => setMembers(Array.isArray(rows) ? rows : []))
      .catch(() => setMembers([]));
  }, [canManageAssign]);

  // Only surface "Create Shopify order" when this company has a Shopify
  // Admin token configured. Fetched once (not keyed to the conversation).
  useEffect(() => {
    apiFetch<{ adminTokenSet?: boolean }>('/settings/shopify')
      .then((s) => setShopifyReady(!!s?.adminTokenSet))
      .catch(() => setShopifyReady(false));
  }, []);

  // Saved quick replies — fetched once for the slash-autocomplete; reloaded
  // when the management picker adds/edits/deletes one.
  const loadCanned = useCallback(() => {
    apiFetch<CannedReply[]>('/canned-replies')
      .then((r) => setCannedReplies(Array.isArray(r) ? r : []))
      .catch(() => {
        /* non-critical — slash autocomplete just stays empty */
      });
  }, []);
  useEffect(() => {
    loadCanned();
  }, [loadCanned]);

  const assignTo = async (userId: number | null) => {
    try {
      await apiFetch(`/inbox/conversations/${id}/assign`, {
        method: 'POST',
        body: { userId },
      });
      toast.success(
        userId === null
          ? 'Conversation unassigned'
          : userId === user?.id
            ? 'Assigned to you'
            : 'Conversation assigned',
      );
      loadConvo();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Assign failed');
    }
  };

  const assignToMe = () => {
    if (user) assignTo(user.id);
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

  // Shell-Polish-B: pin / clear / block.
  const togglePin = async () => {
    const pinned = !!convo?.pinned_at;
    try {
      await apiFetch(
        `/inbox/conversations/${id}/${pinned ? 'unpin' : 'pin'}`,
        { method: 'POST' },
      );
      toast.success(pinned ? 'Unpinned' : 'Pinned to top');
      loadConvo();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    }
  };

  const doClear = async () => {
    setActionBusy(true);
    try {
      await apiFetch(`/inbox/conversations/${id}/clear`, { method: 'POST' });
      setClearOpen(false);
      toast.success('Chat cleared from your inbox view');
      loadConvo();
      loadMessages();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setActionBusy(false);
    }
  };

  const toggleBlock = async () => {
    const blocked = convo?.contact?.status === 'blocked';
    setActionBusy(true);
    try {
      await apiFetch(`/contacts/${convo?.contact_id}`, {
        method: 'PATCH',
        body: { status: blocked ? 'active' : 'blocked' },
      });
      setBlockOpen(false);
      toast.success(blocked ? 'Contact unblocked' : 'Contact blocked');
      loadConvo();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setActionBusy(false);
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

  // Slash autocomplete: active only while the composer holds a single
  // `/token` (no space) — typing a space turns it back into a normal message.
  const slashActive =
    /^\/\S*$/.test(text) && !staged && !voiceActive;
  const slashQuery = slashActive ? text.slice(1).toLowerCase() : '';
  const slashMatches = slashActive
    ? cannedReplies
        .filter(
          (r) =>
            r.title.toLowerCase().includes(slashQuery) ||
            r.body.toLowerCase().includes(slashQuery),
        )
        .slice(0, 6)
    : [];
  const showSlash = slashActive && slashMatches.length > 0 && !slashHidden;
  const selectSlash = (r: CannedReply) => {
    setText(r.body);
    setSlashHidden(true);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

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
            'text-xs px-2 py-1 rounded-full shrink-0',
            win.open
              ? 'bg-green-100 text-green-700'
              : 'bg-gray-200 text-gray-600',
          )}
        >
          {win.label}
        </span>
        {/* Desktop: inline action controls (unchanged layout). */}
        <div className="hidden md:flex items-center gap-3 shrink-0">
          {canManageAssign ? (
            <select
              value={convo?.assigned_user?.id ?? ''}
              onChange={(e) =>
                assignTo(e.target.value ? Number(e.target.value) : null)
              }
              className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 max-w-[10rem]"
              title="Assign conversation"
            >
              <option value="">Unassigned</option>
              {members
                .filter(
                  (m) =>
                    m.status === 'active' ||
                    m.id === convo?.assigned_user?.id,
                )
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.id === user?.id ? ' (me)' : ''} · {m.role}
                  </option>
                ))}
            </select>
          ) : (
            <button
              onClick={assignToMe}
              className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50"
            >
              Assign to me
            </button>
          )}
          <button
            onClick={toggleResolve}
            className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50"
          >
            {convo?.status === 'resolved' ? 'Reopen' : 'Resolve'}
          </button>
          <button
            onClick={togglePin}
            className={cn(
              'hover:text-gray-800',
              convo?.pinned_at ? 'text-green-600' : 'text-gray-500',
            )}
            title={convo?.pinned_at ? 'Unpin conversation' : 'Pin to top'}
          >
            {convo?.pinned_at ? <PinOff size={18} /> : <Pin size={18} />}
          </button>
          <button
            onClick={() => setClearOpen(true)}
            className="text-gray-500 hover:text-gray-800"
            title="Clear chat (your inbox view only)"
          >
            <Eraser size={18} />
          </button>
          <button
            onClick={() => setBlockOpen(true)}
            className={cn(
              'hover:text-red-600',
              convo?.contact?.status === 'blocked'
                ? 'text-red-600'
                : 'text-gray-500',
            )}
            title={
              convo?.contact?.status === 'blocked'
                ? 'Unblock contact'
                : 'Block contact'
            }
          >
            <Ban size={18} />
          </button>
          <button
            onClick={() => setNotesOpen(true)}
            className="text-gray-500 hover:text-gray-800"
            title="Internal notes"
          >
            <StickyNote size={18} />
          </button>
        </div>

        {/* Mobile: overflow menu so the header never runs off-screen. */}
        <div className="md:hidden relative shrink-0" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="text-gray-600 p-1"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreVertical size={20} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-30 py-1 text-sm"
            >
              {canManageAssign ? (
                <div className="px-3 py-2 border-b border-gray-100">
                  <label className="block text-[11px] text-gray-400 mb-1">
                    Assign to
                  </label>
                  <select
                    value={convo?.assigned_user?.id ?? ''}
                    onChange={(e) => {
                      assignTo(e.target.value ? Number(e.target.value) : null);
                      setMenuOpen(false);
                    }}
                    className="w-full text-sm px-2 py-1.5 rounded border border-gray-300"
                  >
                    <option value="">Unassigned</option>
                    {members
                      .filter(
                        (m) =>
                          m.status === 'active' ||
                          m.id === convo?.assigned_user?.id,
                      )
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                          {m.id === user?.id ? ' (me)' : ''} · {m.role}
                        </option>
                      ))}
                  </select>
                </div>
              ) : (
                <button
                  role="menuitem"
                  onClick={() => {
                    assignToMe();
                    setMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-gray-50"
                >
                  Assign to me
                </button>
              )}
              <button
                role="menuitem"
                onClick={() => {
                  toggleResolve();
                  setMenuOpen(false);
                }}
                className="w-full text-left px-3 py-2 hover:bg-gray-50"
              >
                {convo?.status === 'resolved' ? 'Reopen' : 'Resolve'}
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  togglePin();
                  setMenuOpen(false);
                }}
                className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2"
              >
                {convo?.pinned_at ? (
                  <PinOff size={15} />
                ) : (
                  <Pin size={15} />
                )}
                {convo?.pinned_at ? 'Unpin conversation' : 'Pin to top'}
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setClearOpen(true);
                  setMenuOpen(false);
                }}
                className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2"
              >
                <Eraser size={15} /> Clear chat
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setBlockOpen(true);
                  setMenuOpen(false);
                }}
                className={cn(
                  'w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2',
                  convo?.contact?.status === 'blocked' && 'text-red-600',
                )}
              >
                <Ban size={15} />
                {convo?.contact?.status === 'blocked'
                  ? 'Unblock contact'
                  : 'Block contact'}
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setNotesOpen(true);
                  setMenuOpen(false);
                }}
                className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2"
              >
                <StickyNote size={15} /> Internal notes
              </button>
            </div>
          )}
        </div>
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
          <div className="relative">
            {showSlash && (
              <div className="absolute left-2 right-2 bottom-full mb-2 max-h-60 overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-lg z-30">
                <div className="px-3 py-1.5 text-[11px] font-medium text-gray-400 border-b border-gray-100 flex items-center gap-1">
                  <Zap size={12} className="text-green-600" /> Quick replies — ↑↓
                  to choose, Enter to insert
                </div>
                {slashMatches.map((r, i) => (
                  <button
                    key={r.id}
                    type="button"
                    onMouseEnter={() => setSlashIdx(i)}
                    onClick={() => selectSlash(r)}
                    className={cn(
                      'w-full text-left px-3 py-2 flex flex-col gap-0.5',
                      i === slashIdx ? 'bg-green-50' : 'hover:bg-gray-50',
                    )}
                  >
                    <span className="text-sm font-medium text-gray-900 truncate">
                      {r.title}
                    </span>
                    <span className="text-xs text-gray-500 truncate">
                      {r.body}
                    </span>
                  </button>
                ))}
              </div>
            )}
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
                {!voiceActive && (
                  <AttachmentPicker
                    onPick={(p) => {
                      setStaged(p);
                      setCaption('');
                    }}
                  />
                )}
                <VoiceRecorder
                  onComplete={sendVoice}
                  onActiveChange={handleVoiceActive}
                />
                {!voiceActive && (
                  <>
                    <textarea
                      ref={composerRef}
                      value={text}
                      onChange={(e) => {
                        setText(e.target.value);
                        setSlashHidden(false);
                        setSlashIdx(0);
                        emit('typing.start', { conversationId: id });
                      }}
                      onBlur={() => emit('typing.stop', { conversationId: id })}
                      onKeyDown={(e) => {
                        if (showSlash) {
                          if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            setSlashIdx((i) =>
                              Math.min(i + 1, slashMatches.length - 1),
                            );
                            return;
                          }
                          if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            setSlashIdx((i) => Math.max(i - 1, 0));
                            return;
                          }
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            selectSlash(slashMatches[slashIdx] ?? slashMatches[0]);
                            return;
                          }
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            setSlashHidden(true);
                            return;
                          }
                        }
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          sendText();
                        }
                      }}
                      rows={1}
                      placeholder="Type a message"
                      className="flex-1 min-w-0 resize-none border border-gray-300 rounded-lg px-3 py-2 text-sm max-h-32 focus:outline-none focus:ring-2 focus:ring-green-500"
                    />
                    <div className="relative" ref={composerMenuRef}>
                      <button
                        onClick={() => setComposerMenuOpen((o) => !o)}
                        title="Quick reply or template"
                        aria-haspopup="menu"
                        aria-expanded={composerMenuOpen}
                        className="p-2 text-gray-500 hover:text-gray-800"
                      >
                        <Plus size={20} />
                      </button>
                      {composerMenuOpen && (
                        <div
                          role="menu"
                          className="absolute right-0 bottom-full mb-2 w-52 bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-sm z-30"
                        >
                          <button
                            role="menuitem"
                            onClick={() => {
                              setQuickOpen(true);
                              setComposerMenuOpen(false);
                            }}
                            className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2"
                          >
                            <Zap size={16} className="text-green-600" />
                            Quick reply
                          </button>
                          <button
                            role="menuitem"
                            onClick={() => {
                              setTplOpen(true);
                              setComposerMenuOpen(false);
                            }}
                            className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2"
                          >
                            <FileText size={16} className="text-gray-500" />
                            Send template
                          </button>
                          {shopifyReady && (
                            <button
                              role="menuitem"
                              onClick={() => {
                                setOrderOpen(true);
                                setComposerMenuOpen(false);
                              }}
                              className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2"
                            >
                              <ShopifyIcon size={16} />
                              Create Shopify order
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={sendText}
                      disabled={sending || !text.trim()}
                      className="bg-green-600 hover:bg-green-700 text-white p-2.5 rounded-lg disabled:opacity-40"
                    >
                      <Send size={18} />
                    </button>
                  </>
                )}
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
      <ConfirmDialog
        open={clearOpen}
        title="Clear chat"
        message="This removes the message history from your inbox view only. The customer still sees the conversation on WhatsApp, and new incoming messages will still appear here."
        confirmLabel="Clear chat"
        danger
        busy={actionBusy}
        onConfirm={doClear}
        onCancel={() => setClearOpen(false)}
      />
      <ConfirmDialog
        open={blockOpen}
        title={
          convo?.contact?.status === 'blocked'
            ? 'Unblock contact'
            : 'Block contact'
        }
        message={
          convo?.contact?.status === 'blocked'
            ? 'Unblock this contact? They will be marked active again.'
            : 'Block this contact? They will be marked blocked in your contacts. Inbound WhatsApp messages still arrive (WhatsApp has no server-side block) — this flags the contact for your team.'
        }
        confirmLabel={
          convo?.contact?.status === 'blocked' ? 'Unblock' : 'Block'
        }
        danger={convo?.contact?.status !== 'blocked'}
        busy={actionBusy}
        onConfirm={toggleBlock}
        onCancel={() => setBlockOpen(false)}
      />
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
      {quickOpen && (
        <QuickReplyPicker
          onInsert={insertQuickReply}
          onChanged={loadCanned}
          onClose={() => setQuickOpen(false)}
        />
      )}
      {orderOpen && (
        <CreateOrderModal
          contactName={convo?.contact?.name}
          contactPhone={convo?.contact?.phone}
          contactEmail={convo?.contact?.email}
          assignedAgentName={convo?.assigned_user?.name}
          onClose={() => setOrderOpen(false)}
        />
      )}
    </div>
  );
}

// Shell-Polish-C: autolink uses the shared extractUrls/autolinkText matcher
// (single source of truth — same regex feeds the OG preview cards).
function Linkify({ text, out }: { text: string; out: boolean }) {
  return (
    <>
      {autolinkText(text).map((seg, i) =>
        seg.kind === 'url' ? (
          <a
            key={i}
            href={seg.value}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'underline break-all',
              out ? 'text-white' : 'text-green-700',
            )}
          >
            {seg.value}
          </a>
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </>
  );
}

function Ticks({ m }: { m: Message }) {
  if (m.direction !== 'outbound') return null;
  if (m.status === 'failed')
    return (
      <span
        className="text-red-500 text-[11px] cursor-help"
        title={m.error || 'Delivery failed'}
      >
        failed{m.error ? ' ⓘ' : ''}
      </span>
    );
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

// The backend renders template buttons as a trailing literal line
// "[ Confirm ]  [ Cancel ]" (renderTemplateText). Split that last block
// back out so the bubble can show real button chips instead of raw text.
function splitTemplateButtons(content: string): {
  text: string;
  buttons: string[];
} {
  const blocks = content.split('\n\n');
  const last = blocks[blocks.length - 1]?.trim() ?? '';
  const parts = last.split(/\s{2,}/);
  const isButtons =
    parts.length > 0 && parts.every((p) => /^\[ .+ \]$/.test(p));
  if (!isButtons) return { text: content, buttons: [] };
  return {
    text: blocks.slice(0, -1).join('\n\n').trimEnd(),
    buttons: parts.map((p) => p.replace(/^\[ /, '').replace(/ \]$/, '')),
  };
}

// WhatsApp-style in-app image viewer: full-screen overlay, X to close,
// click backdrop or Esc to dismiss. Stays inside the app (no new tab).
function ImageLightbox({
  src,
  onClose,
}: {
  src: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/80 hover:text-white"
        aria-label="Close image"
      >
        <X size={28} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="attachment"
        className="max-w-full max-h-full object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
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
  const [zoom, setZoom] = useState(false);
  const isMedia = ['image', 'audio', 'video', 'document'].includes(
    m.message_type,
  );

  // Mobile swipe-to-reply (WhatsApp gesture). Swipe a bubble to the right;
  // past the threshold it triggers reply. Touch-only, so desktop (hover
  // reply icon) is unaffected. Horizontal-dominant detection so it doesn't
  // hijack vertical list scrolling.
  const startX = useRef(0);
  const startY = useRef(0);
  const swiping = useRef(false);
  const [dx, setDx] = useState(0);
  const SWIPE_TRIGGER = 56;

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    startX.current = t.clientX;
    startY.current = t.clientY;
    swiping.current = false;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const ddx = t.clientX - startX.current;
    const ddy = t.clientY - startY.current;
    if (!swiping.current) {
      if (Math.abs(ddx) > 10 && Math.abs(ddx) > Math.abs(ddy)) {
        swiping.current = true;
      } else {
        return;
      }
    }
    setDx(ddx > 0 ? Math.min(ddx, 80) : 0);
  };
  const onTouchEnd = () => {
    if (dx >= SWIPE_TRIGGER) onReply();
    setDx(0);
    swiping.current = false;
  };

  return (
    <div
      id={`msg-${m.id}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      className={cn(
        'group relative flex mb-1.5 items-center gap-1.5 rounded-lg transition-shadow',
        out ? 'justify-end' : 'justify-start',
      )}
    >
      <span
        className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 text-green-600"
        style={{ opacity: Math.min(dx / SWIPE_TRIGGER, 1) }}
        aria-hidden
      >
        <CornerUpLeft size={18} />
      </span>
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
        style={{
          transform: dx ? `translateX(${dx}px)` : undefined,
          transition: dx ? 'none' : 'transform .15s ease-out',
        }}
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
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt="attachment"
                  onClick={() => setZoom(true)}
                  className="rounded-lg max-w-full max-h-72 cursor-zoom-in"
                />
                {zoom && (
                  <ImageLightbox src={url} onClose={() => setZoom(false)} />
                )}
              </>
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
        {(() => {
          const { text, buttons } =
            m.message_type === 'template' && m.content
              ? splitTemplateButtons(m.content)
              : { text: m.content ?? '', buttons: [] };
          return (
            <>
              {text && (
                <p className="whitespace-pre-wrap break-words">
                  <Linkify text={text} out={out} />
                </p>
              )}
              {buttons.length > 0 && (
                <div
                  className={cn(
                    'mt-2 pt-2 flex flex-col gap-1 border-t',
                    out ? 'border-green-500/40' : 'border-gray-200',
                  )}
                >
                  {buttons.map((b, bi) => (
                    <span
                      key={bi}
                      className={cn(
                        'text-center text-sm font-medium rounded-md py-1.5 px-3',
                        out
                          ? 'bg-green-700/40 text-white'
                          : 'bg-gray-50 text-green-700',
                      )}
                    >
                      {b}
                    </span>
                  ))}
                </div>
              )}
            </>
          );
        })()}
        {m.message_type === 'text' &&
          m.direction === 'inbound' &&
          m.content &&
          extractUrls(m.content).map((u) => (
            <OgPreviewCard key={u} url={u} />
          ))}
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
