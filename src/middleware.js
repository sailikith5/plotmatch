// =============================================================================
// Edge middleware — the first authorization gate.
//
// This runs before any route handler, page render or database connection. An
// unauthenticated request to /admin never reaches application code at all.
//
// Middleware runs on the Edge runtime, which has no Node `crypto`, which is
// why tokens are verified with `jose` (Web Crypto) rather than `jsonwebtoken`.
//
// Note what this file deliberately does NOT do: fine-grained permission checks.
// It only answers "is this caller signed in, and does their role plausibly
// belong on this path". The authoritative check lives in the route handler via
// requirePermission / requireFreshPermission, because middleware sees only the
// token and cannot consult the database.
// =============================================================================

import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const COOKIE = process.env.SESSION_COOKIE || 'plotmatch_session';

// Paths that require a signed-in user.
const PROTECTED = ['/sessions', '/watchlist', '/admin', '/profile'];

// Paths that additionally require an elevated role.
const ELEVATED = [
  { prefix: '/admin', roles: ['admin'] },
  { prefix: '/moderate', roles: ['admin', 'moderator'] },
];

// API paths that may be called without a session.
const PUBLIC_API = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/logout',
  '/api/titles',
  '/api/search',
];

async function readToken(request) {
  const token = request.cookies.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, { issuer: 'plotmatch' });
    return payload;
  } catch {
    return null;
  }
}

export async function middleware(request) {
  const { pathname } = request.nextUrl;
  const user = await readToken(request);

  // --- API routes: respond 401/403 in JSON, never redirect ------------------
  if (pathname.startsWith('/api/')) {
    const isPublic = PUBLIC_API.some(p => pathname === p || pathname.startsWith(p + '/'));
    // Public catalogue reads are open; writes to the same path are not.
    if (isPublic && request.method === 'GET') return NextResponse.next();
    if (pathname.startsWith('/api/auth/')) return NextResponse.next();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    if (pathname.startsWith('/api/admin') && user.role !== 'admin') {
      return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
    }

    // Pass the identity downstream so handlers need not re-parse the cookie.
    const headers = new Headers(request.headers);
    headers.set('x-user-id', String(user.sub));
    headers.set('x-user-role', String(user.role));
    return NextResponse.next({ request: { headers } });
  }

  // --- Pages: redirect to login, preserving where they were going -----------
  const needsAuth = PROTECTED.some(p => pathname.startsWith(p));
  if (needsAuth && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (user) {
    for (const rule of ELEVATED) {
      if (pathname.startsWith(rule.prefix) && !rule.roles.includes(user.role)) {
        const url = request.nextUrl.clone();
        url.pathname = '/';
        url.searchParams.set('denied', pathname);
        return NextResponse.redirect(url);
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next.js internals and static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp)$).*)'],
};
