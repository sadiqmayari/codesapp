'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, X } from 'lucide-react';
import {
  notificationPermission,
  registerServiceWorker,
  requestNotificationPermission,
} from '@/lib/notify';

const DISMISS_KEY = 'notif_prompt_dismissed';

/**
 * Registers the service worker (PWA + notification actions), routes inline
 * notification clicks coming back from the SW, and shows a one-time prompt to
 * enable desktop notifications. Renders only the (optional) prompt banner.
 */
export function NotificationGate() {
  const router = useRouter();
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(
    'default',
  );
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    registerServiceWorker();
    setPerm(notificationPermission());
    try {
      setDismissed(sessionStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      setDismissed(false);
    }

    // The SW asks us to navigate when a notification (or inline reply) is acted
    // on. Call router from inside the handler (never in a deps array).
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const onMsg = (e: MessageEvent) => {
        const d = e.data as { type?: string; url?: string } | undefined;
        if (d?.type === 'navigate' && d.url) router.push(d.url);
      };
      navigator.serviceWorker.addEventListener('message', onMsg);
      return () =>
        navigator.serviceWorker.removeEventListener('message', onMsg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enable = async () => {
    const res = await requestNotificationPermission();
    setPerm(res);
  };
  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
  };

  if (perm !== 'default' || dismissed) return null;

  return (
    <div className="flex items-center gap-3 bg-green-50 border-b border-green-200 px-4 py-2 text-sm">
      <Bell size={16} className="text-green-600 shrink-0" />
      <span className="text-green-800 flex-1">
        Get notified of new WhatsApp messages — even when this window is in the
        background.
      </span>
      <button
        onClick={enable}
        className="rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-medium px-3 py-1.5"
      >
        Enable notifications
      </button>
      <button
        onClick={dismiss}
        className="text-green-700 hover:text-green-900"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>
    </div>
  );
}
