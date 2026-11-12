'use client';

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertCircle,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  Clock,
  ChevronUp,
  Copy,
  CornerUpLeft,
  Download,
  FileText,
  Info,
  LifeBuoy,
  LayoutTemplate,
  Loader2,
  MapPin,
  RotateCcw,
  Search,
  Send,
  Smile,
  Trash2,
  Undo2,
  UserRound,
  X,
  Zap,
  PhoneMissed,
  PhoneIncoming,
  PhoneOutgoing,
} from 'lucide-react';
import ThreadHeader from '@/components/inbox/thread-header';
import ImageGallery, { type GalleryImage } from '@/components/inbox/image-gallery';
import { clearDraft, getDraft, setDraft } from '@/lib/draft-store';
import { apiFetch, ApiError, postMultipart } from '@/lib/api';
import AttachmentPicker, {
  validateFile,
  type MediaKind,
} from '@/components/inbox/attachment-picker';
import AttachmentPreview from '@/components/inbox/attachment-preview';
import AudioMessage from '@/components/inbox/audio-message';
import AiAuditModal from '@/components/inbox/ai-audit-modal';
import EmojiPicker from '@/components/inbox/emoji-picker';
import ReplyQuoteStrip from '@/components/inbox/reply-quote-strip';
import VoiceRecorder from '@/components/inbox/voice-recorder';
import OgPreviewCard from '@/components/inbox/og-preview-card';
import QuickReplyPicker from '@/components/inbox/quick-reply-picker';
import CreateOrderModal from '@/components/inbox/create-order-modal';
import { ShopifyIcon } from '@/components/icons/shopify-icon';
import TrackOrderModal from '@/components/inbox/track-order-modal';
import CameraCapture from '@/components/inbox/camera-capture';
import CatalogPicker, {
  type CatalogProduct,
} from '@/components/inbox/catalog-picker';
import AdReferralCard from '@/components/inbox/ad-referral-card';
import AiCopilot from '@/components/inbox/ai-copilot';
import { aiSetConversationAutoReply } from '@/lib/ai';
import {
  getShopifyCustomerTags,
  setShopifyCustomerTags as apiSetShopifyCustomerTags,
} from '@/lib/orders';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { autolinkText, extractUrls } from '@/lib/url-detect';
import { downscaleImageForSend } from '@/lib/image-utils';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { useSip } from '@/context/sip-context';
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
import { cacheThread, getThread } from '@/lib/thread-cache';
import type { TeamMember, CannedReply } from '@/lib/crm-types';
import { TicketDetailModal } from '@/components/tickets/ticket-detail-modal';
import {
  ContactInfoPanel,
  ContactOrderChip,
} from '@/components/inbox/contact-panel';
import OrderTrackingModal from '@/components/inbox/order-tracking-modal';
import {
  getContactOrders,
  isOrderTrackable,
  orderDisplayStatus,
  orderStatusTone,
  type ContactOrder,
  type ContactOrders,
} from '@/lib/contact-orders';
import {
  createTicket,
  getOpenTicketForConversation,
  ticketStatusColor,
  ticketStatusLabel,
  ticketTypeLabel,
  TICKET_TYPES,
  type TicketListItem,
} from '@/lib/tickets';

const PAGE = 30;

// Optimistic message ids: negative + unique even for two sends in the same ms
// (`-Date.now()` collided → duplicate `msg-<id>` DOM ids).
let tempSeq = 0;
function tempId(): number {
  tempSeq = (tempSeq + 1) % 1000;
  return -(Date.now() * 1000 + tempSeq);
}
// A temp still `sending` after this long never got its confirmation (lost
// response, chat switched mid-send) — surface it as failed with Retry instead
// of a clock that spins forever.
const STALE_SEND_MS = 60_000;
type StagedFile = { file: File; kind: MediaKind };

// A WhatsApp call-log entry (call_logs row) rendered as a centered pill in the
// thread timeline — a record of every placed/received call.
type CallRow = {
  id: number;
  conversation_id: number | null;
  direction: 'inbound' | 'outbound';
  status: 'ringing' | 'answered' | 'missed' | 'failed' | 'completed';
  duration_sec: number | null;
  started_at: string | null;
  created_at: string;
};

type TimelineItem =
  | { kind: 'msg'; t: number; msg: Message }
  | { kind: 'call'; t: number; call: CallRow };

/** WhatsApp-style call-record card in the thread timeline. */
function CallPill({ c, onCallBack }: { c: CallRow; onCallBack?: () => void }) {
  const inbound = c.direction === 'inbound';
  const missed = c.status === 'missed' || c.status === 'failed';
  const Icon = missed ? PhoneMissed : inbound ? PhoneIncoming : PhoneOutgoing;
  const dur =
    c.duration_sec && c.duration_sec > 0
      ? `${Math.floor(c.duration_sec / 60)}:${String(c.duration_sec % 60).padStart(2, '0')}`
      : null;
  const title = missed
    ? inbound
      ? 'Missed voice call'
      : 'Call not answered'
    : 'Voice call';
  const sub = `${inbound ? 'Incoming' : 'Outgoing'}${dur ? ` · ${dur}` : ''}`;
  return (
    <div className="flex justify-center my-2">
      <div className="flex items-center gap-3 rounded-xl bg-white px-3 py-2 shadow-sm max-w-[85%]">
        <span
          className={`flex h-9 w-9 flex-none items-center justify-center rounded-full ${
            missed ? 'bg-red-50' : 'bg-green-50'
          }`}
        >
          <Icon size={18} className={missed ? 'text-red-500' : 'text-green-600'} />
        </span>
        <div className="min-w-0">
          <div
            className={`text-sm font-medium ${missed ? 'text-red-500' : 'text-gray-800'}`}
          >
            {title}
          </div>
          <div className="text-xs text-gray-500">
            {sub} · {fmtTime(c.started_at || c.created_at)}
          </div>
        </div>
        {missed && onCallBack && (
          <button
            onClick={onCallBack}
            className="ml-1 flex-none rounded-full bg-green-50 px-3 py-1.5 text-xs font-semibold text-green-600 hover:bg-green-100"
          >
            Call back
          </button>
        )}
      </div>
    </div>
  );
}

