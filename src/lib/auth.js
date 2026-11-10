// =============================================================================
// Authentication: password hashing, JWT issuing/verification, session cookie.
//
// WHY SCRYPT AND NOT BCRYPT
// Node's crypto module ships scrypt, which is memory-hard and is the algorithm
// RFC 7914 recommends for password storage. Using it removes a native
// dependency (bcrypt needs a compile step that routinely breaks on Windows
// during a lab demo) without weakening anything. The stored format is
//     scrypt$N:r:p$salt$derivedKey
// so the cost parameters travel with the hash and can be raised later without
// invalidating existing passwords.
//
// WHY JOSE AND NOT jsonwebtoken
// Next.js middleware runs on the Edge runtime, which has no Node crypto. jose
// uses Web Crypto and therefore works in middleware, route handlers and server
// components alike — one token implementation for the whole app.
// =============================================================================

import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

const COOKIE = process.env.SESSION_COOKIE || 'plotmatch_session';
const TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);

function secretKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'JWT_SECRET missing or too short. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'
    );
  }
  return new TextEncoder().encode(secret);
}

// -----------------------------------------------------------------------------
// Password hashing
// -----------------------------------------------------------------------------

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto
    .scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 })
    .toString('hex');
  return `scrypt$${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}$${salt}$${dk}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, params, salt, expected] = stored.split('$');
    if (scheme !== 'scrypt') return false;

    const [N, r, p] = params.split(':').map(Number);
    const actual = crypto
      .scryptSync(password, salt, expected.length / 2, { N, r, p, maxmem: 64 * 1024 * 1024 })
      .toString('hex');

    // Constant-time comparison. A plain `===` leaks information through how
    // long the comparison takes before it finds the first differing byte.
    const a = Buffer.from(actual, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Tokens
// -----------------------------------------------------------------------------

/**
 * Issue a session token.
 *
 * The token carries the user's id, role and permission list so that ordinary
 * requests need no database round trip to authorize. The trade-off is staleness:
 * a permission revoked mid-session stays in the token until it expires, which
 * is why the TTL is short (12h) and why every *destructive* admin action
 * re-checks against the database through requirePermission() rather than
 * trusting the claim.
 */
export async function issueToken({ id, email, role, permissions }) {
  return new SignJWT({ email, role, permissions })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(id))
    .setIssuedAt()
    .setIssuer('plotmatch')
    .setExpirationTime(`${TTL_HOURS}h`)
    .sign(secretKey());
}

export async function verifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: 'plotmatch' });
    return {
      id: Number(payload.sub),
      email: payload.email,
      role: payload.role,
      permissions: payload.permissions || [],
    };
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Cookie handling
// -----------------------------------------------------------------------------

export function sessionCookieOptions() {
  return {
    httpOnly: true,                                   // not readable from JS — blunts XSS token theft
    secure: process.env.NODE_ENV === 'production',    // HTTPS only in production
    sameSite: 'lax',                                  // blunts CSRF on cross-site POSTs
    path: '/',
    maxAge: TTL_HOURS * 3600,
  };
}

export const COOKIE_NAME = COOKIE;

/** Read the current user from the request cookie. Returns null if signed out. */
export async function currentUser() {
  const token = cookies().get(COOKIE)?.value;
  if (!token) return null;
  return verifyToken(token);
}
