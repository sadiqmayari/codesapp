'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, Share, PlusSquare, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Install-the-app (PWA) helper banner.
 *
 * On Android / desktop Chrome & Edge the browser surfaces its own "Install"
 * option (address-bar icon + ⋮ menu) via the `beforeinstallprompt` event; we
 * also mirror that as an in-app button when the event fires.
 *
 * Apple is the reason this component exists: iOS/iPadOS Safari and macOS Safari
 * NEVER fire `beforeinstallprompt` and Apple does not add an "Install" menu
 * entry — the only way in is the manual Share → "Add to Home Screen" (iOS) /
 * "Add to Dock" (macOS Safari). So for Apple users we can't auto-prompt; we show
 * a short instruction card pointing them at that hidden menu item.
 *
 * Renders nothing when: already running installed (standalone / added to
 * home screen), dismissed this device, or there is nothing useful to show
 * (e.g. non-Safari iOS browsers which cannot install at all).
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const DISMISS_KEY = 'ca_install_dismissed';

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // Android/desktop installed PWAs match this; iOS uses navigator.standalone.
  const mql = window.matchMedia?.('(display-mode: standalone)').matches;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean })
    .standalone;
  return Boolean(mql || iosStandalone);
}

type Platform = 'ios-safari' | 'mac-safari' | 'other';

/** Detect iOS/iPadOS Safari and macOS Safari (the no-auto-prompt platforms). */
function detectApplePlatform(): Platform {
  if (typeof window === 'undefined') return 'other';
  const ua = window.navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as a Mac but is touch-capable.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Chrome/Firefox/Edge on iOS are all WebKit but carry CriOS/FxiOS/EdgiOS —
  // and crucially they CANNOT "Add to Home Screen"; only real Safari can.
  const isIosSafari =
    isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  if (isIosSafari) return 'ios-safari';

  const isMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints <= 1;
  const isMacSafari =
    isMac &&
    /Safari/.test(ua) &&
    !/Chrome|Chromium|CriOS|Edg|OPR/.test(ua);
  if (isMacSafari) return 'mac-safari';

  return 'other';
}

export function InstallAppBanner() {
  const [platform, setPlatform] = useState<Platform>('other');
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [dismissed, setDismissed] = useState(true); // assume hidden until mounted
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isStandalone()) return; // already installed → never show

    let wasDismissed = false;
    try {
      wasDismissed = window.localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      /* ignore */
    }
    setDismissed(wasDismissed);
    setPlatform(detectApplePlatform());

    const onBip = (e: Event) => {
      e.preventDefault(); // stop Chrome's mini-infobar; we drive it from a button
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      setDismissed(true);
    };
    window.addEventListener('beforeinstallprompt', onBip);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBip);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
  }, []);

  const runNativePrompt = useCallback(async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === 'accepted') dismiss();
    } catch {
      /* ignore */
    } finally {
      setDeferred(null);
    }
  }, [deferred, dismiss]);

  if (dismissed) return null;

  const isApple = platform === 'ios-safari' || platform === 'mac-safari';
  // Nothing to offer: a non-Apple platform that never fired the install event
  // (e.g. already installed via menu, or a browser that can't install).
  if (!isApple && !deferred) return null;

  return (
    <div
      role="status"
      className="w-full border-b border-green-200 bg-gradient-to-r from-green-50 to-emerald-50 text-green-900 text-sm px-4 py-2"
    >
      <div className="flex items-center gap-3">
        <Download size={16} className="text-green-700 shrink-0" />
        <div className="flex-1 min-w-0">
          <strong>Install CodesApp</strong>{' '}
          <span className="text-green-800/90">
            for a full-screen app experience with its own icon.
          </span>
        </div>

        {deferred ? (
          // Android / desktop Chrome & Edge: real one-tap install.
          <button
            onClick={runNativePrompt}
            className="shrink-0 rounded-md px-3 py-1 text-xs font-semibold bg-green-600 text-white hover:bg-green-700"
          >
            Install app
          </button>
        ) : (
          // Apple Safari: no auto-prompt exists — reveal the manual steps.
          <button
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 rounded-md px-3 py-1 text-xs font-semibold bg-white border border-green-300 text-green-800 hover:bg-green-50"
          >
            {expanded ? 'Hide steps' : 'How to install'}
          </button>
        )}

        <button
          onClick={dismiss}
          className="shrink-0 rounded-md p-1 hover:bg-green-200"
          aria-label="Dismiss"
          title="Don't show again"
        >
          <X size={14} />
        </button>
      </div>

      {isApple && expanded && (
        <div className="mt-2 pl-7 text-[13px] leading-relaxed text-green-900/90">
          {platform === 'ios-safari' ? (
            <ol className="space-y-1">
              <li className="flex items-center gap-2">
                <span className="font-semibold">1.</span>
                <span className="inline-flex items-center gap-1">
                  Tap the <Share size={14} className="inline" /> Share button in
                  Safari&apos;s toolbar.
                </span>
              </li>
              <li className="flex items-center gap-2">
                <span className="font-semibold">2.</span>
                <span className="inline-flex items-center gap-1">
                  Scroll down and choose{' '}
                  <PlusSquare size={14} className="inline" />{' '}
                  <strong>Add to Home Screen</strong>.
                </span>
              </li>
              <li className="flex items-center gap-2">
                <span className="font-semibold">3.</span>
                <span>
                  Tap <strong>Add</strong> — CodesApp appears on your home
                  screen.
                </span>
              </li>
            </ol>
          ) : (
            <ol className="space-y-1">
              <li className="flex items-center gap-2">
                <span className="font-semibold">1.</span>
                <span className="inline-flex items-center gap-1">
                  In Safari, click the <Share size={14} className="inline" />{' '}
                  Share button (or the <strong>File</strong> menu).
                </span>
              </li>
              <li className="flex items-center gap-2">
                <span className="font-semibold">2.</span>
                <span>
                  Choose <strong>Add to Dock</strong>.
                </span>
              </li>
              <li className="flex items-center gap-2">
                <span className="font-semibold">3.</span>
                <span>
                  Click <strong>Add</strong> — CodesApp opens as its own app.
                </span>
              </li>
            </ol>
          )}
          <p className="mt-1.5 text-[12px] text-green-800/70">
            {platform === 'ios-safari'
              ? 'On iPhone/iPad this only works in Safari (not Chrome or other browsers).'
              : 'Requires macOS Sonoma or later with Safari 17+.'}
          </p>
        </div>
      )}
    </div>
  );
}