export default function ThreadPage() {
  const params = useParams();
  const router = useRouter();
  const id = Number(params?.id);
  const { user } = useAuth();
  const { on, emit, status: socketStatus, reconnectSeq } = useSocket();
  const sip = useSip();
  const toast = useToast();

  const canManageAssign =
    user?.role === 'owner' || user?.role === 'admin';
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [convo, setConvo] = useState<ConversationDetail | null>(null);
  // Contact info panel (WhatsApp-style right drawer) + this contact's orders.
  // Inbox-v2: on desktop the drawer REMEMBERS being open across chats (it used
  // to close on every switch, because the page remounts per chat).
  const [panelOpen, setPanelOpenState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return (
        window.matchMedia?.('(min-width: 1024px)').matches === true &&
        window.localStorage.getItem('ca_contact_panel_open') === '1'
      );
    } catch {
      return false;
    }
  });
  const setPanelOpen = useCallback((v: boolean | ((o: boolean) => boolean)) => {
    setPanelOpenState((cur) => {
      const next = typeof v === 'function' ? v(cur) : v;
      try {
        if (window.matchMedia?.('(min-width: 1024px)').matches) {
          window.localStorage.setItem('ca_contact_panel_open', next ? '1' : '0');
        }
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);
  const [panelTab, setPanelTab] = useState<'overview' | 'orders' | 'notes' | 'media'>('overview');
  // Bumped by the mobile kebab to open the (desktop-only) ticket control.
  const [ticketOpenSignal, setTicketOpenSignal] = useState(0);
  // Order whose courier tracking timeline is open (from the chip / panel).
  const [trackOrder, setTrackOrder] = useState<ContactOrder | null>(null);
  const [contactOrders, setContactOrders] = useState<ContactOrders | null>(null);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Whether the view is pinned to the latest message. When the user has scrolled
  // up to read history, new incoming messages must NOT yank them down — we count
  // them and show a "↓ N new messages" pill instead.
  const atBottomRef = useRef(true);
  const [newCount, setNewCount] = useState(0);
  // Whether to show the floating "jump to latest" button (any time the view is
  // scrolled up off the bottom — WhatsApp-style), independent of new-message
  // count. The green count badge overlays it when newCount > 0.
  const [showJump, setShowJump] = useState(false);
  // Pin to the latest message synchronously on the FIRST paint of a conversation
  // (before the browser shows the top), so opening a chat never flashes at the
  // top and then jumps down.
  const firstPinRef = useRef(false);
  // Drafts survive chat switches (Inbox-v2): restored from the per-chat store.
  const [text, setText] = useState<string>(() => getDraft(id)?.text ?? '');
  const [replyTo, setReplyTo] = useState<Message | null>(
    () => (getDraft(id)?.replyTo as Message | null | undefined) ?? null,
  );
  const [draftRestored, setDraftRestored] = useState<boolean>(
    () => !!getDraft(id)?.text?.trim(),
  );
  // "Undo" for an AI suggestion / quick reply that replaced the draft.
  const [undo, setUndo] = useState<{ text: string; label: string } | null>(null);
  // First unread message on open ("N unread messages" divider).
  const [unreadDivider, setUnreadDivider] = useState<{ id: number; count: number } | null>(null);
  const [galleryStart, setGalleryStart] = useState<number | null>(null);
  const [assignSignal, setAssignSignal] = useState(0);

  // Load this contact's Shopify orders (local mirror) for the header chip +
  // info panel whenever the conversation's phone changes.
  const contactPhone = convo?.contact?.phone ?? null;
  // ordersError: a failed load is shown as an error with Retry — it used to
  // look like "No orders found". ordersNonce re-runs the fetch (Retry, after
  // creating an order, "No response", or an `orders.changed` event).
  const [ordersError, setOrdersError] = useState(false);
  const [ordersNonce, setOrdersNonce] = useState(0);
  const refreshOrders = useCallback(() => setOrdersNonce((n) => n + 1), []);
  const ordersPhoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!contactPhone) {
      setContactOrders(null);
      return;
    }
    let alive = true;
    // A different contact → drop the previous one's orders immediately so the
    // stats never show the wrong customer's numbers while loading.
    if (ordersPhoneRef.current !== contactPhone) setContactOrders(null);
    ordersPhoneRef.current = contactPhone;
    setOrdersLoading(true);
    setOrdersError(false);
    getContactOrders(contactPhone)
      .then((r) => {
        if (alive) setContactOrders(r);
      })
      .catch(() => {
        if (alive) setOrdersError(true);
      })
      .finally(() => {
        if (alive) setOrdersLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [contactPhone, ordersNonce]);
  const [staged, setStaged] = useState<StagedFile | null>(
    () => (getDraft<StagedFile>(id)?.staged as StagedFile | null | undefined) ?? null,
  );
  const [voiceActive, setVoiceActive] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const [tplOpen, setTplOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [trackOrderOpen, setTrackOrderOpen] = useState(false);
  const [shopifyReady, setShopifyReady] = useState(false);
  // Shopify customer tags for this contact — merged into the drawer's tag editor
  // (2-way sync: edits here push back to the Shopify customer via the contacts API).
  const [shopifyCustomerTags, setShopifyCustomerTags] = useState<string[]>([]);
  const [aiEnabled, setAiEnabled] = useState(false);
  // Workspace "answer all chats" setting — when on, the per-chat auto-pilot
  // toggle is disabled (the AI already answers every chat).
  const [allChatsOn, setAllChatsOn] = useState(false);
  // Slash (/) quick-reply autocomplete (WhatsApp-style).
  const [cannedReplies, setCannedReplies] = useState<CannedReply[]>([]);
  const [slashHidden, setSlashHidden] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [clearOpen, setClearOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  // True only while a picked catalog product's (already resized) image is being
  // fetched + staged. Shows a small non-blocking indicator; never blocks the
  // inbox or chat switching (the fetch is async and small).
  const [catalogPreparing, setCatalogPreparing] = useState(false);
  // In-chat search (client-side over loaded messages for now).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchPos, setSearchPos] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [viewers, setViewers] = useState<{ id: number; name: string | null }[]>(
    [],
  );
  const [typingFrom, setTypingFrom] = useState<{
    id: number;
    name: string | null;
  } | null>(null);
  const [now, setNow] = useState(Date.now());

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const nextCursorRef = useRef<number | null>(null);
  nextCursorRef.current = nextCursor;
  const loadingOlderRef = useRef(false);
  // Older-page scroll restore (applied in a layout effect, before paint).
  const restoreRef = useRef<{ h: number; top: number } | null>(null);
  // A read we deferred because the tab was hidden / the agent was scrolled up.
  const pendingReadRef = useRef(false);
  const lastTypingRef = useRef(0);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist the composer draft per chat (text + reply-to in sessionStorage,
  // the staged File in memory) — cleared automatically when emptied.
  useEffect(() => {
    if (!Number.isFinite(id)) return;
    setDraft<StagedFile>(id, { text, replyTo, staged });
  }, [id, text, replyTo, staged]);

  // Auto-dismiss the undo chip.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(t);
  }, [undo]);

  /** Replace the draft with generated/inserted text, keeping an Undo. */
  const replaceDraft = useCallback((next: string, label: string) => {
    setText((cur) => {
      if (cur.trim() && cur !== next) setUndo({ text: cur, label });
      return next;
    });
    setDraftRestored(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  // Auto-focus the composer when a chat opens — but ONLY on devices with a
  // fine pointer (desktop mouse). On touch devices, auto-focusing pops the
  // on-screen keyboard the instant a chat opens, which is jarring; there the
  // agent taps the field when they actually want to type. Deliberately NOT
  // keyed on the countdown tick.
  useEffect(() => {
    if (loading) return;
    const finePointer =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(pointer: fine)').matches;
    if (finePointer) composerRef.current?.focus();
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


  // Drop a saved quick-reply body into the composer (append if mid-draft),
  // then focus so the agent can tweak before sending.
  const insertQuickReply = useCallback((body: string) => {
    setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${body}` : body));
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const jump = () => {
      const el = scrollRef.current;
      if (el)
        el.scrollTo({
          top: el.scrollHeight,
          behavior: smooth ? 'smooth' : 'auto',
        });
    };
    atBottomRef.current = true;
    setNewCount(0);
    setShowJump(false);
    requestAnimationFrame(jump);
    // Re-pin after late layout (images / voice notes / OG cards finish loading
    // AFTER the first frame, which is what made the thread sometimes open partway
    // up instead of at the latest message).
    setTimeout(jump, 250);
  }, []);

  // First-paint pin: when a conversation's messages first render, jump to the
  // latest message SYNCHRONOUSLY before the browser paints (useLayoutEffect), so
  // the thread never flashes at the top and then animates/jumps down. Runs once
  // per conversation; live appends afterwards use the scroll logic above.
  useLayoutEffect(() => {
    if (loading || firstPinRef.current || messages.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight; // synchronous, pre-paint
    atBottomRef.current = true;
    setShowJump(false);
    firstPinRef.current = true;
    // Re-pin after late media (images / voice notes / OG cards) settle.
    const t = setTimeout(() => {
      const e = scrollRef.current;
      if (e && atBottomRef.current) e.scrollTop = e.scrollHeight;
    }, 250);
    return () => clearTimeout(t);
  }, [loading, messages]);

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

  const loadMessages = useCallback(
    async (opts?: { silent?: boolean }): Promise<Message[] | null> => {
      const silent = opts?.silent === true;
      if (!silent) setLoading(true);
      try {
        const res = await apiFetch<{
          rows: Message[];
          nextCursor: number | null;
        }>(`/inbox/conversations/${id}/messages`, { params: { limit: PAGE } });
        const fetched = [...res.rows].reverse();
        if (silent) {
          // Background revalidation: merge by id so older pages the user already
          // scrolled in + any in-flight optimistic temps aren't clobbered.
          setMessages((cur) => {
            // Drop optimistic temps (negative id) the server now has, matched by
            // client_id (echoed on the fetched rows). Without this, the temp
            // (neg id) and the real row (pos id) both survive the id-keyed merge
            // → the "sent twice until refresh" duplicate. An in-flight temp whose
            // real row hasn't been persisted yet has no match here → it's kept.
            const serverClientIds = new Set(
              fetched.map((m) => m.client_id).filter(Boolean) as string[],
            );
            const kept = cur.filter(
              (m) =>
                !(m.id < 0 && m.client_id && serverClientIds.has(m.client_id)),
            );
            const byId = new Map<number, Message>(kept.map((m) => [m.id, m]));
            for (const m of fetched) byId.set(m.id, { ...byId.get(m.id), ...m });
            return expireStaleTemps(
              Array.from(byId.values()).sort(
                (a, b) =>
                  new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
              ),
            );
          });
          // Only advance the cursor if we don't already have older history loaded.
          setNextCursor((cur) => cur ?? res.nextCursor);
        } else {
          setMessages(fetched);
          setNextCursor(res.nextCursor);
          scrollToBottom();
        }
        return fetched;
      } catch (e) {
        if (!silent)
          toast.error(
            e instanceof ApiError ? e.userMessage : 'Failed to load messages',
          );
        return null;
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [id, scrollToBottom, toast],
  );

  // Background sweep: optimistic sends that never confirmed → failed (Retry).
  useEffect(() => {
    const t = setInterval(() => {
      const cur = messagesRef.current;
      if (cur.some(isStaleTemp)) setMessages((m) => expireStaleTemps(m));
    }, 15_000);
    return () => clearInterval(t);
  }, []);

  // Mark read only while the agent can actually see the latest messages —
  // a hidden tab or a scrolled-up view defers it (unread counts used to drop
  // for messages nobody had looked at).
  const markReadIfVisible = useCallback(() => {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible' &&
      atBottomRef.current
    ) {
      pendingReadRef.current = false;
      void markReadRef.current();
    } else {
      pendingReadRef.current = true;
    }
  }, []);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && pendingReadRef.current && atBottomRef.current) {
        pendingReadRef.current = false;
        void markReadRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  /** "N unread messages" divider from the first inbound message nobody read. */
  const computeDivider = useCallback((rows: Message[] | null) => {
    if (!rows) return;
    const idx = rows.findIndex((m) => m.direction === 'inbound' && !m.read_at);
    if (idx === -1) return;
    const count = rows.slice(idx).filter((m) => m.direction === 'inbound').length;
    // A single fresh message right at the bottom doesn't need a divider.
    if (count >= 2 || idx < rows.length - 1) {
      setUnreadDivider({ id: rows[idx].id, count });
    }
  }, []);

  // WhatsApp call records for this conversation (placed + received).
  const loadCalls = useCallback(async () => {
    try {
      const rows = await apiFetch<CallRow[]>(`/calls/conversation/${id}`);
      if (Array.isArray(rows)) setCalls(rows);
    } catch {
      /* calls are best-effort — never block the thread */
    }
  }, [id]);

  const markRead = useCallback(async () => {
    try {
      await apiFetch(`/inbox/conversations/${id}/mark-read`, {
        method: 'POST',
      });
    } catch {
      /* non-critical */
    }
  }, [id]);
  const convoContactRef = useRef<number | null>(null);
  convoContactRef.current = convo?.contact_id ?? null;
  const markReadRef = useRef(markRead);
  markReadRef.current = markRead;

  useEffect(() => {
    if (!Number.isFinite(id)) return;
    firstPinRef.current = false; // re-pin to latest for the newly opened chat
    // The list clears this chat's unread badge optimistically on open; the
    // server-side mark-read now runs right AFTER the first message load so the
    // "N unread messages" divider can be computed from what was unread.
    setCalls([]);
    loadCalls();
    const cached = getThread(id);
    if (cached) {
      // Instant render from cache, then revalidate silently (no spinner, no
      // blank, no stale-other-chat flash).
      setConvo(cached.convo);
      setMessages(cached.messages);
      setNextCursor(cached.nextCursor);
      setLoading(false);
      scrollToBottom();
      loadConvo();
      computeDivider(cached.messages);
      void loadMessages({ silent: true }).then(() => markRead());
    } else {
      // Cold open: clear the PREVIOUS chat's content immediately so it never
      // shows under the new chat's header while loading.
      setConvo(null);
      setMessages([]);
      setNextCursor(null);
      setLoading(true);
      loadConvo();
      void loadMessages().then((rows) => {
        computeDivider(rows);
        void markRead();
      });
    }
    // Keyed on id only — the load callbacks are stable per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Keep the per-conversation cache warm with the latest in-memory state
  // (socket updates, reactions, optimistic sends, scrolled-in history) so the
  // next time this chat is opened it renders instantly.
  useEffect(() => {
    if (!Number.isFinite(id)) return;
    if (loading) return; // don't cache a half-loaded state
    cacheThread(id, { convo, messages, nextCursor });
  }, [id, convo, messages, nextCursor, loading]);

  // Collision detection + typing.
  useEffect(() => {
    if (!Number.isFinite(id)) return;
    emit('agent.viewing', { conversationId: id });

    const offViewing = on<{
      conversationId: number;
      userId: number;
      userName?: string | null;
    }>('agent.viewing', (p) => {
      if (p.conversationId === id && p.userId !== user?.id) {
        setViewers((v) =>
          v.some((u) => u.id === p.userId)
            ? v
            : [...v, { id: p.userId, name: p.userName ?? null }],
        );
      }
    });
    const offLeft = on<{ conversationId: number; userId: number }>(
      'agent.left',
      (p) => {
        if (p.conversationId === id)
          setViewers((v) => v.filter((u) => u.id !== p.userId));
      },
    );
    const offTypingStart = on<{
      conversationId: number;
      userId: number;
      userName?: string | null;
    }>('typing.start', (p) => {
      if (p.conversationId === id && p.userId !== user?.id) {
        setTypingFrom({ id: p.userId, name: p.userName ?? null });
        // A teammate who closes the tab mid-typing never sends typing.stop.
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => setTypingFrom(null), 6000);
      }
    });
    const offTypingStop = on<{ conversationId: number }>(
      'typing.stop',
      (p) => {
        if (p.conversationId === id) setTypingFrom(null);
      },
    );

    return () => {
      // Leaving the chat while focused in the composer never fired blur →
      // other agents saw "typing…" forever.
      emit('typing.stop', { conversationId: id });
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
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
      setMessages((cur) => {
        if (cur.some((x) => x.id === m.id)) return cur;
        // Replace a matching optimistic temp (same outbound message not yet
        // confirmed) so the instant bubble becomes the real one — no duplicate.
        // Carry the temp's client_id onto the confirmed message so the React key
        // stays stable (no remount → no media reload/flicker), matching the
        // POST-response reconcile path.
        let base = cur;
        let confirmed = m;
        if (m.direction === 'outbound') {
          // Reconcile by client_id (now echoed by the backend) — reliable even
          // for captionless images/catalogue where content is null. Fall back to
          // the old type+content match only when the real message somehow lacks a
          // client_id (e.g. a message from another agent has none → nothing to
          // match, so it just appends).
          const idx = m.client_id
            ? base.findIndex(
                (x) => x.client_id === m.client_id && x.status === 'sending',
              )
            : base.findIndex(
                (x) =>
                  x.client_id &&
                  x.status === 'sending' &&
                  x.message_type === m.message_type &&
                  x.content === m.content,
              );
          if (idx !== -1) {
            confirmed = { ...m, client_id: base[idx].client_id ?? m.client_id };
            base = base.filter((_, i) => i !== idx);
          }
        }
        return [...base, confirmed];
      });
      // Only auto-scroll if the user is already at the bottom, or it's our own
      // outbound message. Otherwise keep their scroll position and bump the
      // "new messages" pill so reading history isn't interrupted.
      if (atBottomRef.current || m.direction === 'outbound') {
        scrollToBottom(true);
      } else {
        setNewCount((n) => n + 1);
      }
    };
    const offRecv = on<{
      message: Message;
      conversationId: number;
      windowExpiresAt?: string;
      status?: ConversationDetail['status'];
    }>('message.received', (p) => {
      if (p.conversationId === id || p.message?.conversation_id === id) {
        appendIfActive(p.message);
        // The customer wrote → the 24h window reopens NOW (the composer used
        // to stay template-only until a reload) and a resolved chat reopens.
        setConvo((c) =>
          c
            ? {
                ...c,
                window_expires_at:
                  p.windowExpiresAt ??
                  new Date(Date.now() + 24 * 3_600_000).toISOString(),
                status: p.status ?? (c.status === 'resolved' ? 'open' : c.status),
              }
            : c,
        );
        const seen =
          document.visibilityState === 'visible' && atBottomRef.current;
        if (!seen && p.message?.id) {
          setUnreadDivider((d) =>
            d ? { ...d, count: d.count + 1 } : { id: p.message.id, count: 1 },
          );
        }
        markReadIfVisible();
      }
    });
    const offSent = on<{ message: Message }>('message.sent', (p) =>
      appendIfActive(p.message),
    );
    const offStatus = on<{
      messageId: number;
      conversationId?: number;
      status: Message['status'];
      error?: string;
    }>('message.status', (p) => {
      // message.status goes to the whole company — only react to OUR chat's
      // messages (every agent used to get toasts for everyone's failures).
      const mine =
        p.conversationId === id ||
        messagesRef.current.some((m) => m.id === p.messageId);
      if (!mine) return;
      setMessages((cur) =>
        cur.map((m) =>
          m.id === p.messageId
            ? {
                ...m,
                status: p.status,
                error: p.error ?? m.error ?? null,
                error_reason: p.error ?? m.error_reason ?? null,
              }
            : m,
        ),
      );
      if (p.status === 'failed') {
        toast.error('A message wasn’t delivered — see the reason under it');
      }
    });
    const offReaction = on<{
      conversationId: number;
      messageId: number;
      emoji?: string | null;
      agentEmoji?: string | null;
    }>('message.reaction', (p) => {
      if (p.conversationId !== id) return;
      setMessages((cur) =>
        cur.map((m) =>
          m.id !== p.messageId
            ? m
            : 'agentEmoji' in p
              ? { ...m, agent_reaction: p.agentEmoji ?? null }
              : { ...m, reaction: p.emoji ?? null },
        ),
      );
    });
    const offRemoved = on<{ conversationId: number; messageId: number }>(
      'message.removed',
      (p) => {
        if (p.conversationId !== id) return;
        setMessages((cur) => cur.filter((m) => m.id !== p.messageId));
      },
    );
    const offOrders = on('orders.changed', () => refreshOrders());
    // A teammate renamed / re-tagged / blocked this contact.
    const offContact = on<{ contactId: number }>('contact.updated', (p) => {
      if (p.contactId === convoContactRef.current) loadConvo();
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
    const offCall = on<{ conversationId: number | null }>(
      'call.updated',
      (p) => {
        if (p.conversationId === id) loadCalls();
      },
    );
    return () => {
      offRecv();
      offSent();
      offStatus();
      offReaction();
      offRemoved();
      offOrders();
      offContact();
      offReadBulk();
      offAssigned();
      offUpdated();
      offCall();
    };
  }, [id, on, scrollToBottom, loadConvo, loadCalls, markReadIfVisible, toast, refreshOrders]);

  // Reconnect catch-up: on EVERY raw reconnect (a blip under the 2.5s status
  // grace used to be invisible → missed messages never appeared), refetch
  // silently — keeps older pages, scroll position and in-flight sends.
  const seenReconnect = useRef(reconnectSeq);
  useEffect(() => {
    if (reconnectSeq === seenReconnect.current) return;
    seenReconnect.current = reconnectSeq;
    loadConvo();
    void loadMessages({ silent: true });
    loadCalls();
  }, [reconnectSeq, loadConvo, loadMessages, loadCalls]);

  const loadOlder = useCallback(async () => {
    const el = scrollRef.current;
    const cursor = nextCursorRef.current;
    if (!el || loadingOlderRef.current || cursor == null) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const res = await apiFetch<{
        rows: Message[];
        nextCursor: number | null;
      }>(`/inbox/conversations/${id}/messages`, {
        params: { cursor, limit: PAGE },
      });
      // Restore position relative to what the agent was looking at (keeps the
      // original 0-60px offset; the old rAF version jumped).
      restoreRef.current = { h: el.scrollHeight, top: el.scrollTop };
      setMessages((cur) => {
        const have = new Set(cur.map((m) => m.id));
        return [...[...res.rows].reverse().filter((m) => !have.has(m.id)), ...cur];
      });
      setNextCursor(res.nextCursor);
    } catch {
      toast.error('Couldn’t load earlier messages');
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [id, toast]);

  useLayoutEffect(() => {
    const r = restoreRef.current;
    const el = scrollRef.current;
    if (!r || !el) return;
    el.scrollTop = el.scrollHeight - r.h + r.top;
    restoreRef.current = null;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distanceFromBottom < 120;
    atBottomRef.current = near;
    setShowJump(!near);
    if (near && newCount) setNewCount(0);
    if (near && pendingReadRef.current && document.visibilityState === 'visible') {
      pendingReadRef.current = false;
      void markRead();
    }
    if (el.scrollTop <= 60) void loadOlder();
  };

  // Copy a message's text to the clipboard (WhatsApp-style copy action).
  const copyMessage = useCallback(
    async (m: Message) => {
      const text = (m.content ?? '').trim();
      if (!text) {
        toast.info('Nothing to copy');
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        toast.success('Copied');
      } catch {
        toast.error('Could not copy');
      }
    },
    [toast],
  );

  const win = useMemo(
    () => windowCountdown(convo?.window_expires_at, now),
    [convo?.window_expires_at, now],
  );

  const clearReply = () => setReplyTo(null);
  const clearStaged = () => {
    setStaged(null);
  };

  // Stage a file from paste / drag-drop / picker, validating it first.
  const stageFile = useCallback(
    (file: File) => {
      const res = validateFile(file);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Keep whatever is already in the chat input — it becomes the caption.
      setStaged({ file, kind: res.kind });
    },
    [toast],
  );

  // Paste a screenshot/image straight into the composer (WhatsApp-style).
  const onComposerPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      const img = files.find((f) => f.type.startsWith('image/')) ?? files[0];
      if (img) {
        e.preventDefault();
        stageFile(img);
      }
    },
    [stageFile],
  );

  // Drag & drop a file anywhere over the thread to attach it.
  const onDragEnter = (e: React.DragEvent) => {
    if (!win.open || voiceActive) return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!win.open || voiceActive) return;
    if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    dragDepth.current = 0;
    setDragOver(false);
    if (!win.open || voiceActive) return;
    const file = e.dataTransfer.files?.[0];
    if (file) {
      e.preventDefault();
      stageFile(file);
    }
  };

  // Insert an emoji at the cursor in the composer.
  const insertEmoji = (emoji: string) => {
    const el = composerRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + emoji.length;
      el?.setSelectionRange(pos, pos);
    });
  };

  const scrollToMessage = (mid: number) => {
    const el = document.getElementById(`msg-${mid}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-brand-400');
      setTimeout(() => el.classList.remove('ring-2', 'ring-brand-400'), 1500);
    } else {
      toast.info('That message is further up — scroll up to load it.');
    }
  };

  // Send an arbitrary text body straight to the customer (no composer/reply
  // interaction) — used by "Send tracking info". Optimistic bubble like a normal
  // text; throws on failure so the caller (the tracking modal) can keep itself
  // open and surface the error.
  const sendPlainText = async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const nowIso = new Date().toISOString();
    const optimistic: Message = {
      id: tempId(),
      client_id: clientId,
      user_id: user?.id ?? null,
      user: user ? { id: user.id, name: user.name } : null,
      conversation_id: id,
      message_type: 'text',
      direction: 'outbound',
      content: trimmed,
      media_url: null,
      media_expired: false,
      status: 'sending',
      read_at: null,
      timestamp: nowIso,
      created_at: nowIso,
      context_message_id: null,
      context_message: null,
    };
    setMessages((cur) => [...cur, optimistic]);
    scrollToBottom(true);
    try {
      const real = await apiFetch<Message | undefined>(
        `/inbox/conversations/${id}/send`,
        { method: 'POST', body: { type: 'text', content: trimmed, clientId } },
      );
      if (real && typeof real === 'object' && 'id' in real) {
        setMessages((cur) => {
          if (cur.some((m) => m.id === (real as Message).id)) {
            return cur.filter(
              (m) =>
                !(
                  m.client_id === clientId &&
                  m.status === 'sending' &&
                  m.id !== (real as Message).id
                ),
            );
          }
          return cur.map((m) =>
            m.client_id === clientId
              ? { ...(real as Message), client_id: clientId }
              : m,
          );
        });
      }
    } catch (e) {
      setMessages((cur) =>
        cur.map((m) =>
          m.client_id === clientId
            ? {
                ...m,
                status: 'failed',
                error: e instanceof ApiError ? e.userMessage : 'Send failed',
              }
            : m,
        ),
      );
      toast.error(e instanceof ApiError ? e.userMessage : 'Send failed');
      throw e;
    }
  };

  const sendText = async () => {
    const body = text.trim();
    if (!body) return;

    // Optimistic UI: paint the bubble + clear the input INSTANTLY, then send in
    // the background. The real message arrives via the `message.sent` socket (or
    // the POST response) and replaces this temp; on failure it's marked failed.
    // Without this the composer blocks ~0.5s on the live Meta API round-trip.
    const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const replySnapshot = replyTo;
    const nowIso = new Date().toISOString();
    const optimistic: Message = {
      id: tempId(),
      client_id: clientId,
      user_id: user?.id ?? null,
      user: user ? { id: user.id, name: user.name } : null,
      conversation_id: id,
      message_type: 'text',
      direction: 'outbound',
      content: body,
      media_url: null,
      media_expired: false,
      status: 'sending',
      read_at: null,
      timestamp: nowIso,
      created_at: nowIso,
      context_message_id: replySnapshot?.id ?? null,
      context_message: replySnapshot
        ? {
            id: replySnapshot.id,
            direction: replySnapshot.direction,
            message_type: replySnapshot.message_type,
            content: replySnapshot.content,
            media_url: replySnapshot.media_url,
          }
        : null,
    };
    setMessages((cur) => [...cur, optimistic]);
    setText('');
    clearReply();
    setDraftRestored(false);
    setUndo(null);
    setUnreadDivider(null);
    clearDraft(id);
    lastTypingRef.current = 0;
    emit('typing.stop', { conversationId: id });
    scrollToBottom(true);

    try {
      const real = await apiFetch<Message | undefined>(
        `/inbox/conversations/${id}/send`,
        {
          method: 'POST',
          body: {
            type: 'text',
            content: body,
            clientId,
            ...(replySnapshot ? { contextMessageId: replySnapshot.id } : {}),
          },
        },
      );
      // Reconcile: if the POST echoed the real message, swap it in (unless the
      // socket already added it — then just drop the temp).
      if (real && typeof real === 'object' && 'id' in real) {
        setMessages((cur) => {
          if (cur.some((m) => m.id === (real as Message).id)) {
            // Socket already swapped in the confirmed message (which now also
            // carries client_id, and — for media — is itself `sending`). Only
            // drop a leftover temp: same client_id but the OPTIMISTIC (negative)
            // id, never the confirmed row (id === real.id).
            return cur.filter(
              (m) =>
                !(
                  m.client_id === clientId &&
                  m.status === 'sending' &&
                  m.id !== (real as Message).id
                ),
            );
          }
          // Keep client_id on the confirmed message → stable React key → no
          // bubble remount / flicker on temp→real swap.
          return cur.map((m) =>
            m.client_id === clientId
              ? { ...(real as Message), client_id: clientId }
              : m,
          );
        });
      }
      // If the POST returned nothing useful, the `message.sent` socket handler
      // strips this temp by content-match and appends the real one.
    } catch (e) {
      setMessages((cur) =>
        cur.map((m) =>
          m.client_id === clientId
            ? {
                ...m,
                status: 'failed',
                error: e instanceof ApiError ? e.userMessage : 'Send failed',
              }
            : m,
        ),
      );
      toast.error(e instanceof ApiError ? e.userMessage : 'Send failed');
    }
  };

  // Optimistic media send. Paints a "sending" bubble from a local object-URL
  // preview INSTANTLY (so images/audio/catalogue feel as fast as text), clears
  // the composer, then uploads in the background. The real message replaces the
  // temp via the POST response or the `message.sent` socket; failure marks it.
  //
  // The server side is already fast: `InboxService.sendMedia` writes the file
  // async, persists the row as `sending`, enqueues the `send-media` job, and
  // returns immediately — the two slow Meta round-trips (uploadMedia →
  // sendMessage) run in the background worker (`deliverQueuedMedia`) and flip
  // the row to `sent`/`failed` via a `message.status` socket event.
  const sendMediaFile = useCallback(
    async (
      file: File,
      kind: MediaKind,
      cap?: string,
      isVoice?: boolean,
      opts?: { noReply?: boolean },
    ) => {
      const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const objUrl = URL.createObjectURL(file);
      const captionTxt = (cap ?? '').trim() || null;
      const replySnapshot = opts?.noReply ? null : replyTo;
      const nowIso = new Date().toISOString();
      const optimistic: Message = {
        id: tempId(),
        client_id: clientId,
        user_id: user?.id ?? null,
        user: user ? { id: user.id, name: user.name } : null,
        conversation_id: id,
        message_type: kind,
        direction: 'outbound',
        content: captionTxt,
        media_url: objUrl,
        media_expired: false,
        status: 'sending',
        read_at: null,
        timestamp: nowIso,
        created_at: nowIso,
        context_message_id: replySnapshot?.id ?? null,
        context_message: replySnapshot
          ? {
              id: replySnapshot.id,
              direction: replySnapshot.direction,
              message_type: replySnapshot.message_type,
              content: replySnapshot.content,
              media_url: replySnapshot.media_url,
            }
          : null,
      };
      setMessages((cur) => [...cur, optimistic]);
      if (!opts?.noReply) {
        clearStaged();
        clearReply();
        setUnreadDivider(null);
      }
      scrollToBottom(true);

      try {
        // Compress large photos before uploading (WhatsApp-style). On HTTP/1.1
        // a multi-MB upload holds a connection + saturates the uplink for its
        // whole duration, blocking every other request "until sent" — worst for
        // agents with slow upload speed. Shrinking it ~10× makes the upload near
        // instant. Runs OFF the main thread AFTER the optimistic bubble is
        // already painted, so the send still feels instant. No-op for non-image
        // kinds / already-small images; falls back to the original on any error.
        const uploadFile =
          kind === 'image' ? await downscaleImageForSend(file) : file;
        const fd = new FormData();
        fd.append('file', uploadFile, uploadFile.name);
        fd.append('clientId', clientId);
        if (captionTxt) fd.append('caption', captionTxt);
        if (replySnapshot) fd.append('contextMessageId', String(replySnapshot.id));
        // Voice notes are recorded with the device's native recorder; the server
        // transcodes to WhatsApp OGG/Opus. This flag tells it to do that + send a
        // PTT bubble (not a plain audio file).
        if (isVoice) fd.append('voice', 'true');
        const real = await postMultipart<Message | undefined>(
          `/inbox/conversations/${id}/send-media`,
          fd,
        );
        if (real && typeof real === 'object' && 'id' in real) {
          setMessages((cur) => {
            if (cur.some((m) => m.id === (real as Message).id)) {
              // Socket already swapped in the confirmed message (carrying
              // client_id, and itself `sending` for media). Only drop a leftover
              // temp: same client_id but the optimistic (negative) id — never
              // the confirmed row (id === real.id).
              return cur.filter(
                (m) =>
                  !(
                    m.client_id === clientId &&
                    m.status === 'sending' &&
                    m.id !== (real as Message).id
                  ),
              );
            }
            // Keep client_id on the confirmed message → stable React key → the
            // bubble element is reused (no remount). The media src swaps from the
            // local blob to the server URL on the same element, so there's no
            // "sent twice" flash/reload.
            return cur.map((m) =>
              m.client_id === clientId
                ? { ...(real as Message), client_id: clientId }
                : m,
            );
          });
          URL.revokeObjectURL(objUrl);
        }
        // If the POST returned nothing useful, the `message.sent` socket handler
        // strips this temp by type+content match and appends the real one.
      } catch (e) {
        setMessages((cur) =>
          cur.map((m) =>
            m.client_id === clientId
              ? {
                  ...m,
                  status: 'failed',
                  error: e instanceof ApiError ? e.userMessage : 'Send failed',
                }
              : m,
          ),
        );
        toast.error(e instanceof ApiError ? e.userMessage : 'Upload failed');
      }
    },
    [id, replyTo, scrollToBottom, toast, user],
  );

  // ── Failed message: Retry / Delete (Inbox-v2) ─────────────────────────────
  const discardMessage = useCallback(
    async (m: Message) => {
      setMessages((cur) => cur.filter((x) => x !== m && x.id !== m.id));
      if (m.id > 0) {
        try {
          await apiFetch(`/inbox/messages/${m.id}`, { method: 'DELETE' });
        } catch (e) {
          toast.error(e instanceof ApiError ? e.userMessage : 'Couldn’t remove the message');
          void loadMessages({ silent: true });
        }
      }
    },
    [toast, loadMessages],
  );
  const retryRef = useRef<(m: Message) => Promise<void>>(async () => {});
  retryRef.current = async (m: Message) => {
    if (m.message_type === 'text') {
      const body = (m.content ?? '').trim();
      if (!body) return;
      await discardMessage(m);
      try {
        await sendPlainText(body);
      } catch {
        /* sendPlainText already marked the new attempt failed */
      }
      return;
    }
    const src = mediaUrl(m.media_url);
    if (!src) {
      toast.error('The file is no longer available — attach it again.');
      return;
    }
    try {
      const blob = await (await fetch(src)).blob();
      const ext = (blob.type.split('/')[1] || 'bin').split(';')[0];
      const file = new File([blob], `retry-${Date.now()}.${ext}`, { type: blob.type });
      await discardMessage(m);
      void sendMediaFile(
        file,
        m.message_type as MediaKind,
        m.content ?? undefined,
        m.message_type === 'audio',
        { noReply: true },
      );
    } catch {
      toast.error('Couldn’t re-read the file — attach it again.');
    }
  };
  const retryMessage = useCallback((m: Message) => void retryRef.current(m), []);

  const reactToMessage = useCallback(
    async (m: Message, emoji: string) => {
      const prev = m.agent_reaction ?? null;
      setMessages((cur) =>
        cur.map((x) => (x.id === m.id ? { ...x, agent_reaction: emoji || null } : x)),
      );
      try {
        await apiFetch(`/inbox/messages/${m.id}/react`, {
          method: 'POST',
          body: { emoji },
        });
      } catch (e) {
        setMessages((cur) =>
          cur.map((x) => (x.id === m.id ? { ...x, agent_reaction: prev } : x)),
        );
        toast.error(e instanceof ApiError ? e.userMessage : 'Couldn’t send the reaction');
      }
    },
    [toast],
  );

  const sendMedia = () => {
    if (!staged) return;
    // The caption comes from the SAME chat text input (WhatsApp doesn't caption
    // audio). Consume the text so it isn't left behind after the media sends.
    const supportsCaption = staged.kind !== 'audio';
    const cap = supportsCaption ? text : undefined;
    if (supportsCaption) setText('');
    void sendMediaFile(staged.file, staged.kind, cap);
  };

  const sendVoice = useCallback(
    (file: File) => {
      void sendMediaFile(file, 'audio', undefined, true);
    },
    [sendMediaFile],
  );

  const handleVoiceActive = useCallback((a: boolean) => setVoiceActive(a), []);

  // Auto-grow the composer with the text; CSS max-height caps it (8 lines
  // desktop / 5 mobile) and it scrolls beyond that.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // Catalog → stage the product as an image message with a caption that
  // includes the price and a link to the product, so the customer gets the
  // picture + details + link (WhatsApp-catalog style). The agent reviews and
  // hits send. Falls back to dropping the text+link into the composer when the
  // product has no image or the image can't be fetched.
  const onCatalogPick = async (p: CatalogProduct) => {
    setCatalogOpen(false);
    const variant =
      p.variantTitle && p.variantTitle !== 'Default Title'
        ? ` (${p.variantTitle})`
        : '';
    // WhatsApp-aligned, multi-line details: bold name, price, short
    // description (when the store has one), then the product link.
    const desc = (p.description || '').trim();
    const caption = [
      `*${p.productTitle}*${variant}`,
      `💰 PKR ${p.price}`,
      ...(desc ? ['', desc] : []),
      ...(p.productUrl ? ['', `🔗 ${p.productUrl}`] : []),
    ].join('\n');

    if (p.image) {
      // p.image is now a Shopify-resized ~1024px JPEG (~150-400KB), NOT the
      // multi-MB original — so this fetch is fast and doesn't jam the browser.
      // It's async, so switching chats stays responsive while it runs; the
      // small indicator just reflects progress.
      setCatalogPreparing(true);
      try {
        const resp = await fetch(p.image);
        if (resp.ok) {
          const blob = await resp.blob();
          const ext = (blob.type.split('/')[1] || 'jpg').split('+')[0];
          const file = new File([blob], `product.${ext}`, {
            type: blob.type || 'image/jpeg',
          });
          const res = validateFile(file);
          if (res.ok) {
            // Caption goes into the chat input (single source of truth); the
            // staged image previews above it and sends with this text.
            setStaged({ file, kind: res.kind });
            setText((t) => (t ? `${t}\n${caption}` : caption));
            requestAnimationFrame(() => composerRef.current?.focus());
            return;
          }
        }
      } catch {
        // fall through to text insert
      } finally {
        setCatalogPreparing(false);
      }
    }
    // No image / fetch failed → insert text (+ link) into the composer.
    setText((t) => (t ? `${t}\n${caption}` : caption));
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  // In-chat search over loaded messages → list of matching message ids.
  const searchMatches = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return [] as number[];
    return messages
      .filter((m) => (m.content || '').toLowerCase().includes(q))
      .map((m) => m.id);
  }, [searchTerm, messages]);

  // Jump to the newest match only when the TERM changes — re-running on every
  // `messages` change yanked the view whenever a message/status arrived.
  const searchMatchesRef = useRef(searchMatches);
  searchMatchesRef.current = searchMatches;
  useEffect(() => {
    const list = searchMatchesRef.current;
    if (!list.length) return;
    const pos = list.length - 1;
    setSearchPos(pos);
    const el = document.getElementById(`msg-${list[pos]}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [searchTerm]);

  const gotoMatch = (dir: 1 | -1) => {
    if (!searchMatches.length) return;
    const next =
      (searchPos + dir + searchMatches.length) % searchMatches.length;
    setSearchPos(next);
    scrollToMessage(searchMatches[next]);
  };

  useEffect(() => {
    if (!canManageAssign) return;
    apiFetch<TeamMember[]>('/team')
      .then((rows) => setMembers(Array.isArray(rows) ? rows : []))
      .catch(() => setMembers([]));
  }, [canManageAssign]);

  // Only surface "Create Shopify order" when this company has a Shopify
  // Admin token configured. Fetched once (not keyed to the conversation).
  useEffect(() => {
    apiFetch<{ adminTokenSet?: boolean }>('/settings/shopify/ready')
      .then((s) => setShopifyReady(!!s?.adminTokenSet))
      .catch(() => setShopifyReady(false));
  }, []);

  // Pull the matching Shopify customer's tags so the drawer reflects them.
  const contactEmailForTags = convo?.contact?.email ?? null;
  useEffect(() => {
    if (!shopifyReady || (!contactPhone && !contactEmailForTags)) {
      setShopifyCustomerTags([]);
      return;
    }
    let cancelled = false;
    getShopifyCustomerTags({
      phone: contactPhone ?? undefined,
      email: contactEmailForTags ?? undefined,
    })
      .then((r) => !cancelled && setShopifyCustomerTags(Array.isArray(r?.tags) ? r.tags : []))
      .catch(() => !cancelled && setShopifyCustomerTags([]));
    return () => {
      cancelled = true;
    };
  }, [shopifyReady, contactPhone, contactEmailForTags]);

  // Only surface the AI Copilot when AI is in the plan AND enabled for the
  // company (features.aiEnabled). Fetched once per mount.
  useEffect(() => {
    apiFetch<{ features?: { aiEnabled?: boolean } }>('/billing/subscription')
      .then((s) => setAiEnabled(!!s?.features?.aiEnabled))
      .catch(() => setAiEnabled(false));
    // Workspace all-chats toggle (agent-readable). Disables the per-chat toggle.
    apiFetch<{ autoReplyEnabled?: boolean }>('/ai/settings')
      .then((s) => setAllChatsOn(!!s?.autoReplyEnabled))
      .catch(() => setAllChatsOn(false));
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

  const setStatus = async (next: ConversationDetail['status']) => {
    const path = next === 'resolved' ? 'resolve' : next === 'pending' ? 'pending' : 'reopen';
    const prev = convo?.status;
    setConvo((c) => (c ? { ...c, status: next } : c));
    try {
      await apiFetch(`/inbox/conversations/${id}/${path}`, { method: 'POST' });
      toast.success(
        next === 'resolved' ? 'Conversation resolved' : next === 'pending' ? 'Marked pending' : 'Conversation reopened',
      );
      loadConvo();
    } catch (e) {
      setConvo((c) => (c && prev ? { ...c, status: prev } : c));
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    }
  };

  const addLabel = async (raw: string) => {
    const label = raw.trim();
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
      toast.success('Chat history cleared for your team');
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

  // Contact info panel: persist contact tags (contact-scoped) and flip the
  // per-chat AI auto-pilot — both reuse endpoints the rest of the inbox uses.
  const updateContactTags = async (next: string[]) => {
    if (!convo?.contact_id) return;
    await apiFetch(`/contacts/${convo.contact_id}`, {
      method: 'PATCH',
      body: { tags: next },
    });
    loadConvo();
  };

  // Separate Shopify customer-tag editor — writes straight to the Shopify
  // customer (its own namespace; local contact tags are never pushed there).
  const updateShopifyTags = async (next: string[]) => {
    const phone = convo?.contact?.phone ?? undefined;
    const email = convo?.contact?.email ?? undefined;
    if (!phone && !email) return;
    const res = await apiSetShopifyCustomerTags({ phone, email, tags: next });
    setShopifyCustomerTags(Array.isArray(res?.tags) ? res.tags : next);
  };

  // Three-way per-chat AI: 'default' follows the workspace, 'on' forces,
  // 'off' mutes (allowed even when workspace-wide auto-reply is on).
  const setConvoAutoReply = async (mode: 'on' | 'off' | 'default') => {
    try {
      await aiSetConversationAutoReply(id, mode);
      setConvo((c) =>
        c ? { ...c, ai_autoreply: mode === 'default' ? null : mode === 'on' } : c,
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    }
  };

  // Last inbound text message — seeds a new ticket's description.
  const lastInboundText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.direction === 'inbound' && m.content?.trim()) return m.content.trim();
    }
    return null;
  }, [messages]);

  // Timeline = messages + call records, interleaved by time, grouped by day.
  const grouped = useMemo(() => {
    const items: TimelineItem[] = [
      ...messages.map((m) => ({
        kind: 'msg' as const,
        t: new Date(m.timestamp || m.created_at).getTime(),
        msg: m,
      })),
      ...calls.map((c) => ({
        kind: 'call' as const,
        t: new Date(c.started_at || c.created_at).getTime(),
        call: c,
      })),
    ].sort((a, b) => a.t - b.t);
    const out: Array<{ day: string; items: TimelineItem[] }> = [];
    for (const it of items) {
      const iso =
        it.kind === 'msg'
          ? it.msg.timestamp || it.msg.created_at
          : it.call.started_at || it.call.created_at;
      const k = dayKey(iso);
      const last = out[out.length - 1];
      if (last && last.day === k) last.items.push(it);
      else out.push({ day: k, items: [it] });
    }
    return out;
  }, [messages, calls]);

  // For each audio message, the id of the message right after it IN DISPLAY
  // ORDER — but ONLY when that next one is ALSO audio (auto-advance through
  // consecutive voice notes). Built from the sorted timeline: realtime appends
  // aren't always in time order in the raw array.
  const orderedMessages = useMemo(
    () =>
      grouped.flatMap((g) =>
        g.items.filter((it) => it.kind === 'msg').map((it) => (it as { msg: Message }).msg),
      ),
    [grouped],
  );
  const nextAudioMap = useMemo(() => {
    const map: Record<number, number> = {};
    for (let i = 0; i < orderedMessages.length - 1; i++) {
      if (
        orderedMessages[i].message_type === 'audio' &&
        orderedMessages[i + 1].message_type === 'audio'
      ) {
        map[orderedMessages[i].id] = orderedMessages[i + 1].id;
      }
    }
    return map;
  }, [orderedMessages]);

  // Every loaded image, in order — the lightbox pages through them.
  const galleryImages = useMemo<GalleryImage[]>(
    () =>
      orderedMessages
        .filter((m) => m.message_type === 'image' && !m.media_expired && m.media_url)
        .map((m) => ({
          id: m.id,
          src: mediaUrl(m.media_url) ?? '',
          caption: m.content,
          at: m.timestamp || m.created_at,
          fromCustomer: m.direction === 'inbound',
        })),
    [orderedMessages],
  );

  // ── Keyboard shortcuts (only when not typing / no dialog open) ─────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (document.querySelector('[aria-modal="true"],[data-order-drawer]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !typing) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'e') {
        e.preventDefault();
        void setStatusRef.current(convoStatusRef.current === 'resolved' ? 'open' : 'resolved');
      } else if (k === 'a') {
        e.preventDefault();
        setAssignSignal((n) => n + 1);
      } else if (k === 'i') {
        e.preventDefault();
        setPanelOpen((o) => !o);
      } else if (k === 'r' && !e.shiftKey) {
        // Focus the composer to reply.
        e.preventDefault();
        composerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPanelOpen]);
  const setStatusRef = useRef(setStatus);
  setStatusRef.current = setStatus;
  const convoStatusRef = useRef(convo?.status);
  convoStatusRef.current = convo?.status;

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
    // The `/token` itself is never worth undoing — only a real draft is.
    setText(r.body);
    setSlashHidden(true);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  if (!Number.isFinite(id)) return null;

  return (
    <div
      className="relative h-full flex bg-sunken"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="relative flex-1 flex flex-col min-w-0 h-full">
      {dragOver && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-green-600/10 backdrop-blur-sm border-4 border-dashed border-green-500 m-2 rounded-2xl pointer-events-none">
          <div className="bg-white rounded-xl px-6 py-4 shadow-lg text-center">
            <p className="text-base font-semibold text-gray-900">
              Drop to attach
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Image, video, audio or document
            </p>
          </div>
        </div>
      )}
      <ThreadHeader
        convo={convo}
        windowExpiresAt={convo?.window_expires_at}
        now={now}
        meId={user?.id}
        canManageAssign={canManageAssign}
        members={members}
        panelOpen={panelOpen}
        searchOpen={searchOpen}
        canCall={!!(sip?.available && contactPhone)}
        callDisabled={!sip?.ready || sip?.state !== 'idle'}
        assignSignal={assignSignal}
        chips={
          <>
            <OpenTicketChip
              conversationId={id}
              openSignal={ticketOpenSignal}
              orders={contactOrders}
              members={members}
              lastInboundText={lastInboundText}
            />
            <ContactOrderChip
              orders={contactOrders}
              onClick={() => {
                const trackables = (contactOrders?.orders ?? []).filter(isOrderTrackable);
                if (trackables.length === 1) setTrackOrder(trackables[0]);
                else {
                  setPanelTab('orders');
                  setPanelOpen(true);
                }
              }}
            />
          </>
        }
        onBack={() => router.push(`/inbox${typeof window !== 'undefined' ? window.location.search : ''}`)}
        onTogglePanel={() => setPanelOpen((o) => !o)}
        onAssign={(uid) => void assignTo(uid)}
        onSetStatus={(st) => void setStatus(st)}
        onCall={() => contactPhone && sip?.placeCall(contactPhone)}
        onToggleSearch={() => setSearchOpen((o) => !o)}
        onTogglePin={() => void togglePin()}
        onClear={() => setClearOpen(true)}
        onBlock={() => setBlockOpen(true)}
        onAudit={() => setAuditOpen(true)}
        onNotes={() => {
          setPanelTab('notes');
          setPanelOpen(true);
        }}
        onTicket={() => setTicketOpenSignal((n) => n + 1)}
        onSendTemplate={() => setTplOpen(true)}
        onAddLabel={addLabel}
        onRemoveLabel={removeLabel}
      />

      <AdReferralCard referral={convo?.referral} />

      {viewers.length > 0 &&
        (() => {
          const named = canManageAssign
            ? viewers.map((v) => v.name).filter((n): n is string => !!n)
            : [];
          let label = 'Another agent is also viewing this conversation.';
          if (named.length === 1) {
            label = `${named[0]} is also viewing this conversation.`;
          } else if (named.length > 1) {
            const list =
              named.slice(0, -1).join(', ') + ' and ' + named[named.length - 1];
            label = `${list} are also viewing this conversation.`;
          }
          return (
            <div role="status" className="bg-yellow-50 text-yellow-800 text-xs px-4 py-1.5 border-b border-yellow-200">
              {label}
            </div>
          );
        })()}
      {socketStatus !== 'connected' && (
        <div role="status" aria-live="polite" className="flex items-center gap-2 bg-orange-50 text-orange-700 text-xs px-4 py-1.5 border-b border-orange-200">
          <Loader2 size={13} className="animate-spin" aria-hidden />
          Reconnecting… new messages will appear when you’re back online.
        </div>
      )}
      {convo?.contact?.status === 'blocked' && (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700">
          <AlertCircle size={13} aria-hidden />
          This contact is blocked — their messages are stored silently and you can’t reply.
          <button onClick={() => setBlockOpen(true)} className="ml-auto font-semibold underline">
            Unblock
          </button>
        </div>
      )}

      {searchOpen && (
        <div className="bg-gray-50 border-b border-gray-200 px-3 py-2 flex items-center gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0 bg-white border border-gray-300 rounded-lg px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-green-500">
            <Search size={16} className="text-gray-400 shrink-0" />
            <input
              autoFocus
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  gotoMatch(e.shiftKey ? -1 : 1);
                }
                if (e.key === 'Escape') {
                  setSearchOpen(false);
                  setSearchTerm('');
                }
              }}
              placeholder="Search loaded messages…"
              aria-label="Search in this chat"
              className="flex-1 min-w-0 text-sm outline-none bg-transparent"
            />
            <span className="text-xs text-gray-400 tabular-nums shrink-0">
              {searchTerm.trim()
                ? searchMatches.length
                  ? `${searchPos + 1}/${searchMatches.length}`
                  : '0'
                : ''}
            </span>
          </div>
          <button
            onClick={() => gotoMatch(-1)}
            disabled={!searchMatches.length}
            className="p-1 text-gray-500 hover:text-gray-800 disabled:opacity-30"
            title="Previous"
            aria-label="Previous match"
          >
            <ChevronUp size={16} />
          </button>
          <button
            onClick={() => gotoMatch(1)}
            disabled={!searchMatches.length}
            className="p-1 text-gray-500 hover:text-gray-800 disabled:opacity-30"
            title="Next"
            aria-label="Next match"
          >
            <ChevronDown size={16} />
          </button>
          <button
            onClick={() => {
              setSearchOpen(false);
              setSearchTerm('');
            }}
            className="p-1 text-gray-500 hover:text-gray-800"
            title="Close search"
            aria-label="Close search"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="relative flex-1 min-h-0">
        {loadingOlder && (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-xs text-muted shadow">
              <Loader2 size={13} className="animate-spin" aria-hidden /> Loading earlier messages…
            </span>
          </div>
        )}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="chat-wallpaper h-full overflow-y-auto px-3 sm:px-6 lg:px-10 py-3"
          aria-label="Messages"
        >
          {!loading && nextCursor != null && (
            <div className="flex justify-center py-1">
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="rounded-full bg-surface px-3 py-1 text-xs font-semibold text-muted shadow-sm hover:text-ink disabled:opacity-50"
              >
                Load earlier messages
              </button>
            </div>
          )}
          {loading ? (
            <div className="flex h-full flex-col justify-end gap-3 pb-2" aria-busy="true">
              {[60, 40, 70, 35, 55].map((w, i) => (
                <div
                  key={i}
                  className={cn('h-10 animate-pulse rounded-2xl bg-surface/80', i % 2 ? 'self-end' : 'self-start')}
                  style={{ width: `${w}%` }}
                />
              ))}
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <p className="text-sm font-semibold text-ink">No messages yet</p>
              <p className="max-w-xs text-xs text-muted">
                {win.open
                  ? 'Say hello — your reply goes straight to the customer on WhatsApp.'
                  : 'Start the conversation with an approved template.'}
              </p>
            </div>
          ) : (
            grouped.map((g) => (
              <div key={g.day}>
                <div className="sticky top-1 z-[5] my-3 flex justify-center">
                  <span className="rounded-full bg-surface px-3 py-0.5 text-xs font-medium text-muted shadow-sm">
                    {dayLabel(g.day)}
                  </span>
                </div>
                {g.items.map((it, idx) => {
                  if (it.kind === 'call') {
                    return (
                      <CallPill
                        key={`call-${it.call.id}`}
                        c={it.call}
                        onCallBack={
                          sip?.available && contactPhone
                            ? () => sip.placeCall(contactPhone)
                            : undefined
                        }
                      />
                    );
                  }
                  const m = it.msg;
                  // Group consecutive messages from the same sender within 5
                  // minutes: tighter spacing, tail + sender label on the first.
                  const prev = g.items[idx - 1];
                  const prevMsg = prev && prev.kind === 'msg' ? prev.msg : null;
                  const groupStart =
                    !prevMsg ||
                    senderKeyOf(prevMsg) !== senderKeyOf(m) ||
                    it.t - prev.t > 5 * 60_000 ||
                    unreadDivider?.id === m.id;
                  return (
                    <div key={m.client_id ?? m.id}>
                      {unreadDivider?.id === m.id && (
                        <div
                          className="my-3 flex items-center gap-3 text-xs font-semibold text-brand-700"
                          role="separator"
                          aria-label={`${unreadDivider.count} unread messages`}
                        >
                          <span className="h-px flex-1 bg-brand-500/40" />
                          {unreadDivider.count} unread {unreadDivider.count === 1 ? 'message' : 'messages'}
                          <span className="h-px flex-1 bg-brand-500/40" />
                        </div>
                      )}
                      <Bubble
                        m={m}
                        nextAudioId={nextAudioMap[m.id]}
                        aiEnabled={aiEnabled}
                        senderLabel={senderLabelOf(m, user?.id)}
                        groupStart={groupStart}
                        canReact={win.open && convo?.contact?.status !== 'blocked'}
                        onReply={() => setReplyTo(m)}
                        onCopy={() => copyMessage(m)}
                        onJump={scrollToMessage}
                        onOpenImage={setGalleryStart}
                        onRetry={() => retryMessage(m)}
                        onDelete={() => void discardMessage(m)}
                        onReact={(e) => void reactToMessage(m, e)}
                      />
                    </div>
                  );
                })}
              </div>
            ))
          )}
          <div aria-live="polite" className="min-h-[1rem]">
            {typingFrom && (
              <p className="px-2 pt-1 text-xs italic text-muted">
                {canManageAssign && typingFrom.name
                  ? `${typingFrom.name} (your team) is typing a reply…`
                  : 'A teammate is typing a reply…'}
              </p>
            )}
          </div>
          {(showJump || newCount > 0) && (
            <div className="pointer-events-none sticky bottom-3 z-10 flex justify-end pr-1">
              <button
                type="button"
                onClick={() => scrollToBottom(true)}
                aria-label={newCount > 0 ? `${newCount} new messages — jump to latest` : 'Jump to latest messages'}
                className="pointer-events-auto relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-lg hover:text-ink"
              >
                <ChevronDown size={20} />
                {newCount > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand-600 px-1 text-xs font-semibold text-white">
                    {newCount > 99 ? '99+' : newCount}
                  </span>
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="bg-white border-t border-gray-200 p-3">
        {win.open ? (
          <div className="relative">
            {showSlash && (
              <div className="absolute left-2 right-2 bottom-full mb-2 max-h-60 overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-lg z-30">
                <div className="px-3 py-1.5 text-xs font-medium text-gray-400 border-b border-gray-100 flex items-center gap-1">
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
            {(draftRestored || undo) && (
              <div className="mb-2 flex items-center gap-2 text-xs text-muted">
                {undo ? (
                  <>
                    <Undo2 size={13} aria-hidden />
                    {undo.label}
                    <button
                      type="button"
                      onClick={() => {
                        setText(undo.text);
                        setUndo(null);
                        composerRef.current?.focus();
                      }}
                      className="font-semibold text-brand-700 hover:underline"
                    >
                      Undo
                    </button>
                  </>
                ) : (
                  <>
                    <FileText size={13} aria-hidden />
                    Draft restored
                    <button
                      type="button"
                      onClick={() => {
                        setText('');
                        setReplyTo(null);
                        setStaged(null);
                        setDraftRestored(false);
                        clearDraft(id);
                      }}
                      className="font-semibold text-brand-700 hover:underline"
                    >
                      Discard
                    </button>
                  </>
                )}
              </div>
            )}
            {replyTo && (
              <ReplyQuoteStrip
                message={replyTo}
                contactName={convo?.contact?.name || 'Customer'}
                onClear={clearReply}
              />
            )}
            {catalogPreparing && !staged && (
              <div className="border border-gray-200 rounded-lg px-3 py-2 mb-2 bg-gray-50 flex items-center gap-2 text-sm text-gray-500">
                <span className="w-4 h-4 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
                Preparing product image…
              </div>
            )}
            {staged && (
              <AttachmentPreview
                file={staged.file}
                kind={staged.kind}
                onClear={clearStaged}
              />
            )}
            {(
              <div className="flex items-end gap-1.5">
                {/* WhatsApp-style input pill: emoji · message · attachment(+).
                    All three sit INSIDE one rounded field; Send/Mic stay
                    outside on the right. */}
                {!voiceActive && (
                  <div className="flex items-end flex-1 min-w-0 gap-0.5 border border-gray-300 rounded-2xl px-1.5 focus-within:ring-2 focus-within:ring-green-500">
                    {/* Emoji (left) */}
                    <div className="relative shrink-0">
                      <button
                        ref={emojiBtnRef}
                        type="button"
                        onClick={() => setEmojiOpen((o) => !o)}
                        title="Emoji"
                        aria-label="Emoji"
                        aria-haspopup="dialog"
                        aria-expanded={emojiOpen}
                        className="p-2 text-gray-500 hover:text-gray-800"
                      >
                        <Smile size={22} />
                      </button>
                      {emojiOpen && (
                        <EmojiPicker
                          onPick={(e) => insertEmoji(e)}
                          onClose={() => setEmojiOpen(false)}
                          ignoreRef={emojiBtnRef}
                        />
                      )}
                    </div>

                    {/* Auto-growing message box (scrolls only past max height) */}
                    <textarea
                      ref={composerRef}
                      value={text}
                      onChange={(e) => {
                        setText(e.target.value);
                        setSlashHidden(false);
                        setSlashIdx(0);
                        setDraftRestored(false);
                        // Throttled: one typing.start per 3s, not per keystroke.
                        const t = Date.now();
                        if (t - lastTypingRef.current > 3000) {
                          lastTypingRef.current = t;
                          emit('typing.start', { conversationId: id });
                        }
                      }}
                      onBlur={() => {
                        lastTypingRef.current = 0;
                        emit('typing.stop', { conversationId: id });
                      }}
                      onPaste={onComposerPaste}
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
                            selectSlash(
                              slashMatches[slashIdx] ?? slashMatches[0],
                            );
                            return;
                          }
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            setSlashHidden(true);
                            return;
                          }
                        }
                        if (e.key === 'Enter' && !e.shiftKey) {
                          // Desktop: Enter sends (Shift+Enter = newline).
                          // Mobile/touch: Enter inserts a newline like WhatsApp
                          // — sending is via the Send button only.
                          const desktop =
                            window.matchMedia?.('(pointer: fine)').matches;
                          if (desktop) {
                            e.preventDefault();
                            if (staged) sendMedia();
                            else sendText();
                          }
                        }
                      }}
                      rows={1}
                      aria-label={staged ? 'Caption' : 'Message'}
                      placeholder={staged ? 'Add a caption…' : 'Type a message'}
                      className="flex-1 min-w-0 resize-none bg-transparent py-2.5 text-sm max-h-28 md:max-h-44 overflow-y-auto focus:outline-none"
                    />

                    {/* Unified attachment menu — Photos/Camera/Document/Audio +
                        Catalog/Quick reply/Template/Shopify (right) */}
                    <AttachmentPicker
                      onPick={(p) => {
                        // Keep any typed text — it becomes the caption.
                        setStaged(p);
                      }}
                      onCamera={() => setCameraOpen(true)}
                      onCatalog={
                        shopifyReady ? () => setCatalogOpen(true) : undefined
                      }
                      onQuickReply={() => setQuickOpen(true)}
                      onTemplate={() => setTplOpen(true)}
                      onShopify={
                        shopifyReady ? () => setOrderOpen(true) : undefined
                      }
                      onTrackOrder={
                        shopifyReady ? () => setTrackOrderOpen(true) : undefined
                      }
                    />
                  </div>
                )}

                {/* AI Copilot */}
                {!voiceActive && aiEnabled && (
                  <AiCopilot
                    conversationId={id}
                    getText={() => text}
                    onInsert={(t) => replaceDraft(t, 'AI replaced your draft')}
                    autoReplyOn={convo?.ai_autoreply === true}
                    autoReplyMuted={convo?.ai_autoreply === false}
                    allChatsOn={allChatsOn}
                    onAutoReplyChange={(on) =>
                      setConvo((c) => (c ? { ...c, ai_autoreply: on } : c))
                    }
                  />
                )}

                {/* Send when there's a staged attachment or text… */}
                {!voiceActive && (staged || !!text.trim()) && (
                  <button
                    onClick={staged ? sendMedia : sendText}
                    className="bg-green-600 hover:bg-green-700 text-white p-2.5 rounded-full disabled:opacity-40 shrink-0"
                    title="Send"
                    aria-label="Send"
                  >
                    <Send size={18} />
                  </button>
                )}

                {/* …otherwise the mic. Single instance: expands into the
                    recorder bar while recording, hidden when text is present or
                    an attachment is staged. */}
                <VoiceRecorder
                  hidden={!voiceActive && (staged !== null || !!text.trim())}
                  onComplete={sendVoice}
                  onActiveChange={handleVoiceActive}
                />
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <AttachmentPicker
                  disabled
                  onPick={() => {
                    /* disabled outside 24hr window */
                  }}
                />
                <p className="text-xs text-muted">
                  {convo?.contact?.status === 'blocked'
                    ? 'This contact is blocked.'
                    : 'The 24-hour window is closed — send an approved template to restart the conversation. Free replies reopen as soon as the customer writes back.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {shopifyReady && (
                  <button
                    onClick={() => setOrderOpen(true)}
                    title="Create a Shopify order from this chat (works outside the 24-hour window)"
                    className="border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm px-3 py-2 rounded-lg flex items-center gap-2"
                  >
                    <ShopifyIcon size={16} /> Create order
                  </button>
                )}
                <button
                  onClick={() => setTplOpen(true)}
                  className="bg-green-600 hover:bg-green-700 text-white text-sm px-4 py-2 rounded-lg flex items-center gap-2"
                >
                  <FileText size={16} /> Send template
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <AiAuditModal
        conversationId={id}
        open={auditOpen}
        onClose={() => setAuditOpen(false)}
      />
      <ConfirmDialog
        open={clearOpen}
        title="Clear chat"
        message="This hides the message history for EVERYONE on your team (it isn't deleted — it's a marker, and new messages still appear). The customer still sees the full conversation on WhatsApp."
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
            : 'Block this contact? Their messages will still be saved, but they won’t raise unread counts, notifications or AI/bot replies, and your team can’t send to them until you unblock.'
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
          conversationId={id}
          aiEnabled={aiEnabled}
          onClose={() => {
            setOrderOpen(false);
            // A new order shows up in the drawer + header chip right away.
            refreshOrders();
          }}
        />
      )}
      {trackOrderOpen && (
        <TrackOrderModal
          onInsertMessage={(t) => {
            // Append to any existing draft (with a blank line) rather than
            // overwriting it — the old setText(t) wiped what the agent had typed.
            setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${t}` : t));
            requestAnimationFrame(() => composerRef.current?.focus());
          }}
          onClose={() => setTrackOrderOpen(false)}
        />
      )}
      {cameraOpen && (
        <CameraCapture
          onCapture={(file) => {
            stageFile(file);
            setCameraOpen(false);
          }}
          onClose={() => setCameraOpen(false)}
        />
      )}
      {catalogOpen && (
        <CatalogPicker
          onPick={onCatalogPick}
          onClose={() => setCatalogOpen(false)}
        />
      )}
      </div>

      {panelOpen && (
        <ContactInfoPanel
          conversationId={id}
          convo={convo}
          orders={contactOrders}
          ordersLoading={ordersLoading}
          ordersError={ordersError}
          onRetryOrders={refreshOrders}
          onOrdersChanged={refreshOrders}
          tab={panelTab}
          onTabChange={setPanelTab}
          tags={
            Array.isArray(convo?.contact?.tags)
              ? (convo!.contact.tags as unknown[]).filter(
                  (t): t is string => typeof t === 'string',
                )
              : []
          }
          onSetTags={updateContactTags}
          shopifyTags={shopifyReady ? shopifyCustomerTags : null}
          onSetShopifyTags={shopifyReady ? updateShopifyTags : undefined}
          members={members}
          meId={user?.id}
          canManageAssign={canManageAssign}
          onAssign={(uid) => void assignTo(uid)}
          aiEnabled={aiEnabled}
          aiMode={
            convo?.ai_autoreply === true ? 'on' : convo?.ai_autoreply === false ? 'off' : 'default'
          }
          allChatsOn={allChatsOn}
          onAiMode={(m) => void setConvoAutoReply(m)}
          onCreateOrder={shopifyReady ? () => setOrderOpen(true) : undefined}
          onCall={
            sip?.available && contactPhone
              ? () => sip.placeCall(contactPhone)
              : undefined
          }
          onToggleBlock={() => setBlockOpen(true)}
          onAddLabel={addLabel}
          onRemoveLabel={removeLabel}
          onContactSaved={loadConvo}
          calls={calls}
          onClose={() => setPanelOpen(false)}
          // Tracking opens OVER the drawer — it no longer closes it.
          onTrack={(o) => setTrackOrder(o)}
        />
      )}

      {trackOrder && (
        <OrderTrackingModal
          order={trackOrder}
          onClose={() => setTrackOrder(null)}
          onSend={sendPlainText}
        />
      )}
      {galleryStart != null && galleryImages.length > 0 && (
        <ImageGallery
          images={galleryImages}
          startId={galleryStart}
          onClose={() => setGalleryStart(null)}
        />
      )}
    </div>
  );
}

// WhatsApp text formatting: *bold*, _italic_, ~strikethrough~, ```monospace```.
// WhatsApp renders these markers as styles; our bubbles previously showed the
// raw markers (e.g. a catalogue caption "*Fibroget Syrup*" displayed WITH the
// asterisks, while the customer's WhatsApp shows it bold). Match WhatsApp so an
// agent sees exactly what the customer sees. Single-level (no nesting); markers
// must hug non-space content, mirroring WhatsApp's own rules.
const WA_FORMAT_RE =
  /\*(?=\S)([^*\n]*?\S)\*|_(?=\S)([^_\n]*?\S)_|~(?=\S)([^~\n]*?\S)~|```([\s\S]+?)```/g;

function formatWhatsApp(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  WA_FORMAT_RE.lastIndex = 0;
  while ((m = WA_FORMAT_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] != null) {
      nodes.push(
        <strong key={key++} className="font-bold">
          {m[1]}
        </strong>,
      );
    } else if (m[2] != null) {
      nodes.push(<em key={key++}>{m[2]}</em>);
    } else if (m[3] != null) {
      nodes.push(
        <span key={key++} className="line-through">
          {m[3]}
        </span>,
      );
    } else if (m[4] != null) {
      nodes.push(
        <code key={key++} className="font-mono text-[0.9em]">
          {m[4]}
        </code>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Shell-Polish-C: autolink uses the shared extractUrls/autolinkText matcher
// (single source of truth — same regex feeds the OG preview cards). Non-URL
// text runs additionally get WhatsApp *bold*/_italic_/~strike~/```mono```.
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
            className="underline break-all text-sky-700"
            data-out={out ? '1' : undefined}
          >
            {seg.value}
          </a>
        ) : (
          <span key={i}>{formatWhatsApp(seg.value)}</span>
        ),
      )}
    </>
  );
}

