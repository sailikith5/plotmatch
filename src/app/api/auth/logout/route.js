// POST /api/auth/logout — clear the session cookie.
import { NextResponse } from 'next/server';
import { COOKIE_NAME } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  // maxAge 0 expires it immediately. The JWT itself remains valid until its
  // exp claim passes — which is why the TTL is short and why destructive
  // endpoints re-check permissions against the database.
  res.cookies.set(COOKIE_NAME, '', { path: '/', maxAge: 0 });
  return res;
}
