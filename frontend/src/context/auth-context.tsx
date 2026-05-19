'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { api, apiFetch, setAccessToken } from '@/lib/api';

interface Company {
  id: number;
  name: string;
  logo_url: string | null;
  activation_status?: string;
}

interface User {
  id: number;
  name: string;
  email: string;
  role: string;
  company?: Company | null;
}

interface AuthState {
  user: User | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Patch the in-memory company.logo_url after a branding change (no reload). */
  setCompanyLogo: (logoUrl: string | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// /auth/me carries the company identity (name + logo_url); the
// login/refresh responses only carry the bare user. Fetch it once after a
// token is set and merge so the navbar/branding have company context.
async function fetchMe(): Promise<User['company'] | undefined> {
  try {
    const me = await apiFetch<{ company?: User['company'] }>('/auth/me');
    return me.company ?? null;
  } catch {
    return undefined; // older session / transient — leave company unset
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });

  // Try to restore session on mount via silent refresh
  useEffect(() => {
    api
      .post<{ data: { accessToken: string; user: User } }>('/auth/refresh')
      .then(async (res) => {
        setAccessToken(res.data.data.accessToken);
        const user = res.data.data.user ?? null;
        const company = user ? await fetchMe() : undefined;
        setState({
          user: user ? { ...user, company: company ?? null } : null,
          loading: false,
        });
      })
      .catch(() => {
        setState({ user: null, loading: false });
      });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ data: { accessToken: string; user: User } }>(
      '/auth/login',
      { email, password },
    );
    setAccessToken(res.data.data.accessToken);
    const company = await fetchMe();
    setState({
      user: { ...res.data.data.user, company: company ?? null },
      loading: false,
    });
  }, []);

  const setCompanyLogo = useCallback((logoUrl: string | null) => {
    setState((s) =>
      s.user && s.user.company
        ? {
            ...s,
            user: {
              ...s.user,
              company: { ...s.user.company, logo_url: logoUrl },
            },
          }
        : s,
    );
  }, []);

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {});
    setAccessToken(null);
    setState({ user: null, loading: false });
  }, []);

  return (
    <AuthContext.Provider
      value={{ ...state, login, logout, setCompanyLogo }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