// Long messages collapse with a WhatsApp-style "Read more" toggle.
function ExpandableText({ text, out }: { text: string; out: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 600;
  const isLong = text.length > LIMIT;
  const shown =
    expanded || !isLong ? text : `${text.slice(0, LIMIT).trimEnd()}…`;
  return (
    <div className="whitespace-pre-wrap break-words">
      <Linkify text={shown} out={out} />
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="block mt-1 text-xs font-semibold text-brand-700 hover:underline"
        >
          {expanded ? 'Read less' : 'Read more'}
        </button>
      )}
    </div>
  );
}

function Ticks({ m, onDark }: { m: Message; onDark?: boolean }) {
  if (m.direction !== 'outbound') return null;
  const grey = onDark ? 'text-white/80' : 'text-muted';
  if (m.status === 'sending')
    return <Clock size={13} className={grey} aria-label="Sending" />;
  if (m.status === 'failed')
    return <AlertCircle size={14} className="text-red-600" aria-label="Not delivered" />;
  // `played` (voice note / view-once opened) is a step beyond `read`.
  if (m.status === 'read' || m.status === 'played')
    return <CheckCheck size={14} className={onDark ? 'text-sky-300' : 'text-sky-500'} aria-label="Read" />;
  if (m.status === 'delivered')
    return <CheckCheck size={14} className={grey} aria-label="Delivered" />;
  return <Check size={14} className={grey} aria-label="Sent" />;
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
        'block w-full text-left border-l-4 rounded px-2 py-1 mb-1 text-xs truncate bg-black/5 text-muted',
        out ? 'border-brand-600' : 'border-sky-600',
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

// Memoized so a parent re-render (every keystroke in the composer, every
// optimistic send, every socket event) does NOT re-render the ENTIRE thread.
// Callback props are intentionally ignored by the comparator — their
// behaviour depends only on `m` (compared here) and stable helpers.
const Bubble = memo(
  BubbleImpl,
  (a, b) =>
    a.m === b.m &&
    a.nextAudioId === b.nextAudioId &&
    a.aiEnabled === b.aiEnabled &&
    a.senderLabel === b.senderLabel &&
    a.groupStart === b.groupStart &&
    a.canReact === b.canReact,
);

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '🙏', '✅'];

