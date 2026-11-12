'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { io, Socket } from 'socket.io-client';
import { api, getAccessToken, setAccessToken } from '@/lib/api';

// The access token is memory-only and lives ~15m (JWT_EXPIRES_IN). The HTTP
// layer auto-refreshes on 401, but the socket had no equivalent — so once the
// token expired, every reconnect handshake was rejected by WsJwtGuard and the
// status got stuck flipping connecting→disconnected forever. Decode `exp` and
// refresh proactively (and reactively on connect_error) so the live indicator
// recovers on its own.
function tokenExpiringSoon(token: string | null, skewMs = 60_000): boolean {
  if (!token) return true;
  try {
    const [, payload] = token.split('.');
    const json = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { exp?: number };
    if (!json.exp) return false; // no exp → let the server decide
    return json.exp * 1000 - Date.now() <= skewMs;
  } catch {
    return false; // unparseable → don't block the connection on a guess
  }
}

// Single-flight: collapse concurrent refreshes (auth cb + connect_error) into
// one /auth/refresh call. Mirrors the lib/api.ts interceptor approach.
let refreshInFlight: Promise<string | null> | null = null;
async function refreshSocketToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await api.post<{ data: { accessToken: string } }>(
        '/auth/refresh',
      );
      const t = res.data?.data?.accessToken ?? null;
      if (t) setAccessToken(t);
      return t;
    } catch {
      return null; // logged out / no cookie — app gates handle navigation
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// Same-origin: Socket.io is served by the same host (path /socket.io).
// Resolve at runtime so the off-host build is not pinned to localhost.
const SOCKET_URL =
  typeof window !== 'undefined'
    ? window.location.origin
    : process.env.NEXT_PUBLIC_SOCKET_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      'http://localhost:3001';

type Status = 'connecting' | 'connected' | 'disconnected';

interface SocketApi {
  socket: Socket | null;
  status: Status;
  /** Subscribe to a server event. Returns an unsubscribe fn. */
  on: <T = unknown>(event: string, cb: (payload: T) => void) => () => void;
  emit: (event: string, payload?: unknown) => void;
  /**
   * Bumped on every RAW reconnect (NOT the first connect, NOT debounced). Any
   * view that keeps realtime state should run a silent catch-up refetch when
   * this changes — socket.io never replays events emitted while we were
   * offline, and a blip shorter than STATUS_GRACE_MS never changes `status`.
   * Consumers: remember the value at mount (`useRef(reconnectSeq)`) and only
   * catch up when it differs.
   */
  reconnectSeq: number;
}

const SocketCtx = createContext<SocketApi | null>(null);

// How long a non-connected state must PERSIST before we surface it in the UI.
// Brief, self-healing reconnects (tab refocus, token refresh, a short network
// blip) finish well within this window, so the "Reconnecting…" badge never
// flashes during normal use — it only appears for a genuine, sustained outage.
const STATUS_GRACE_MS = 2500;

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const socketRef = useRef<Socket | null>(null);
  // `status` is the DEBOUNCED value shown in the UI. It starts optimistic
  // ('connected') because the socket connects within a few hundred ms on a
  // normal load — showing a scary "Reconnecting…" for that instant was the
  // very thing tenants complained about. A real failure still surfaces after
  // the grace period below.
  const [status, setStatus] = useState<Status>('connected');
  // The socket ALSO lives in state so consumers re-render (and re-subscribe)
  // once it exists. Child effects run before this provider's effect, so on a
  // hard load of /inbox/<id> every `on()` used to hit a null ref and return a
  // no-op unsubscribe — and nothing re-rendered afterwards (status starts and
  // stays 'connected'), leaving the inbox with NO live updates until the user
  // navigated once. See ERRORS "[Inbox] no live updates after a hard load".
  const [sock, setSock] = useState<Socket | null>(null);
  const [reconnectSeq, setReconnectSeq] = useState(0);

  useEffect(() => {
    // Raw (immediate) status drives logic; the displayed `status` is debounced.
    let rawStatus: Status = 'connecting';
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const clearGrace = () => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };
    // Apply a status with debounce: 'connected' shows immediately; any
    // non-connected state is only shown if it survives STATUS_GRACE_MS (so a
    // reconnect that completes quickly is invisible to the user).
    const applyStatus = (s: Status) => {
      rawStatus = s;
      if (s === 'connected') {
        clearGrace();
        setStatus('connected');
        return;
      }
      if (graceTimer) return; // a downgrade is already pending
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (rawStatus !== 'connected') setStatus(rawStatus);
      }, STATUS_GRACE_MS);
    };

    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      withCredentials: true,
      // Called on every (re)connect. Proactively refresh an expired/expiring
      // token before handing it to the handshake so the reconnect actually
      // succeeds instead of being rejected by WsJwtGuard.
      auth: async (cb: (data: { token: string | null }) => void) => {
        let token = getAccessToken();
        if (tokenExpiringSoon(token)) {
          token = (await refreshSocketToken()) ?? token;
        }
        cb({ token });
      },
    });
    socketRef.current = socket;
    setSock(socket);

    let connectedOnce = false;
    socket.on('connect', () => {
      applyStatus('connected');
      if (connectedOnce) setReconnectSeq((n) => n + 1);
      connectedOnce = true;
    });
    socket.io.on('reconnect_attempt', () => applyStatus('connecting'));

    // A *server-initiated* disconnect (reason 'io server disconnect') does NOT
    // auto-reconnect in socket.io. Our WsJwtGuard calls client.disconnect(true)
    // whenever the handshake token is missing/expired/invalid — e.g. the
    // memory-only access token expired, or a refresh momentarily failed — which
    // otherwise leaves the indicator stuck "Offline" forever. Refresh the token
    // and reconnect manually so it recovers on its own. All other reasons
    // (transport close, ping timeout, network) auto-reconnect already.
    socket.on('disconnect', (reason: string) => {
      if (reason === 'io server disconnect') {
        applyStatus('connecting');
        void refreshSocketToken().then((t) => {
          if (t && socketRef.current && !socketRef.current.connected) {
            socketRef.current.connect();
          } else if (!t) {
            applyStatus('disconnected');
          }
        });
        return;
      }
      applyStatus('disconnected');
    });

    // Reactive safety net: a handshake rejection (expired/rotated/revoked
    // token) lands here. Refresh once, then let socket.io's next backoff
    // attempt pick up the fresh token via the auth callback above. Show
    // "connecting" (not "disconnected") while we recover so the indicator
    // reflects that we are actively retrying.
    socket.on('connect_error', () => {
      applyStatus('connecting');
      void refreshSocketToken().then((t) => {
        if (t && socketRef.current && !socketRef.current.connected) {
          socketRef.current.connect();
        }
      });
    });

    // Background tabs get their timers (and the socket's ping/pong) throttled
    // by the browser, so the connection silently drops and socket.io's backoff
    // can stall — leaving the indicator stuck "offline" until a manual refresh.
    // When the tab becomes visible / regains focus / the network returns, force
    // an immediate reconnect instead of waiting on the throttled backoff.
    const ensureConnected = () => {
      const s = socketRef.current;
      if (!s || s.connected) return;
      applyStatus('connecting');
      s.connect();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') ensureConnected();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', ensureConnected);
    window.addEventListener('online', ensureConnected);

    return () => {
      clearGrace();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', ensureConnected);
      window.removeEventListener('online', ensureConnected);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setSock(null);
    };
  }, []);

  // Stable per socket instance: `on` only changes identity when the socket
  // itself appears/disappears, so consumer subscribe-effects don't churn on
  // every provider render (they used to tear down + re-add on each status tick).
  const on = useCallback<SocketApi['on']>(
    (event, cb) => {
      if (!sock) return () => {};
      sock.on(event, cb as (...a: unknown[]) => void);
      return () => {
        sock.off(event, cb as (...a: unknown[]) => void);
      };
    },
    [sock],
  );
  const emit = useCallback<SocketApi['emit']>((event, payload) => {
    socketRef.current?.emit(event, payload);
  }, []);

  const api = useMemo<SocketApi>(
    () => ({ socket: sock, status, on, emit, reconnectSeq }),
    [sock, status, on, emit, reconnectSeq],
  );

  return <SocketCtx.Provider value={api}>{children}</SocketCtx.Provider>;
}

export function useSocket(): SocketApi {
  const ctx = useContext(SocketCtx);
  if (!ctx) throw new Error('useSocket must be used within SocketProvider');
  return ctx;
}
