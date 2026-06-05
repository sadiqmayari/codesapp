'use client';

import {
  createContext,
  useContext,
  useEffect,
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
}

const SocketCtx = createContext<SocketApi | null>(null);

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const socketRef = useRef<Socket | null>(null);
  const [status, setStatus] = useState<Status>('connecting');

  useEffect(() => {
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

    socket.on('connect', () => setStatus('connected'));
    socket.io.on('reconnect_attempt', () => setStatus('connecting'));

    // A *server-initiated* disconnect (reason 'io server disconnect') does NOT
    // auto-reconnect in socket.io. Our WsJwtGuard calls client.disconnect(true)
    // whenever the handshake token is missing/expired/invalid — e.g. the
    // memory-only access token expired, or a refresh momentarily failed — which
    // otherwise leaves the indicator stuck "Offline" forever. Refresh the token
    // and reconnect manually so it recovers on its own. All other reasons
    // (transport close, ping timeout, network) auto-reconnect already.
    socket.on('disconnect', (reason: string) => {
      if (reason === 'io server disconnect') {
        setStatus('connecting');
        void refreshSocketToken().then((t) => {
          if (t && socketRef.current && !socketRef.current.connected) {
            socketRef.current.connect();
          } else if (!t) {
            setStatus('disconnected');
          }
        });
        return;
      }
      setStatus('disconnected');
    });

    // Reactive safety net: a handshake rejection (expired/rotated/revoked
    // token) lands here. Refresh once, then let socket.io's next backoff
    // attempt pick up the fresh token via the auth callback above. Show
    // "connecting" (not "disconnected") while we recover so the indicator
    // reflects that we are actively retrying.
    socket.on('connect_error', () => {
      setStatus('connecting');
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
      setStatus('connecting');
      s.connect();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') ensureConnected();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', ensureConnected);
    window.addEventListener('online', ensureConnected);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', ensureConnected);
      window.removeEventListener('online', ensureConnected);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const api: SocketApi = {
    socket: socketRef.current,
    status,
    on: (event, cb) => {
      const s = socketRef.current;
      if (!s) return () => {};
      s.on(event, cb as (...a: unknown[]) => void);
      return () => s.off(event, cb as (...a: unknown[]) => void);
    },
    emit: (event, payload) => {
      socketRef.current?.emit(event, payload);
    },
  };

  return <SocketCtx.Provider value={api}>{children}</SocketCtx.Provider>;
}

export function useSocket(): SocketApi {
  const ctx = useContext(SocketCtx);
  if (!ctx) throw new Error('useSocket must be used within SocketProvider');
  return ctx;
}