// "(unsupported: x)" rows the webhook stores for message types we can't render
// (edited / deleted / system notices / new WhatsApp features).
const UNSUPPORTED_RE = /^\(unsupported: ([\w-]+)\)$/;

/** Parse the webhook's "📍 Location: name — address (lat, lng)" text. */
function parseLocation(content: string) {
  if (!content.startsWith('📍 Location')) return null;
  const coords = content.match(/\((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)\s*$/);
  const label = content
    .replace(/^📍 Location:?\s*/, '')
    .replace(/\s*\((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)\s*$/, '')
    .trim();
  return {
    label: label || 'Shared location',
    lat: coords?.[1] ?? null,
    lng: coords?.[2] ?? null,
  };
}

/** Parse the webhook's "👤 Contact(s): Name +92…; Name2 +92…" text. */
function parseContacts(content: string) {
  if (!content.startsWith('👤 Contact')) return null;
  const body = content.replace(/^👤 Contacts?:\s*/, '');
  return body
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const ph = p.match(/(\+?\d[\d\s-]{6,}\d)/);
      return {
        name: ph ? p.replace(ph[0], '').trim() || ph[0] : p,
        phone: ph ? ph[0].replace(/[\s-]/g, '') : null,
      };
    });
}

function fileNameOf(m: Message): string {
  const fromContent = (m.content ?? '').trim();
  // Inbound documents store the filename as content when there's no caption.
  if (m.direction === 'inbound' && /\.[a-z0-9]{2,5}$/i.test(fromContent)) {
    return fromContent;
  }
  const base = (m.media_url ?? '').split('/').pop() ?? '';
  return decodeURIComponent(base.replace(/\?.*$/, '')) || 'Document';
}

