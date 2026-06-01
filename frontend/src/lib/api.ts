import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

// Single origin: the backend is mounted under /api on the SAME host that
// serves this frontend. Resolve at runtime from window.location so the
// committed build is host-agnostic (NEXT_PUBLIC_* is inlined at build time
// and the build is produced off-host — never hardcode localhost into it).
const API_BASE =
  typeof window !== 'undefined'
    ? `${window.location.origin}/api`
    : (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(
        /\/+$/,
        '',
      ) + '/api';

// Access token stored in memory only — NOT localStorage (XSS-safe)
let _accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  _accessToken = token;
}

export function getAccessToken(): string | null {
  return _accessToken;
}

export const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true, // send httpOnly refresh token cookie
});

// Attach access token to every request
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (_accessToken) {
    config.headers.Authorization = `Bearer ${_accessToken}`;
  }
  return config;
});

let isRefreshing = false;
let failQueue: Array<{
  resolve: (value: string) => void;
  reject: (err: unknown) => void;
}> = [];

function processQueue(error: unknown, token: string | null) {
  failQueue.forEach((p) => {
    if (error) p.reject(error);
    else p.resolve(token!);
  });
  failQueue = [];
}

// 401 → refresh → retry
api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
    };

    // Never run refresh/redirect for the auth endpoints themselves —
    // otherwise the AuthProvider bootstrap refresh (which 401s for an
    // unauthenticated visitor) recurses and hard-redirects, creating an
    // infinite reload loop on /login and /super-admin/login.
    const reqUrl = (original?.url ?? '').toString();
    const isAuthEndpoint =
      reqUrl.includes('/auth/refresh') ||
      reqUrl.includes('/auth/login');

    if (
      error.response?.status === 401 &&
      !original._retry &&
      !isAuthEndpoint
    ) {
      // No token in memory → layout-level rehydration (super-admin layout or
      // AuthProvider) handles recovery. Attempting refresh here would race
      // with that flow and could clear a token the layout just set.
      const currentToken = getAccessToken();
      if (!currentToken) {
        return Promise.reject(error);
      }

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failQueue.push({ resolve, reject });
        })
          .then((token) => {
            original.headers.Authorization = `Bearer ${token}`;
            return api(original);
          })
          .catch(Promise.reject.bind(Promise));
      }

      original._retry = true;
      isRefreshing = true;

      // Decode the current token's role to pick the correct refresh endpoint.
      // Super-admins use sa_refresh_token cookie + /super-admin/auth/refresh.
      // Calling the tenant /auth/refresh for a super-admin always 401s.
      let isSuperAdmin = false;
      try {
        const payload = JSON.parse(atob(currentToken.split('.')[1]));
        isSuperAdmin = payload?.role === 'super_admin';
      } catch { /* treat as tenant on decode error */ }

      const refreshUrl = isSuperAdmin
        ? `${API_BASE}/super-admin/auth/refresh`
        : `${API_BASE}/auth/refresh`;

      try {
        const res = await axios.post<{ data: { accessToken: string } }>(
          refreshUrl,
          {},
          { withCredentials: true },
        );
        const newToken = res.data.data.accessToken;
        setAccessToken(newToken);
        processQueue(null, newToken);
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      } catch (refreshError) {
        // Clear the token and let the app's React-level gates handle
        // navigation. The (app) layout already does a client-side
        // router.replace('/login') when there is no user; a hard
        // window.location redirect here caused reload loops on public
        // pages (which also mount AuthProvider).
        processQueue(refreshError, null);
        setAccessToken(null);
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  },
);

// ---------------------------------------------------------------------------
// apiFetch — the single typed helper. Unwraps the { success, data, message }
// envelope, throws ApiError on success === false / HTTP error, and maps
// status codes to UX behaviour (412 → onboarding redirect).
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  status: number;
  userMessage: string;
  constructor(status: number, message: string, userMessage: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.userMessage = userMessage;
  }
}

interface Envelope<T> {
  success: boolean;
  data: T;
  message: string;
  meta?: Record<string, unknown>;
}

export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  params?: Record<string, string | number | undefined>;
  /** Suppress the automatic 412 → /onboarding redirect (used by the wizard itself). */
  noOnboardingRedirect?: boolean;
  /**
   * Per-request timeout (ms). Default = no timeout. Set on read-only dashboard
   * fetches so a slow/hung backend query surfaces as an error+retry instead of
   * an infinite spinner. Do NOT set on uploads/imports (they can run long).
   */
  timeout?: number;
}

/** Returns the full envelope so callers can read `meta` (pagination). */
export async function apiFetchEnvelope<T>(
  url: string,
  opts: ApiFetchOptions = {},
): Promise<Envelope<T>> {
  try {
    const res = await api.request<Envelope<T>>({
      url,
      method: opts.method ?? 'GET',
      data: opts.body,
      params: opts.params,
      timeout: opts.timeout,
    });
    const env = res.data;
    if (env && typeof env === 'object' && 'success' in env && !env.success) {
      throw new ApiError(200, env.message || 'Request failed', env.message || 'Request failed');
    }
    return env;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const ax = err as { response?: { status?: number; data?: { message?: string } } };
    const status = ax.response?.status ?? 0;
    const backendMsg = ax.response?.data?.message ?? 'Request failed';

    if (status === 412 && !opts.noOnboardingRedirect && typeof window !== 'undefined') {
      if (window.location.pathname !== '/onboarding') {
        window.location.assign('/onboarding');
      }
    }

    let userMessage: string;
    if (status === 403) userMessage = backendMsg;
    else if (status === 412) userMessage = 'Finish WhatsApp onboarding first.';
    else if (status >= 500) userMessage = 'Something went wrong. Please try again.';
    else userMessage = backendMsg;

    if (status >= 500) {
      // eslint-disable-next-line no-console
      console.error('[apiFetch] server error', status, backendMsg, url);
    }
    throw new ApiError(status, backendMsg, userMessage);
  }
}

export async function apiFetch<T>(
  url: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const env = await apiFetchEnvelope<T>(url, opts);
  return env.data;
}

/**
 * Multipart POST (file uploads). Do NOT set Content-Type — the browser sets
 * the multipart boundary. Reuses the in-memory Bearer token, the envelope
 * unwrap, and ApiError mapping (same as apiFetch).
 */
export async function postMultipart<T>(
  url: string,
  formData: FormData,
): Promise<T> {
  try {
    const res = await api.request<Envelope<T>>({
      url,
      method: 'POST',
      data: formData,
    });
    const env = res.data;
    if (env && typeof env === 'object' && 'success' in env && !env.success) {
      throw new ApiError(
        200,
        env.message || 'Request failed',
        env.message || 'Request failed',
      );
    }
    return env.data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const ax = err as {
      response?: { status?: number; data?: { message?: string } };
    };
    const status = ax.response?.status ?? 0;
    const backendMsg = ax.response?.data?.message ?? 'Upload failed';

    if (status === 412 && typeof window !== 'undefined') {
      if (window.location.pathname !== '/onboarding') {
        window.location.assign('/onboarding');
      }
    }

    let userMessage: string;
    if (status === 403) userMessage = backendMsg;
    else if (status === 412) userMessage = 'Finish WhatsApp onboarding first.';
    else if (status >= 500) userMessage = 'Something went wrong. Please try again.';
    else userMessage = backendMsg;

    if (status >= 500) {
      // eslint-disable-next-line no-console
      console.error('[postMultipart] server error', status, backendMsg, url);
    }
    throw new ApiError(status, backendMsg, userMessage);
  }
}
