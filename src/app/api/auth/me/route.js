// GET /api/auth/me — who am I, and what may I do?
import { NextResponse } from 'next/server';
import { queryOne, query } from '@/lib/mysql';
import { requireUser, withErrorHandling } from '@/lib/rbac';

export const runtime = 'nodejs';

async function handler() {
  const claim = await requireUser();

  // Read fresh from the database rather than echoing the token, so the profile
  // page reflects a role change without requiring a sign-out.
  const user = await queryOne(
    `SELECT u.id, u.name, u.email, u.created_at, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? AND u.is_active = TRUE`,
    [claim.id]
  );
  if (!user) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const perms = await query(
    'SELECT permission_code FROM view_user_permissions WHERE user_id = ?',
    [claim.id]
  );

  return NextResponse.json({
    user,
    permissions: perms.map(p => p.permission_code),
    tokenStale: user.role !== claim.role,
  });
}

export const GET = withErrorHandling(handler);