function senderKeyOf(m: Message): string {
  if (m.direction === 'inbound') return 'customer';
  if (m.user_id) return `u${m.user_id}`;
  if (m.broadcast_id) return `b${m.broadcast_id}`;
  return 'auto';
}

/** Who sent an outbound message — agent name / broadcast / automation. */
function senderLabelOf(m: Message, meId: number | undefined): string | null {
  if (m.direction !== 'outbound') return null;
  if (m.user_id && m.user_id === meId) return 'You';
  if (m.user?.name) return m.user.name;
  if (m.broadcast_id) return m.broadcast_name ? `Broadcast · ${m.broadcast_name}` : 'Broadcast';
  if (m.message_type === 'template') return 'Automation · template';
  return 'Automation (bot or AI)';
}

function BubbleImpl({
  m,
  nextAudioId,
  aiEnabled,
  senderLabel,
  groupStart,
  canReact,
  onReply,
  onCopy,
  onJump,
  onOpenImage,
  onRetry,
  onDelete,
  onReact,
}: {
  m: Message;
  nextAudioId?: number;
  aiEnabled: boolean;
  senderLabel: string | null;
  groupStart: boolean;
  canReact: boolean;
  onReply: () => void;
  onCopy: () => void;
  onJump: (id: number) => void;
  onOpenImage: (id: number) => void;
  onRetry: () => void;
  onDelete: () => void;
  onReact: (emoji: string) => void;
}) {
  const out = m.direction === 'outbound';
  const toast = useToast();
  const url = mediaUrl(m.media_url);
  const imageThumbSrc =
    m.message_type === 'image' && m.media_url?.startsWith('/storage/')
      ? mediaUrl(m.media_url.replace(/\.[^./]+$/, '.thumb.jpg'))
      : url;
  const [zoomSticker, setZoomSticker] = useState(false);
  const [menu, setMenu] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const isMedia = ['image', 'audio', 'video', 'document', 'sticker'].includes(
    m.message_type,
  );
  const canCopy = !!(m.content && m.content.trim());
  const failed = out && m.status === 'failed';
  const failReason = m.error || m.error_reason || null;

  const isAudio = m.message_type === 'audio';
  const [transcript, setTranscript] = useState<string | null>(
    m.transcription ?? null,
  );
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const showTranscript = isAudio && (aiEnabled || !!transcript);

  const openTranscript = async () => {
    if (transcript) {
      setTranscriptOpen(true);
      return;
    }
    if (transcribing) return;
    setTranscribing(true);
    try {
      const res = await apiFetch<{ text: string }>(
        `/inbox/conversations/${m.conversation_id}/messages/${m.id}/transcribe`,
        { method: 'POST' },
      );
      setTranscript(res.text);
      setTranscriptOpen(true);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Could not transcribe',
      );
    } finally {
      setTranscribing(false);
    }
  };

  const copyTranscript = async () => {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      toast.success('Transcript copied');
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  const canDownload =
    isMedia && !m.media_expired && !!url && m.message_type !== 'sticker';

  const hasCaption = !!(m.content && m.content.trim());
  const visualMedia =
    !m.media_expired &&
    !!url &&
    (m.message_type === 'image' ||
      m.message_type === 'video' ||
      m.message_type === 'sticker');
  const pureMedia = visualMedia && !hasCaption && !m.context_message;

  const location =
    m.message_type === 'text' && m.content ? parseLocation(m.content) : null;
  const contacts =
    m.message_type === 'text' && m.content && !location
      ? parseContacts(m.content)
      : null;
  const unsupported =
    m.content && !isMedia ? m.content.trim().match(UNSUPPORTED_RE) : null;

  const hasRenderable =
    isMedia || !!m.context_message || !!(m.content && m.content.trim());

  const startX = useRef(0);
  const startY = useRef(0);
  const swiping = useRef(false);
  const [dx, setDx] = useState(0);
  const SWIPE_TRIGGER = 56;
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Early-out AFTER every hook above (rules of hooks).
  if (!hasRenderable) return null;

  // Unknown / edited / deleted message → a quiet centred system row instead of
  // a bubble that reads "(unsupported: x)".
  if (unsupported) {
    const kind = unsupported[1];
    const text =
      kind === 'unsupported'
        ? 'The customer sent a message type WhatsApp doesn’t share with business apps (e.g. a poll, an edit or a deleted message).'
        : `Unsupported WhatsApp message (${kind}).`;
    return (
      <div id={`msg-${m.id}`} className="my-2 flex justify-center">
        <span className="max-w-[85%] rounded-lg border border-dashed border-line bg-surface px-3 py-1.5 text-center text-xs text-muted">
          {text} · {fmtTime(m.timestamp || m.created_at)}
        </span>
      </div>
    );
  }

  const clearPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    startX.current = t.clientX;
    startY.current = t.clientY;
    swiping.current = false;
    clearPress();
    pressTimer.current = setTimeout(() => setMenu(true), 500);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const ddx = t.clientX - startX.current;
    const ddy = t.clientY - startY.current;
    if (Math.abs(ddx) > 8 || Math.abs(ddy) > 8) clearPress();
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
    clearPress();
    if (dx >= SWIPE_TRIGGER) onReply();
    setDx(0);
    swiping.current = false;
  };

  const reactions = [
    m.reaction ? { e: m.reaction, who: 'Customer' } : null,
    m.agent_reaction ? { e: m.agent_reaction, who: 'Your team' } : null,
  ].filter((x): x is { e: string; who: string } => !!x);

  const timeRow = (
    <span className="flex items-center gap-1">
      {fmtTime(m.timestamp || m.created_at)}
      <Ticks m={m} />
    </span>
  );

  // Desktop hover/focus action bar, OUTSIDE the bubble (WhatsApp-Web style).
  const actionBar = !failed && m.status !== 'sending' && (
    <div
      className={cn(
        'relative hidden shrink-0 items-center gap-0.5 self-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 md:flex',
        (reactOpen || menu) && 'opacity-100',
      )}
    >
      {canReact && m.id > 0 && (
        <button
          type="button"
          onClick={() => setReactOpen((o) => !o)}
          aria-label="React to message"
          aria-expanded={reactOpen}
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-ink"
        >
          <Smile size={17} />
        </button>
      )}
      <button
        type="button"
        onClick={onReply}
        aria-label="Reply"
        className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-ink"
      >
        <CornerUpLeft size={17} />
      </button>
      {reactOpen && (
        <div
          className={cn(
            'absolute bottom-full z-40 mb-1 flex gap-0.5 rounded-full border border-line bg-surface p-1 shadow-lg',
            out ? 'right-0' : 'left-0',
          )}
          role="menu"
          aria-label="Reactions"
        >
          {QUICK_REACTIONS.map((e) => (
            <button
              key={e}
              type="button"
              role="menuitem"
              onClick={() => {
                setReactOpen(false);
                onReact(m.agent_reaction === e ? '' : e);
              }}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full text-lg hover:bg-sunken',
                m.agent_reaction === e && 'bg-brand-50',
              )}
              aria-label={m.agent_reaction === e ? `Remove ${e} reaction` : `React ${e}`}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div
      id={`msg-${m.id}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onMouseLeave={() => setReactOpen(false)}
      className={cn(
        'group relative flex items-end gap-1 rounded-lg transition-shadow [-webkit-touch-callout:none]',
        out ? 'justify-end' : 'justify-start',
        groupStart ? 'mt-2' : 'mt-0.5',
        reactions.length ? 'mb-3' : '',
        menu ? 'z-40' : '',
      )}
    >
      <span
        className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 text-brand-600"
        style={{ opacity: Math.min(dx / SWIPE_TRIGGER, 1) }}
        aria-hidden
      >
        <CornerUpLeft size={18} />
      </span>
      {out && actionBar}
      <div
        style={{
          transform: dx ? `translateX(${dx}px)` : undefined,
          transition: dx ? 'none' : 'transform .15s ease-out',
        }}
        className={cn(
          'relative rounded-2xl text-sm shadow-[0_1px_0.5px_rgba(0,0,0,0.08)]',
          isMedia ? 'max-w-[20rem] sm:max-w-[22.5rem]' : 'max-w-[78%] md:max-w-[65%]',
          pureMedia ? 'p-[3px]' : 'px-3 py-1.5',
          out ? 'bubble-out' : 'bg-surface text-ink',
          groupStart && (out ? 'rounded-tr-sm' : 'rounded-tl-sm'),
          failed && 'ring-1 ring-red-300',
        )}
      >
        {groupStart && senderLabel && !pureMedia && (
          <div
            className={cn(
              'mb-0.5 flex items-center gap-1 text-xs font-semibold',
              senderLabel.startsWith('Automation')
                ? 'text-violet-700'
                : senderLabel.startsWith('Broadcast')
                  ? 'text-sky-700'
                  : 'text-brand-700',
            )}
          >
            {senderLabel.startsWith('Automation') && <Bot size={12} aria-hidden />}
            {senderLabel}
          </div>
        )}
        <BubbleMenu
          out={out}
          open={menu}
          setOpen={setMenu}
          onReply={onReply}
          onCopy={onCopy}
          canCopy={canCopy}
          showTranscript={showTranscript}
          hasTranscript={!!transcript}
          transcribing={transcribing}
          onTranscript={openTranscript}
          downloadUrl={canDownload ? url : undefined}
          onInfo={() => setInfoOpen(true)}
          onRetry={failed ? onRetry : undefined}
        />
        {m.context_message && (
          <ContextQuote ctx={m.context_message} out={out} onJump={onJump} />
        )}
        {isMedia && m.media_expired && (
          <div className="mb-1 text-xs italic text-muted">
            Media expired (kept for 30 days)
          </div>
        )}
        {isMedia && !m.media_expired && url && (
          <div className={cn('relative', pureMedia ? '' : 'mb-1')}>
            {m.message_type === 'image' && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageThumbSrc ?? undefined}
                alt={
                  hasCaption
                    ? m.content!.slice(0, 120)
                    : `Photo ${out ? 'sent' : 'from customer'} at ${fmtTime(m.timestamp || m.created_at)}`
                }
                decoding="async"
                loading="lazy"
                onError={(e) => {
                  if (e.currentTarget.src !== url) e.currentTarget.src = url;
                }}
                onClick={() => onOpenImage(m.id)}
                className={cn(
                  'block w-full max-h-96 cursor-zoom-in bg-white object-contain',
                  pureMedia ? 'rounded-[0.8rem]' : 'rounded-lg',
                )}
              />
            )}
            {m.message_type === 'sticker' && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt="Sticker"
                  decoding="async"
                  loading="lazy"
                  onClick={() => setZoomSticker(true)}
                  className="max-h-32 max-w-[8rem] cursor-zoom-in"
                />
                {zoomSticker && (
                  <ImageGallery
                    images={[{ id: m.id, src: url, at: m.timestamp || m.created_at, fromCustomer: !out }]}
                    startId={m.id}
                    onClose={() => setZoomSticker(false)}
                  />
                )}
              </>
            )}
            {m.message_type === 'video' && (
              <video
                src={url}
                controls
                preload="none"
                playsInline
                className="min-h-[10rem] max-w-full rounded-lg bg-black/90"
              />
            )}
            {m.message_type === 'audio' && (
              <>
                {/* Outbound bubbles are now LIGHT, so the player uses its
                    light-background palette for both directions. */}
                <AudioMessage
                  src={url}
                  out={false}
                  messageId={m.id}
                  nextAudioId={nextAudioId}
                  trailing={timeRow}
                />
                {transcriptOpen && transcript && (
                  <div className="mt-2 overflow-hidden rounded-lg border border-line bg-surface text-left">
                    <div className="flex items-center justify-between border-b border-line bg-sunken px-3 py-1.5">
                      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                        <FileText size={13} /> Transcript
                      </span>
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={copyTranscript}
                          aria-label="Copy transcript"
                          className="rounded p-1 text-muted hover:bg-sunken"
                        >
                          <Copy size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setTranscriptOpen(false)}
                          aria-label="Close transcript"
                          className="rounded p-1 text-muted hover:bg-sunken"
                        >
                          <X size={15} />
                        </button>
                      </div>
                    </div>
                    <p className="max-h-64 overflow-y-auto whitespace-pre-wrap px-3 py-2.5 text-[15px] leading-relaxed text-ink">
                      {transcript}
                    </p>
                  </div>
                )}
              </>
            )}
            {m.message_type === 'document' && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-[14rem] items-center gap-3 rounded-lg bg-black/5 px-3 py-2.5 hover:bg-black/10"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface text-brand-700">
                  <FileText size={20} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {fileNameOf(m)}
                  </span>
                  <span className="block text-xs uppercase text-muted">
                    {(fileNameOf(m).split('.').pop() || 'file').slice(0, 5)} · Open
                  </span>
                </span>
                <Download size={16} className="shrink-0 text-muted" aria-hidden />
              </a>
            )}
            {pureMedia && (
              <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-full bg-black/50 px-1.5 py-[1px] text-xs text-white">
                {fmtTime(m.timestamp || m.created_at)}
                <Ticks m={m} onDark />
              </span>
            )}
          </div>
        )}
        {location ? (
          <a
            href={
              location.lat && location.lng
                ? `https://www.google.com/maps?q=${location.lat},${location.lng}`
                : `https://www.google.com/maps/search/${encodeURIComponent(location.label)}`
            }
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-w-[14rem] items-center gap-3 rounded-lg bg-black/5 px-3 py-2.5 hover:bg-black/10"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface text-red-600">
              <MapPin size={20} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">{location.label}</span>
              {location.lat && (
                <span className="block text-xs tabular-nums text-muted">
                  {location.lat}, {location.lng}
                </span>
              )}
            </span>
            <span className="shrink-0 text-xs font-semibold text-brand-700">Open map</span>
          </a>
        ) : contacts && contacts.length ? (
          <div className="flex min-w-[14rem] flex-col gap-1.5">
            {contacts.map((ct, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg bg-black/5 px-3 py-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface text-brand-700">
                  <UserRound size={18} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{ct.name}</span>
                  {ct.phone && <span className="block text-xs tabular-nums text-muted">{ct.phone}</span>}
                </span>
                {ct.phone && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(ct.phone!);
                        toast.success('Number copied');
                      } catch {
                        toast.error('Could not copy');
                      }
                    }}
                    className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-brand-700 hover:bg-surface"
                  >
                    Copy
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          (() => {
            const { text, buttons } =
              m.message_type === 'template' && m.content
                ? splitTemplateButtons(m.content)
                : { text: m.content ?? '', buttons: [] };
            return (
              <>
                {m.message_type === 'template' && (
                  <span className="mb-0.5 inline-flex items-center gap-1 rounded bg-black/5 px-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                    <LayoutTemplate size={11} aria-hidden /> Template
                  </span>
                )}
                {text && <ExpandableText text={text} out={out} />}
                {buttons.length > 0 && (
                  <div className="-mx-1 mt-2 flex flex-col gap-1 border-t border-black/10 pt-2">
                    {buttons.map((b, bi) => (
                      <span
                        key={bi}
                        className="rounded-md bg-surface/70 px-3 py-1.5 text-center text-sm font-semibold text-sky-700"
                      >
                        {b}
                      </span>
                    ))}
                  </div>
                )}
              </>
            );
          })()
        )}
        {m.message_type === 'text' &&
          m.content &&
          !location &&
          !contacts &&
          extractUrls(m.content).map((u) => <OgPreviewCard key={u} url={u} />)}
        {m.message_type !== 'audio' && !pureMedia && (
          <div className="mt-0.5 flex items-center justify-end gap-1 text-xs text-muted">
            {timeRow}
          </div>
        )}
        {failed && (
          <div className="mt-1.5 flex flex-col gap-1.5 border-t border-red-200 pt-1.5 text-xs text-red-700">
            <span>
              <strong className="font-semibold">Not delivered.</strong>{' '}
              {failReason ?? 'WhatsApp did not accept this message.'}
            </span>
            <span className="flex gap-1.5">
              {m.message_type !== 'template' && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-surface px-2 py-1 font-semibold text-red-700 hover:bg-red-50"
                >
                  <RotateCcw size={12} /> Retry
                </button>
              )}
              <button
                type="button"
                onClick={onDelete}
                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-surface px-2 py-1 font-semibold text-red-700 hover:bg-red-50"
              >
                <Trash2 size={12} /> Delete
              </button>
            </span>
          </div>
        )}
        {reactions.length > 0 && (
          <span
            className={cn(
              'absolute -bottom-3.5 z-10 flex h-6 items-center gap-0.5 rounded-full border border-line bg-surface px-1.5 text-sm leading-none shadow-sm',
              out ? 'right-2' : 'left-2',
            )}
            title={reactions.map((r) => `${r.who}: ${r.e}`).join(' · ')}
          >
            {reactions.map((r) => (
              <span key={r.who}>{r.e}</span>
            ))}
          </span>
        )}
      </div>
      {!out && actionBar}
      <Modal open={infoOpen} onClose={() => setInfoOpen(false)} title="Message info">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">From</dt>
          <dd className="text-ink">
            {out ? senderLabelOf(m, undefined) ?? 'Your team' : 'Customer'}
          </dd>
          <dt className="text-muted">Type</dt>
          <dd className="capitalize text-ink">{m.message_type}</dd>
          <dt className="text-muted">{out ? 'Sent' : 'Received'}</dt>
          <dd className="text-ink">{new Date(m.timestamp || m.created_at).toLocaleString()}</dd>
          {out && (
            <>
              <dt className="text-muted">Status</dt>
              <dd className="capitalize text-ink">{m.status === 'played' ? 'Played' : m.status}</dd>
            </>
          )}
          {!out && m.read_at && (
            <>
              <dt className="text-muted">Read by team</dt>
              <dd className="text-ink">{new Date(m.read_at).toLocaleString()}</dd>
            </>
          )}
          {failReason && (
            <>
              <dt className="text-muted">Error</dt>
              <dd className="text-red-700">{failReason}</dd>
            </>
          )}
          {reactions.map((r) => (
            <div key={r.who} className="contents">
              <dt className="text-muted">{r.who} reacted</dt>
              <dd>{r.e}</dd>
            </div>
          ))}
        </dl>
      </Modal>
    </div>
  );
}

