'use client';

// In-browser softphone for WhatsApp Business Calling (self-hosted Asterisk SIP).
// Registers over WSS/WebRTC as the browser agent and drives call state. The UI
// lives in components/softphone/softphone-widget.tsx.
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/auth-context';

type SipCreds = {
  configured: boolean;
  wssUrl: string;
  realm: string;
  username: string;
  password: string;
};

export type CallState = 'idle' | 'ringing-in' | 'ringing-out' | 'in-call' | 'ended';

type ActiveCall = {
  direction: 'inbound' | 'outbound';
  peer: string; // display number
  startedAt: number | null; // answered timestamp
};

type SipApi = {
  ready: boolean; // registered to Asterisk
  available: boolean; // feature configured (creds present)
  state: CallState;
  call: ActiveCall | null;
  muted: boolean;
  placeCall: (number: string) => void;
  answer: () => void;
  hangup: () => void;
  toggleMute: () => void;
};

const SipContext = createContext<SipApi | null>(null);
export const useSip = () => useContext(SipContext);

export function SipProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [available, setAvailable] = useState(false);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<CallState>('idle');
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [muted, setMuted] = useState(false);

  const uaRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const credsRef = useRef<SipCreds | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Lazy <audio> sink for the remote stream.
  useEffect(() => {
    const el = document.createElement('audio');
    el.autoplay = true;
    (el as any).playsInline = true;
    el.style.display = 'none';
    document.body.appendChild(el);
    audioRef.current = el;
    return () => {
      el.remove();
    };
  }, []);

  const attachMedia = useCallback((session: any) => {
    try {
      const pc = session.connection;
      if (!pc) return;
      pc.addEventListener('track', (e: any) => {
        if (audioRef.current && e.streams && e.streams[0]) {
          audioRef.current.srcObject = e.streams[0];
        }
      });
    } catch {
      /* best-effort */
    }
  }, []);

  const wireSession = useCallback(
    (session: any, direction: 'inbound' | 'outbound', peer: string) => {
      sessionRef.current = session;
      setMuted(false);
      session.on('accepted', () => {
        setState('in-call');
        setCall((c) => (c ? { ...c, startedAt: Date.now() } : c));
      });
      session.on('confirmed', () => setState('in-call'));
      session.on('ended', () => {
        setState('ended');
        setCall(null);
        sessionRef.current = null;
        setTimeout(() => setState('idle'), 400);
      });
      session.on('failed', () => {
        setState('ended');
        setCall(null);
        sessionRef.current = null;
        setTimeout(() => setState('idle'), 600);
      });
      session.on('peerconnection', (e: any) => {
        try {
          e.peerconnection.addEventListener('track', (ev: any) => {
            if (audioRef.current && ev.streams?.[0])
              audioRef.current.srcObject = ev.streams[0];
          });
        } catch {
          /* noop */
        }
      });
      attachMedia(session);
      setCall({ direction, peer, startedAt: direction === 'outbound' ? null : null });
      setState(direction === 'inbound' ? 'ringing-in' : 'ringing-out');
    },
    [attachMedia],
  );

  // Register when authenticated + creds available.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const creds = await apiFetch<SipCreds>('/calls/sip-credentials');
        if (cancelled || !creds?.configured || !creds.wssUrl || !creds.password) {
          setAvailable(false);
          return;
        }
        credsRef.current = creds;
        setAvailable(true);
        const JsSIP = (await import('jssip')).default as any;
        const socket = new JsSIP.WebSocketInterface(creds.wssUrl);
        const ua = new JsSIP.UA({
          sockets: [socket],
          uri: `sip:${creds.username}@${creds.realm}`,
          password: creds.password,
          register: true,
          session_timers: false,
        });
        uaRef.current = ua;
        ua.on('registered', () => setReady(true));
        ua.on('unregistered', () => setReady(false));
        ua.on('registrationFailed', () => setReady(false));
        ua.on('newRTCSession', (data: any) => {
          const session = data.session;
          if (sessionRef.current) {
            // Already on a call — reject the new one.
            try {
              session.terminate({ status_code: 486 });
            } catch {
              /* noop */
            }
            return;
          }
          if (session.direction === 'incoming') {
            const peer =
              session.remote_identity?.uri?.user ||
              session.remote_identity?.display_name ||
              'Unknown';
            wireSession(session, 'inbound', peer);
          }
        });
        ua.start();
      } catch {
        setAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
      try {
        sessionRef.current?.terminate();
      } catch {
        /* noop */
      }
      try {
        uaRef.current?.stop();
      } catch {
        /* noop */
      }
      uaRef.current = null;
      sessionRef.current = null;
      setReady(false);
    };
  }, [user, wireSession]);

  const placeCall = useCallback(
    (number: string) => {
      const ua = uaRef.current;
      const creds = credsRef.current;
      if (!ua || !creds || sessionRef.current) return;
      const target = `sip:${number.replace(/[^\d+]/g, '')}@${creds.realm}`;
      const session = ua.call(target, {
        mediaConstraints: { audio: true, video: false },
        rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      });
      wireSession(session, 'outbound', number);
    },
    [wireSession],
  );

  const answer = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    try {
      session.answer({ mediaConstraints: { audio: true, video: false } });
    } catch {
      /* noop */
    }
  }, []);

  const hangup = useCallback(() => {
    const session = sessionRef.current;
    try {
      session?.terminate();
    } catch {
      /* noop */
    }
  }, []);

  const toggleMute = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    try {
      if (muted) session.unmute({ audio: true });
      else session.mute({ audio: true });
      setMuted((m) => !m);
    } catch {
      /* noop */
    }
  }, [muted]);

  // --- Incoming ringer (WebAudio warble) + desktop notification ---
  const ringerRef = useRef<{ start: () => void; stop: () => void } | null>(null);
  useEffect(() => {
    let actx: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const ring = () => {
      try {
        actx =
          actx ||
          new (window.AudioContext || (window as any).webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume().catch(() => {});
        const now = actx.currentTime;
        [0, 0.45].forEach((offset) => {
          const o = actx!.createOscillator();
          const g = actx!.createGain();
          o.type = 'sine';
          o.frequency.value = offset === 0 ? 440 : 480;
          o.connect(g);
          g.connect(actx!.destination);
          const t = now + offset;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.28, t + 0.03);
          g.gain.setValueAtTime(0.28, t + 0.33);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
          o.start(t);
          o.stop(t + 0.42);
        });
      } catch {
        /* audio blocked — card still shows */
      }
    };
    ringerRef.current = {
      start: () => {
        if (timer) return;
        ring();
        timer = setInterval(ring, 3000);
      },
      stop: () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      },
    };
    return () => {
      ringerRef.current?.stop();
      try {
        actx?.close();
      } catch {
        /* noop */
      }
    };
  }, []);

  useEffect(() => {
    if (state === 'ringing-in') {
      ringerRef.current?.start();
      try {
        if (
          typeof Notification !== 'undefined' &&
          Notification.permission === 'granted' &&
          typeof document !== 'undefined' &&
          document.hidden
        ) {
          const n = new Notification('📞 Incoming WhatsApp call', {
            body: call?.peer ?? '',
            tag: 'wa-incoming-call',
          });
          n.onclick = () => {
            window.focus();
            n.close();
          };
        }
      } catch {
        /* noop */
      }
    } else {
      ringerRef.current?.stop();
    }
  }, [state, call?.peer]);

  return (
    <SipContext.Provider
      value={{ ready, available, state, call, muted, placeCall, answer, hangup, toggleMute }}
    >
      {children}
    </SipContext.Provider>
  );
}
