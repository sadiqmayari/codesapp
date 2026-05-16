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

  const hasRefresh = req.cookies.has('refresh_token');
  if (!hasRefresh) {
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