/**
 * Per-message actions menu. WhatsApp-style: a chevron sits in the bubble's
 * top-right corner (appears on hover / when open; long-press opens it on
 * mobile). Carries Reply, Copy (text), Download (media), and — for voice
 * notes — View transcript / Transcribe at the top.
 */
function BubbleMenu({
  out,
  open,
  setOpen,
  onReply,
  onCopy,
  canCopy,
  showTranscript,
  hasTranscript,
  transcribing,
  onTranscript,
  downloadUrl,
  onInfo,
  onRetry,
}: {
  out: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  onReply: () => void;
  onCopy: () => void;
  canCopy: boolean;
  showTranscript: boolean;
  hasTranscript: boolean;
  transcribing: boolean;
  onTranscript: () => void;
  downloadUrl?: string;
  onInfo: () => void;
  onRetry?: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  // When the message sits near the bottom of the thread, open the dropdown
  // UPWARD so it isn't clipped by the scroll container / composer (the bottom
  // voice note's menu otherwise lands flush against — or under — the edge).
  const [dropUp, setDropUp] = useState(false);
  // Close on outside-click or on a genuine USER scroll gesture — WITHOUT a
  // full-screen overlay. The previous `fixed inset-0` click-catcher swallowed
  // wheel/touch so the list couldn't scroll while open; that's fixed. But we
  // must NOT listen to the generic capture-phase `scroll` event: on a busy
  // account it fires for background activity (the live conversation list, an
  // auto-scroll to a new message, any programmatic scroll) and snapped this
  // menu shut on its own — so the chevron felt broken / the Transcribe action
  // was un-clickable. `wheel` + `touchmove` fire ONLY on real user intent, so
  // the menu is stable and still dismisses the instant the user scrolls.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onUserScroll = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('wheel', onUserScroll, { capture: true, passive: true });
    window.addEventListener('touchmove', onUserScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('wheel', onUserScroll, true);
      window.removeEventListener('touchmove', onUserScroll, true);
    };
  }, [open, setOpen]);

  // Decide open direction the moment the menu opens, from live geometry.
  useEffect(() => {
    if (!open) {
      setDropUp(false);
      return;
    }
    const btn = menuRef.current?.querySelector('button');
    const scroller = menuRef.current?.closest('.overflow-y-auto');
    if (!btn || !scroller) return;
    const spaceBelow =
      scroller.getBoundingClientRect().bottom - btn.getBoundingClientRect().bottom;
    // ~4 items + padding ≈ 170px; flip up when there isn't room below.
    setDropUp(spaceBelow < 180);
  }, [open]);

  return (
    <div
      ref={menuRef}
      className={cn(
        'absolute top-0.5 z-30',
        out ? 'right-0.5' : 'right-0.5',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="Message actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full bg-inherit text-muted shadow-sm transition-opacity hover:text-ink',
          open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        )}
      >
        <ChevronDown size={16} />
      </button>
      {open && (
        <>
          <div
            className={cn(
              'absolute right-0 z-30 w-48 rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg',
              dropUp ? 'bottom-6' : 'top-6',
            )}
          >
            {showTranscript && (
              <button
                type="button"
                onClick={() => {
                  onTranscript();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-medium text-green-700 hover:bg-gray-50"
              >
                <FileText size={14} />
                {transcribing
                  ? 'Transcribing…'
                  : hasTranscript
                    ? 'View transcript'
                    : 'Transcribe voice note'}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onReply();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50"
            >
              <CornerUpLeft size={14} /> Reply
            </button>
            {canCopy && (
              <button
                type="button"
                onClick={() => {
                  onCopy();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50"
              >
                <Copy size={14} /> Copy
              </button>
            )}
            {downloadUrl && (
              <a
                href={downloadUrl}
                download
                onClick={() => setOpen(false)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50"
              >
                <Download size={14} /> Download
              </a>
            )}
            {onRetry && (
              <button
                type="button"
                onClick={() => {
                  onRetry();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-700 hover:bg-gray-50"
              >
                <RotateCcw size={14} /> Retry sending
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onInfo();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50"
            >
              <Info size={14} /> Message info
            </button>
          </div>
        </>
      )}
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

  // Every {{n}} must be filled — Meta rejects a template with an empty param.
  const missing = varNames.filter((v) => !(vars[v] ?? '').trim());
  const [query, setQuery] = useState('');
  const shown = tpls.filter(
    (t) => !query.trim() || t.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Send a template"
      footer={
        <div className="flex items-center justify-end gap-3">
          {sel && missing.length > 0 && (
            <span className="mr-auto text-xs text-amber-700">
              Fill {missing.map((v) => `{{${v}}}`).join(', ')} to send
            </span>
          )}
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-muted hover:bg-sunken">
            Cancel
          </button>
          <button
            onClick={send}
            disabled={!sel || busy || missing.length > 0}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send template'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted">Loading templates…</p>
        ) : tpls.length === 0 ? (
          <p className="text-sm text-muted">No approved templates available.</p>
        ) : (
          <>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates"
              aria-label="Search templates"
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <ul className="max-h-48 space-y-1 overflow-y-auto" role="listbox" aria-label="Templates">
              {shown.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={sel?.id === t.id}
                    onClick={() => {
                      setSel(t);
                      setVars({});
                    }}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm',
                      sel?.id === t.id ? 'border-brand-600 bg-brand-50' : 'border-line hover:bg-sunken',
                    )}
                  >
                    <span className="truncate font-medium">{t.name}</span>
                    <span className="shrink-0 text-xs capitalize text-muted">{t.category.toLowerCase()}</span>
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="px-1 text-xs text-muted">No match.</li>}
            </ul>
          </>
        )}

        {sel && varNames.length > 0 && (
          <div className="space-y-2">
            {varNames.map((v) => (
              <div key={v}>
                <label htmlFor={`tpl-var-${v}`} className="mb-1 block text-xs text-muted">
                  Variable {`{{${v}}}`}
                </label>
                <input
                  id={`tpl-var-${v}`}
                  value={vars[v] ?? ''}
                  onChange={(e) => setVars((cur) => ({ ...cur, [v]: e.target.value }))}
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
                />
              </div>
            ))}
          </div>
        )}

        {sel && (
          <div className="rounded-lg border border-line bg-sunken p-3 text-sm text-ink">
            <p className="mb-1 text-xs text-muted">Preview</p>
            <p className="whitespace-pre-wrap">{preview}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

// Emoji per ticket type for the visual create picker.
const TICKET_TYPE_ICON: Record<string, string> = {
  return: '↩️',
  refund: '💸',
  exchange: '🔁',
  damaged: '💥',
  wrong_item: '📦',
  missing: '❓',
  complaint: '💬',
  other: '⋯',
};

/**
 * Header ticket control: shows a chip linking to the open ticket for this chat,
 * or a "Create ticket" button (manual ticketing) when there's none.
 */
function OpenTicketChip({
  conversationId,
  openSignal = 0,
  orders,
  lastInboundText,
  members,
}: {
  conversationId: number;
  /** Bumped by the parent (e.g. the mobile kebab menu) to open the ticket flow
   *  from outside — the chip itself is desktop-only. */
  openSignal?: number;
  /** The contact's orders — the create form links by tapping one (not typing). */
  orders?: ContactOrders | null;
  /** Last inbound message text — seeds the description. */
  lastInboundText?: string | null;
  /** Team members for the assignee picker. */
  members?: TeamMember[];
}) {
  const toast = useToast();
  const { user } = useAuth();
  const [ticket, setTicket] = useState<TicketListItem | null>(null);
  const [open, setOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [type, setType] = useState<string>('');
  const [desc, setDesc] = useState('');
  const [order, setOrder] = useState('');
  const [manualOrder, setManualOrder] = useState(false);
  const [assignId, setAssignId] = useState<number | null>(null);
  const [priority, setPriority] = useState<'normal' | 'high'>('normal');
  const [saving, setSaving] = useState(false);

  // External trigger (mobile menu): open the existing ticket, or the create form.
  useEffect(() => {
    if (openSignal <= 0) return;
    if (ticket) setDetailOpen(true);
    else setOpen(true);
  }, [openSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // On opening the create form: seed the description from the last customer
  // message, default the assignee to the current agent (auto-assign), and — when
  // the contact has exactly one order — pre-link it.
  useEffect(() => {
    if (!open) return;
    setDesc((d) => d || (lastInboundText ?? ''));
    setAssignId((a) => a ?? user?.id ?? null);
    if (orders && orders.count === 1 && orders.orders[0]?.orderName) {
      setOrder((o) => o || orders.orders[0].orderName!);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => {
    if (!Number.isFinite(conversationId)) return;
    getOpenTicketForConversation(conversationId)
      .then(setTicket)
      .catch(() => undefined);
  }, [conversationId]);

  useEffect(() => {
    let alive = true;
    if (!Number.isFinite(conversationId)) return;
    getOpenTicketForConversation(conversationId)
      .then((t) => {
        if (alive) setTicket(t);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [conversationId]);

  const submit = async () => {
    if (!type) return;
    setSaving(true);
    try {
      await createTicket({
        conversationId,
        type,
        description: desc.trim() || undefined,
        linkedOrderName: order.trim() || undefined,
        assignedUserId: assignId ?? undefined,
        priority,
      });
      setOpen(false);
      setDesc('');
      setOrder('');
      setManualOrder(false);
      setType('');
      setPriority('normal');
      reload();
      toast.success('Ticket created');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to create ticket');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {ticket ? (
        <button
          type="button"
          onClick={() => setDetailOpen(true)}
          title={`Open ticket ${ticket.ticket_number}`}
          className={cn(
            'hidden xl:inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full shrink-0 hover:brightness-95',
            ticketStatusColor(ticket.status),
          )}
        >
          <LifeBuoy size={13} /> {ticket.ticket_number} ·{' '}
          {ticketStatusLabel(ticket.status)}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Create a support ticket for this chat"
          className="hidden xl:inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full shrink-0 bg-gray-100 text-gray-600 hover:bg-gray-200"
        >
          <LifeBuoy size={13} /> Ticket
        </button>
      )}

      {detailOpen && ticket && (
        <TicketDetailModal
          id={ticket.id}
          onClose={() => setDetailOpen(false)}
          onChanged={reload}
        />
      )}

      {open && (
        <Modal open onClose={() => setOpen(false)} title="New ticket">
          <div className="p-5 space-y-4">
            {/* Type — visual picker */}
            <div>
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                Type
              </label>
              <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                {TICKET_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-lg border py-2 text-[10.5px] font-semibold transition',
                      type === t
                        ? 'border-green-600 bg-green-50 text-green-800'
                        : 'border-gray-200 text-gray-500 hover:border-gray-300',
                    )}
                  >
                    <span className="text-base leading-none">{TICKET_TYPE_ICON[t]}</span>
                    {ticketTypeLabel(t)}
                  </button>
                ))}
              </div>
            </div>

            {/* Order — tap the contact's real orders */}
            <div>
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                Which order?
              </label>
              {orders && orders.count > 0 && !manualOrder ? (
                <div className="mt-1.5 space-y-1.5">
                  {orders.orders.slice(0, 4).map((o) => {
                    const on = order === o.orderName;
                    return (
                      <button
                        key={o.orderGid}
                        type="button"
                        onClick={() => setOrder(on ? '' : o.orderName ?? '')}
                        className={cn(
                          'w-full flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition',
                          on ? 'border-green-600 bg-green-50' : 'border-gray-200 hover:border-gray-300',
                        )}
                      >
                        <span
                          className={cn(
                            'w-3.5 h-3.5 rounded-full border-2 shrink-0',
                            on ? 'border-green-600 bg-green-600 ring-2 ring-inset ring-white' : 'border-gray-300',
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-semibold text-gray-900 truncate">
                            {o.orderName}
                            {o.total != null && (
                              <span className="ml-1.5 font-normal text-gray-500">
                                {o.currency ? o.currency + ' ' : ''}
                                {o.total.toLocaleString()}
                              </span>
                            )}
                          </span>
                          {o.itemsSummary && (
                            <span className="block text-xs text-gray-500 truncate">{o.itemsSummary}</span>
                          )}
                        </span>
                        <span className={cn('text-[10px] px-2 py-0.5 rounded-full shrink-0', orderStatusTone(o))}>
                          {orderDisplayStatus(o)}
                        </span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => {
                      setManualOrder(true);
                      setOrder('');
                    }}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    Not listed? Enter an order # manually
                  </button>
                </div>
              ) : (
                <div className="mt-1.5">
                  <input
                    value={order}
                    onChange={(e) => setOrder(e.target.value)}
                    placeholder="Order # (optional) — e.g. 1042"
                    className="block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  />
                  {orders && orders.count > 0 && (
                    <button
                      type="button"
                      onClick={() => setManualOrder(false)}
                      className="mt-1 text-xs text-gray-400 hover:text-gray-600"
                    >
                      ‹ Back to the customer&apos;s orders
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Description */}
            <div>
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                Description
              </label>
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                rows={2}
                placeholder="What's the issue?"
                className="mt-1.5 block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
              {lastInboundText && desc === lastInboundText && (
                <p className="text-xs text-gray-400 mt-1">↳ from the last customer message · edit freely</p>
              )}
            </div>

            {/* Assign + priority */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Assign</label>
                <select
                  value={assignId ?? ''}
                  onChange={(e) => setAssignId(e.target.value ? Number(e.target.value) : null)}
                  className="mt-1.5 block w-full rounded-lg border border-gray-200 px-2.5 py-2 text-sm"
                >
                  <option value={user?.id ?? ''}>Me{user?.name ? ` (${user.name})` : ''}</option>
                  {(members ?? [])
                    .filter((m) => m.status === 'active' && m.id !== user?.id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Priority</label>
                <div className="mt-1.5 flex gap-1.5">
                  {(['normal', 'high'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p)}
                      className={cn(
                        'flex-1 rounded-lg border py-2 text-xs font-semibold capitalize transition',
                        priority === p
                          ? p === 'high'
                            ? 'border-rose-500 bg-rose-50 text-rose-700'
                            : 'border-green-600 bg-green-50 text-green-800'
                          : 'border-gray-200 text-gray-500 hover:border-gray-300',
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setOpen(false)} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={saving || !type}
                className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg disabled:opacity-50"
              >
                {saving ? 'Creating…' : 'Create & notify customer'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function isStaleTemp(m: Message): boolean {
  return (
    m.id < 0 &&
    m.status === 'sending' &&
    Date.now() - new Date(m.created_at).getTime() > STALE_SEND_MS
  );
}
function expireStaleTemps(list: Message[]): Message[] {
  if (!list.some(isStaleTemp)) return list;
  return list.map((m) =>
    isStaleTemp(m)
      ? {
          ...m,
          status: 'failed' as const,
          error: 'Not confirmed — check your connection, then retry or delete.',
        }
      : m,
  );
}
