/* CodesApp service worker.
 * Purpose: make the app an installable PWA and handle notification clicks +
 * inline "Reply" from the OS notification (WhatsApp-style). Notifications are
 * triggered by the open app (page calls registration.showNotification); this
 * SW only reacts to clicks/replies. No offline caching (the app needs the
 * network and a live socket anyway).
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// A no-op fetch handler keeps the SW "controlling" and satisfies installability.
self.addEventListener('fetch', () => {});

// Send an inline reply straight from the notification, without opening the app.
// Uses the httpOnly refresh cookie via /api/auth/refresh to mint an access
// token (the access token itself is never stored — same security model as the
// app), then posts the message.
async function sendReply(conversationId, text) {
  try {
    const r = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
    if (!r.ok) return false;
    const json = await r.json();
    const token = json && json.data && json.data.accessToken;
    if (!token) return false;
    const send = await fetch(
      '/api/inbox/conversations/' + conversationId + '/send',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({ type: 'text', content: text }),
      },
    );
    return send.ok;
  } catch (e) {
    return false;
  }
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  const conversationId = data.conversationId;
  const url = data.url || '/inbox' + (conversationId ? '/' + conversationId : '');

  // Inline reply (text was typed into the notification).
  if (event.action === 'reply' && event.reply && conversationId != null) {
    event.notification.close();
    event.waitUntil(
      sendReply(conversationId, event.reply.trim()).then((ok) => {
        if (!ok) {
          // Fall back to opening the chat so the agent can resend.
          return self.clients
            .matchAll({ type: 'window', includeUncontrolled: true })
            .then((cs) => {
              const c = cs[0];
              if (c) {
                c.focus();
                c.postMessage({ type: 'navigate', url });
              } else {
                self.clients.openWindow(url);
              }
            });
        }
      }),
    );
    return;
  }

  // Otherwise (body click or "Open"): focus an existing window or open one,
  // and navigate it to the conversation.
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientsArr) => {
        for (const client of clientsArr) {
          if ('focus' in client) {
            client.focus();
            client.postMessage({ type: 'navigate', url });
            return;
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
