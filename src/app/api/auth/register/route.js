// POST /api/auth/register — create an account and sign the user in.
import { NextResponse } from 'next/server';
import { query, queryOne, transaction } from '@/lib/mysql';
import { hashPassword, issueToken, COOKIE_NAME, sessionCookieOptions } from '@/lib/auth';
import { withErrorHandling, HttpError } from '@/lib/rbac';

export const runtime = 'nodejs';

async function handler(req) {
  const { name, email, password } = await req.json();

  // --- Validation ----------------------------------------------------------
  if (!name || !email || !password) {
    throw new HttpError(400, 'name, email and password are required');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(400, 'That does not look like an email address');
  }
  if (password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }

  // The UNIQUE constraint on users.email is the real guard against duplicates
  // — this check only produces a friendlier message. Two simultaneous
  // registrations would both pass this SELECT; one then fails on ER_DUP_ENTRY,
  // which withErrorHandling turns into a 409. The database is the arbiter, not
  // this read.
  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) throw new HttpError(409, 'An account with that email already exists');

  // New accounts always get the lowest-privilege role. Elevation is an
  // explicit admin action through sp_set_user_role, never a request parameter
  // — accepting a `role` field from the client here would be a privilege
  // escalation hole.
  const userId = await transaction(async (conn) => {
    const [result] = await conn.execute(
      `INSERT INTO users (name, email, password_hash, role_id)
       VALUES (?, ?, ?, (SELECT id FROM roles WHERE name = 'user'))`,
      [name, email, hashPassword(password)]
    );
    await conn.execute(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, detail)
       VALUES (?, 'user.register', 'user', ?, JSON_OBJECT('email', ?))`,
      [result.insertId, result.insertId, email]
    );
    return result.insertId;
  });

  const perms = await query(
    'SELECT permission_code FROM view_user_permissions WHERE user_id = ?',
    [userId]
  );

  const token = await issueToken({
    id: userId,
    email,
    role: 'user',
    permissions: perms.map(p => p.permission_code),
  });

  const res = NextResponse.json(
    { user: { id: userId, name, email, role: 'user' } },
    { status: 201 }
  );
  res.cookies.set(COOKIE_NAME, token, sessionCookieOptions());
  return res;
}

export const POST = withErrorHandling(handler);
