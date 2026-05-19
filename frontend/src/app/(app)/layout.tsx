'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/context/auth-context';
import { SocketProvider, useSocket } from '@/context/socket-context';
import { apiFetch } from '@/lib/api';
import { useToast } from '@/components/toast';
import { Sidebar } from '@/components/app-shell/sidebar';
import { Navbar } from '@/components/app-shell/navbar';
import { BillingBlocked } from '@/components/billing-blocked';
import { playNotification } from '@/lib/notification-sound';
import type { AccountStatus } from '@/lib/crm-types';

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
          playNotification();
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

  // Onboarding gate. Skipped until the billing gate clears so a
  // suspended-for-billing owner never gets bounced to /onboarding.
  useEffect(() => {
    if (loading || !user || billing !== 'ok') return;
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
  }, [loading, user, pathname, router, billing]);

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
