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
    // Super-admin impersonation: a one-shot token handed off via
    // localStorage (set by /super-admin/clients, opened in a new tab).
    // Consume it BEFORE the normal refresh — a super-admin has no tenant
    // refresh_token cookie, so /auth/refresh would 401 and bounce to
    // /login. Key absent → this block is skipped and the flow below is
    // byte-identical to before (live tenant unaffected).
    if (typeof window !== 'undefined') {
      const imp = window.localStorage.getItem('ca_impersonation_token');
      if (imp) {
        window.localStorage.removeItem('ca_impersonation_token');
        // Clear the middleware marker cookie now that we've consumed the
        // token (it auto-expires in 30s as a fallback). Leaving it set would
        // let a later unauthenticated /dashboard load slip past middleware
        // until expiry (the React gate still catches it, but be tidy).
        document.cookie =
          'ca_impersonation_handoff=; path=/; max-age=0; samesite=lax';
        setAccessToken(imp);
        apiFetch<{
          id: number;
          name: string;
          email: string;
          role: string;
          company?: User['company'];
        }>('/auth/me')
          .then((me) => {
            setState({
              user: {
                id: me.id,
                name: me.name,
                email: me.email,
                role: me.role,
                company: me.company ?? null,
              },
              loading: false,
            });
          })
          .catch(() => {
            setAccessToken(null);
            setState({ user: null, loading: false });
          });
        return;
      }
    }

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
