'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/context/auth-context';
import { SocketProvider, useSocket } from '@/context/socket-context';
import { apiFetch } from '@/lib/api';
import { Sidebar } from '@/components/app-shell/sidebar';
import { Navbar } from '@/components/app-shell/navbar';

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const onInbox = pathname.startsWith('/inbox');
  const onInboxRef = useRef(onInbox);
  onInboxRef.current = onInbox;

  useEffect(() => {
    if (onInbox) setUnread(0);
  }, [onInbox]);

  useEffect(() => {
    const offRecv = on('message.received', () => {
      if (!onInboxRef.current) setUnread((u) => u + 1);
    });
    const offRead = on('message.read.bulk', () => {
      setUnread((u) => (u > 0 ? u - 1 : 0));
    });
    return () => {
      offRecv();
      offRead();
    };
  }, [on]);

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
