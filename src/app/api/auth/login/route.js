// POST /api/auth/login
import { NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/mysql';
import { verifyPassword, issueToken, COOKIE_NAME, sessionCookieOptions } from '@/lib/auth';
import { withErrorHandling, HttpError } from '@/lib/rbac';

export const runtime = 'nodejs';

async function handler(req) {
  const { email, password } = await req.json();
  if (!email || !password) throw new HttpError(400, 'email and password are required');

  const user = await queryOne(
    `SELECT u.id, u.name, u.email, u.password_hash, u.is_active, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.email = ?`,
    [email]
  );

  // One message for "no such account" and for "wrong password". Distinguishing
  // them tells an attacker which emails are registered.
  const ok = user && verifyPassword(password, user.password_hash);
  if (!ok) throw new HttpError(401, 'Invalid email or password');

  if (!user.is_active) throw new HttpError(403, 'This account has been deactivated');

  const perms = await query(
    'SELECT permission_code FROM view_user_permissions WHERE user_id = ?',
    [user.id]
  );

  const token = await issueToken({
    id: user.id,
    email: user.email,
    role: user.role,
    permissions: perms.map(p => p.permission_code),
  });

  await query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, detail)
     VALUES (?, 'user.login', 'user', ?, JSON_OBJECT('role', ?))`,
    [user.id, user.id, user.role]
  );

  const res = NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    permissions: perms.map(p => p.permission_code),
  });
  res.cookies.set(COOKIE_NAME, token, sessionCookieOptions());
  return res;
}

export const POST = withErrorHandling(handler);
