import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Middleware can only see cookies (not the in-memory access token). It does a
// cheap presence check on the httpOnly refresh cookie. The real auth decision
// (refresh succeeds/fails) is made inside the (app) layout, which redirects to
// /login if the silent refresh 401s.
const PROTECTED_PREFIXES = [
  '/dashboard',
  '/inbox',
  '/onboarding',
  '/contacts',
  '/templates',
  '/broadcasts',
  '/bots',
  '/webhooks',
  '/analytics',
  '/billing',
  '/settings',
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (!isProtected) return NextResponse.next();

  // Super-admin impersonation has NO tenant refresh_token cookie — the
  // one-shot access token is handed off via localStorage (read by
  // AuthProvider on mount). Middleware can't see localStorage, so the
  // opener sets a short-lived marker cookie alongside it; honor it here so
  // the new tab reaches /dashboard and the client can consume the token.
  // (The real auth decision still happens in the (app) layout — if the
  // token is missing/invalid it redirects to /login at the React layer.)
  const hasRefresh = req.cookies.has('refresh_token');
  const isImpersonationHandoff = req.cookies.has('ca_impersonation_handoff');
  if (!hasRefresh && !isImpersonationHandoff) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/inbox/:path*',
    '/onboarding/:path*',
    '/contacts/:path*',
    '/templates/:path*',
    '/broadcasts/:path*',
    '/bots/:path*',
    '/webhooks/:path*',
    '/analytics/:path*',
    '/billing/:path*',
    '/settings/:path*',
  ],
};
