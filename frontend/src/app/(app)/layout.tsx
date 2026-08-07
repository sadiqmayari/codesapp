'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/context/auth-context';
import { SocketProvider, useSocket } from '@/context/socket-context';
import { apiFetch, apiFetchEnvelope } from '@/lib/api';
import { Sidebar } from '@/components/app-shell/sidebar';
import { Navbar } from '@/components/app-shell/navbar';
import { BillingBlocked } from '@/components/billing-blocked';
import { UsageWarningBanner } from '@/components/usage-warning-banner';
import { NotificationGate } from '@/components/notification-gate';
import { playNotification } from '@/lib/notification-sound';
import {
  clearConversationNotification,
  showMessageNotification,
  showDmNotification,
  clearDmNotification,
} from '@/lib/notify';
import { getTeamUnread } from '@/lib/team-chat';
import type { AccountStatus } from '@/lib/crm-types';

function FullScreenSpinner({ label }: { label?: string }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 gap-3">
      <div className="w-10 h-10 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
      {label && <p className="text-gray-500 text-sm">{label}</p>}
    </div>
  );
}

function dmPreview(m?: { type?: string; content?: string | null }): string {
  if (!m) return 'New message';
  if (m.type === 'audio') return '🎤 Voice message';
  if (m.type === 'image') return '📷 Photo';
  if (m.type === 'file') return '📎 File';
  return m.content?.slice(0, 120) || 'New message';
}

interface OnboardingStatus {
  step: number;
  completed: boolean;
}

