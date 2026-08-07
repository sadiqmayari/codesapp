// Desktop/OS notifications for incoming WhatsApp messages (WhatsApp Web-style).
// Fires while the app is open (any tab or the installed PWA). Uses the service
// worker's registration.showNotification so we get a tag (coalescing), a count,
// and an inline "Reply" action. No Web Push — see PROGRESS.

let swReg: ServiceWorkerRegistration | null = null;
const counts = new Map<number, number>();

export function notificationsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator
  );
}

export async function registerServiceWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js');
  } catch {
    /* SW registration is best-effort */
  }
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

async function getReg(): Promise<ServiceWorkerRegistration | null> {
  if (swReg) return swReg;
  try {
    swReg = (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    swReg = null;
  }
  return swReg;
}

/**
 * Show (or update) the OS notification for a conversation. Repeated messages
 * from the same conversation collapse into one notification whose body shows
 * the running count ("3 new messages").
 */
export async function showMessageNotification(opts: {
  conversationId: number;
  title: string;
  body: string;
}): Promise<void> {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  const reg = await getReg();
  if (!reg) return;

  const n = (counts.get(opts.conversationId) ?? 0) + 1;
  counts.set(opts.conversationId, n);
  const body = n > 1 ? `${n} new messages` : opts.body;

  const options = {
    body,
    tag: `conv:${opts.conversationId}`,
    renotify: true,
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: {
      conversationId: opts.conversationId,
      url: `/inbox/${opts.conversationId}`,
    },
    actions: [
      { action: 'reply', type: 'text', title: 'Reply', placeholder: 'Type a reply…' },
      { action: 'open', title: 'Open' },
    ],
  } as unknown as NotificationOptions;

  try {
    await reg.showNotification(opts.title, options);
  } catch {
    /* some browsers reject `actions` on desktop — ignore */
  }
}

/** Dismiss a conversation's notification + reset its unread count. */
export async function clearConversationNotification(
  conversationId: number,
): Promise<void> {
  counts.delete(conversationId);
  try {
    const reg = await getReg();
    const notes = await reg?.getNotifications({ tag: `conv:${conversationId}` });
    notes?.forEach((x) => x.close());
  } catch {
    /* ignore */
  }
}

const dmCounts = new Map<number, number>();

/** OS notification for a new INTERNAL team-chat message. Coalesced per thread;
 *  clicking it deep-links to /team-chat?t={threadId}. */
export async function showDmNotification(opts: {
  threadId: number;
  title: string;
  body: string;
}): Promise<void> {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  const reg = await getReg();
  if (!reg) return;

  const n = (dmCounts.get(opts.threadId) ?? 0) + 1;
  dmCounts.set(opts.threadId, n);
  const body = n > 1 ? `${n} new messages` : opts.body;

  const options = {
    body,
    tag: `dm:${opts.threadId}`,
    renotify: true,
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { url: `/team-chat?t=${opts.threadId}` },
    actions: [{ action: 'open', title: 'Open' }],
  } as unknown as NotificationOptions;

  try {
    await reg.showNotification(opts.title, options);
  } catch {
    /* ignore */
  }
}

/** Dismiss a team-chat thread's notification + reset its running count. */
export async function clearDmNotification(threadId: number): Promise<void> {
  dmCounts.delete(threadId);
  try {
    const reg = await getReg();
    const notes = await reg?.getNotifications({ tag: `dm:${threadId}` });
    notes?.forEach((x) => x.close());
  } catch {
    /* ignore */
  }
}
