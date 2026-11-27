'use client';

import { sendAttendanceHeartbeat } from '@/lib/attendance';

// App-activity heartbeat while checked in: tells the server the person is still
// working so a forgotten check-out is credited at their LAST activity (extra
// hours count). One shared loop for the whole tab (ref-counted — the navbar
// chip and the reminder bar both use useMyToday). Sends at most every 5 min,
// only after real input (pointer / key / scroll / touch) and only while the tab
// is visible.

const SEND_EVERY_MS = 5 * 60_000;
const CHECK_EVERY_MS = 60_000;

let refs = 0;
let lastInput = 0;
let lastSent = 0;
let timer: ReturnType<typeof setInterval> | null = null;

const markInput = () => {
  lastInput = Date.now();
};

function maybeSend() {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (lastInput <= lastSent || now - lastSent < SEND_EVERY_MS) return;
  lastSent = now;
  sendAttendanceHeartbeat().catch(() => undefined);
}

const onVisible = () => {
  if (document.visibilityState === 'visible') {
    markInput();
    maybeSend();
  }
};

const EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;

/** Start the shared heartbeat; returns a stop function. */
export function startAttendanceHeartbeat(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  refs += 1;
  if (refs === 1) {
    for (const e of EVENTS) window.addEventListener(e, markInput, { passive: true, capture: true });
    document.addEventListener('visibilitychange', onVisible);
    timer = setInterval(maybeSend, CHECK_EVERY_MS);
    markInput();
    maybeSend();
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    refs -= 1;
    if (refs === 0) {
      for (const e of EVENTS) window.removeEventListener(e, markInput, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