/** Short preview line for an OS notification body. */
function messagePreview(msg?: {
  content?: string | null;
  message_type?: string;
}): string {
  switch (msg?.message_type) {
    case 'image':
      return '🖼 Photo';
    case 'video':
      return '🎥 Video';
    case 'audio':
      return '🎤 Voice message';
    case 'document':
      return '📄 Document';
    case 'sticker':
      return 'Sticker';
    default:
      return (msg?.content ?? '').slice(0, 140) || 'New message';
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { on } = useSocket();
  const { user } = useAuth();
  const meId = user?.id ?? 0;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [teamUnread, setTeamUnread] = useState(0);
  // Phase 4.5: highest active usage-warning severity for the navbar pulse chip.
  const [usageSeverity, setUsageSeverity] = useState<
    'warn' | 'critical' | null
  >(null);

  // Default the sidebar open on desktop, closed on mobile. (Effect, not lazy
  // init, to avoid an SSR/client hydration mismatch.)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setSidebarOpen(window.matchMedia('(min-width: 768px)').matches);
    }
  }, []);

  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  // Authoritative unread-conversation count for the bell + Inbox badge. A single
  // coalesced number (no per-message toast spam). We bump it optimistically for
  // snappiness, then reconcile against the server (debounced) on every relevant
  // event so it never drifts.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshUnread = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      apiFetchEnvelope<unknown[]>('/inbox/conversations', {
        params: { status: 'unread', limit: 1 },
      })
        .then((env) => {
          const total =
            typeof env.meta?.total === 'number'
              ? (env.meta.total as number)
              : Array.isArray(env.data)
                ? env.data.length
                : 0;
          setUnread(total);
        })
        .catch(() => undefined);
    }, 600);
  }, []);

  useEffect(() => {
    refreshUnread(); // initial authoritative count
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refreshUnread]);

  useEffect(() => {
    const offRecv = on(
      'message.received',
      (p: {
        conversationId?: number;
        contactName?: string;
        message?: { content?: string | null; message_type?: string };
      }) => {
        // Notify unless the user is already looking at that thread.
        const onThisThread =
          p?.conversationId != null &&
          pathRef.current === `/inbox/${p.conversationId}`;
        if (!onThisThread) {
          setUnread((u) => u + 1); // optimistic bump; reconciled below
          // Sound + (when unfocused) a coalesced OS notification. NO in-app
          // toast — the bell count is the single in-app indicator now.
          playNotification();
          if (
            p?.conversationId != null &&
            typeof document !== 'undefined' &&
            !document.hasFocus()
          ) {
            showMessageNotification({
              conversationId: p.conversationId,
              title: p.contactName || 'New WhatsApp message',
              body: messagePreview(p.message),
            });
          }
        }
        refreshUnread();
      },
    );
    const offRead = on(
      'message.read.bulk',
      (p: { conversationId?: number }) => {
        if (p?.conversationId != null)
          clearConversationNotification(p.conversationId);
        refreshUnread();
      },
    );
    const offUpdated = on('conversation.updated', () => refreshUnread());
    return () => {
      offRecv();
      offRead();
      offUpdated();
    };
  }, [on, refreshUnread]);

  // Opening a thread clears its OS notification + running count.
  useEffect(() => {
    const m = pathname.match(/^\/inbox\/(\d+)/);
    if (m) clearConversationNotification(Number(m[1]));
  }, [pathname]);

  // ── Internal team-chat: unread badge + notifications ──
  const refreshTeamUnread = useCallback(() => {
    getTeamUnread()
      .then((r) => setTeamUnread(r.unread ?? 0))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshTeamUnread();
  }, [refreshTeamUnread]);

  useEffect(() => {
    const offMsg = on(
      'dm.message',
      (p: {
        threadId?: number;
        message?: { senderId?: number; type?: string; content?: string | null };
      }) => {
        if (p?.message && p.message.senderId !== meId) {
          const activeThread =
            typeof window !== 'undefined'
              ? new URLSearchParams(window.location.search).get('t')
              : null;
          const onThisThread =
            p.threadId != null &&
            pathRef.current.startsWith('/team-chat') &&
            activeThread === String(p.threadId);
          if (!onThisThread) {
            playNotification();
            if (
              p.threadId != null &&
              typeof document !== 'undefined' &&
              !document.hasFocus()
            ) {
              showDmNotification({
                threadId: p.threadId,
                title: 'New team message',
                body: dmPreview(p.message),
              });
            }
          }
        }
        refreshTeamUnread();
      },
    );
    const offRead = on('dm.read', () => refreshTeamUnread());
    return () => {
      offMsg();
      offRead();
    };
  }, [on, meId, refreshTeamUnread]);

  // Opening a team chat clears its OS notification.
  useEffect(() => {
    if (pathname.startsWith('/team-chat') && typeof window !== 'undefined') {
      const t = new URLSearchParams(window.location.search).get('t');
      if (t) clearDmNotification(Number(t));
    }
  }, [pathname]);

  return (
    // 100dvh (dynamic viewport) not h-screen/100vh: on mobile, 100vh includes
    // the area behind the browser's address bar, which pushed the chat
    // composer below the visible screen. dvh tracks the *visible* viewport so
    // the composer stays pinned on-screen and only the message list scrolls.
    <div className="h-[100dvh] overflow-hidden flex bg-gray-50">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        unread={unread}
        teamUnread={teamUnread}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <NotificationGate />
        <UsageWarningBanner onTopSeverityChange={setUsageSeverity} />
        <Navbar
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          unread={unread}
          usageSeverity={usageSeverity}
        />
        <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [gateState, setGateState] = useState<
    'checking' | 'ok' | 'redirecting'
  >('checking');
  const [billing, setBilling] = useState<
    'checking' | 'ok' | AccountStatus
  >('checking');

  // Auth gate: AuthProvider attempts a silent refresh on mount.
  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  // Billing gate: /billing/account-status is JWT-only (not TenantGuard'd)
  // so it still answers for a company suspended for non-payment. Takes
  // precedence over the onboarding gate. Fail-open on error.
  useEffect(() => {
    if (loading || !user) return;
    let cancelled = false;
    setBilling('checking');
    apiFetch<AccountStatus>('/billing/account-status', {
      noOnboardingRedirect: true,
    })
      .then((s) => {
        if (cancelled) return;
        setBilling(s.suspendedForBilling ? s : 'ok');
      })
      .catch(() => {
        if (!cancelled) setBilling('ok'); // fail-open: never trap the user
      });
    return () => {
      cancelled = true;
    };
  }, [loading, user]);

  // Onboarding gate. Runs ONCE after auth + the billing gate clear — NOT on
  // every navigation. The old version listed `pathname` in its deps and reset
  // gateState to 'checking' on every URL change, which made AppLayout return a
  // full-screen spinner and UNMOUNT the whole shell — including the live socket
  // and the conversation list — on every chat open. That caused the per-chat
  // "Reconnecting" flash, the flicker, and the Unread filter snapping back to
  // "All". `pathnameRef` lets the single check read the current path without
  // re-triggering; `onboardingCheckedRef` ensures it gates only once per
  // session so navigating between chats never tears the shell down.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const onboardingCheckedRef = useRef(false);

  useEffect(() => {
    if (loading || !user || billing !== 'ok') return;
    if (onboardingCheckedRef.current) return; // gate only once per session
    let cancelled = false;
    setGateState('checking');
    apiFetch<OnboardingStatus>('/onboarding/status', {
      noOnboardingRedirect: true,
    })
      .then((s) => {
        if (cancelled) return;
        onboardingCheckedRef.current = true;
        // Incomplete → queue the redirect, but still flip to 'ok' so the
        // /onboarding page (also under this layout) can render instead of
        // staying stuck on the spinner.
        if (!s.completed && pathnameRef.current !== '/onboarding') {
          router.replace('/onboarding');
        }
        setGateState('ok');
      })
      .catch(() => {
        if (cancelled) return;
        onboardingCheckedRef.current = true;
        setGateState('ok'); // fail-open: don't trap the user
      });
    return () => {
      cancelled = true;
    };
  }, [loading, user, billing, router]);

  if (loading) return <FullScreenSpinner label="Loading…" />;
  if (!user) return <FullScreenSpinner label="Redirecting to sign in…" />;
  if (billing === 'checking')
    return <FullScreenSpinner label="Checking account…" />;
  if (billing !== 'ok') return <BillingBlocked status={billing} />;
  if (gateState !== 'ok')
    return <FullScreenSpinner label="Checking workspace…" />;

  return (
    <SocketProvider>
      <Shell>{children}</Shell>
    </SocketProvider>
  );
}
