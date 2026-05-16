'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { io, Socket } from 'socket.io-client';
import { getAccessToken } from '@/lib/api';

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
      // Called on every (re)connect → always uses the freshest token.
      auth: (cb: (data: { token: string | null }) => void) =>
        cb({ token: getAccessToken() }),
    });
    socketRef.current = socket;

    socket.on('connect', () => setStatus('connected'));
    socket.on('disconnect', () => setStatus('disconnected'));
    socket.on('connect_error', () => setStatus('disconnected'));
    socket.io.on('reconnect_attempt', () => setStatus('connecting'));

    return () => {
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
