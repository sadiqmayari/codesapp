'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/context/auth-context';
import { SocketProvider, useSocket } from '@/context/socket-context';
import { apiFetch } from '@/lib/api';
import { useToast } from '@/components/toast';
import { Sidebar } from '@/components/app-shell/sidebar';
import { Navbar } from '@/components/app-shell/navbar';

// Short notification beep via WebAudio — no asset file. No-ops if the
// browser blocks audio (e.g. before any user gesture).
let _audioCtx: AudioContext | null = null;
function playBeep() {
  if (typeof window === 'undefined') return;
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    _audioCtx = _audioCtx ?? new Ctx();
    const ctx = _audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
  } catch {
    /* audio blocked — silent */
  }
}

function FullScreenSpinner({ label }: { label?: string }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 gap-3">
      <div className="w-10 h-10 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
      {label && <p className="text-gray-500 text-sm">{label}</p>}
    </div>
  );
}

interface OnboardingStatus {
  step: number;
  completed: boolean;
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { on } = useSocket();
  const toast = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const onInbox = pathname.startsWith('/inbox');
  const onInboxRef = useRef(onInbox);
  onInboxRef.current = onInbox;
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  useEffect(() => {
    if (onInbox) setUnread(0);
  }, [onInbox]);

  useEffect(() => {
    const offRecv = on(
      'message.received',
      (p: { conversationId?: number }) => {
        if (!onInboxRef.current) setUnread((u) => u + 1);
        // Notify unless the user is already looking at that thread.
        const onThisThread =
          p?.conversationId != null &&
          pathRef.current === `/inbox/${p.conversationId}`;
        if (!onThisThread) {
          toast.info('New WhatsApp message received');
          playBeep();
        }
      },
    );
    const offRead = on('message.read.bulk', () => {
      setUnread((u) => (u > 0 ? u - 1 : 0));
    });
    return () => {
      offRecv();
      offRead();
    };
  }, [on, toast]);

  return (
    <div className="h-screen overflow-hidden flex bg-gray-50">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        unread={unread}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <Navbar onOpenSidebar={() => setSidebarOpen(true)} unread={unread} />
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

  // Auth gate: AuthProvider attempts a silent refresh on mount.
  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  // Onboarding gate.
  useEffect(() => {
    if (loading || !user) return;
    let cancelled = false;
    setGateState('checking');
    apiFetch<OnboardingStatus>('/onboarding/status', {
      noOnboardingRedirect: true,
    })
      .then((s) => {
        if (cancelled) return;
        if (!s.completed && pathname !== '/onboarding') {
          setGateState('redirecting');
          router.replace('/onboarding');
        } else {
          setGateState('ok');
        }
      })
      .catch(() => {
        if (!cancelled) setGateState('ok'); // fail-open: don't trap the user
      });
    return () => {
      cancelled = true;
    };
  }, [loading, user, pathname, router]);

  if (loading) return <FullScreenSpinner label="Loading…" />;
  if (!user) return <FullScreenSpinner label="Redirecting to sign in…" />;
  if (gateState !== 'ok')
    return <FullScreenSpinner label="Checking workspace…" />;

  return (
    <SocketProvider>
      <Shell>{children}</Shell>
    </SocketProvider>
  );
}
