// =============================================================================
// Role-based access control helpers for API route handlers.
//
// Three layers guard a protected endpoint, and each catches what the others
// cannot:
//
//   1. middleware.js   — rejects unauthenticated requests at the edge, before
//                        a route handler or a database connection is touched.
//   2. requirePermission() below — checks the caller's claim for this specific
//                        capability. Cheap: reads the signed token only.
//   3. requireFreshPermission() — re-reads the permission from MySQL via
//                        fn_user_has_permission. Used for destructive or
//                        privilege-changing actions, where a token minted
//                        before a revocation must not still work.
//
// Layer 3 exists because the token is a cache. Caching authorization is the
// right call for a read endpoint and the wrong call for "delete this user".
// =============================================================================

import { NextResponse } from 'next/server';
import { currentUser } from './auth';
import { queryOne } from './mysql';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Throws 401 if not signed in. Returns the user otherwise. */
export async function requireUser() {
  const user = await currentUser();
  if (!user) throw new HttpError(401, 'Authentication required');
  return user;
}

/** Throws 403 unless the caller's token carries `code`. */
export async function requirePermission(code) {
  const user = await requireUser();
  if (!user.permissions.includes(code)) {
    throw new HttpError(403, `Permission denied: ${code}`);
  }
  return user;
}

/**
 * Re-checks the permission against the live database rather than the token.
 * Use for destructive actions and anything that changes another account.
 */
export async function requireFreshPermission(code) {
  const user = await requireUser();
  const row = await queryOne(
    'SELECT fn_user_has_permission(?, ?) AS ok',
    [user.id, code]
  );
  if (!row || Number(row.ok) !== 1) {
    throw new HttpError(403, `Permission denied: ${code}`);
  }
  return user;
}

/**
 * Ownership check: a user may always act on their own resource; otherwise the
 * named override permission is required. This is the rule that a pure
 * database-GRANT model cannot express — "edit your own rating, not anyone
 * else's" is row-level, not table-level.
 */
export async function requireSelfOr(targetUserId, overridePermission) {
  const user = await requireUser();
  if (user.id === Number(targetUserId)) return user;
  if (user.permissions.includes(overridePermission)) return user;
  throw new HttpError(403, 'You may only modify your own data');
}

/** Wraps a route handler so thrown HttpErrors become clean JSON responses. */
export function withErrorHandling(handler) {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      // MySQL SIGNAL from a stored procedure — surface the message, not a 500.
      if (err && err.sqlState === '45000') {
        return NextResponse.json({ error: err.sqlMessage }, { status: 409 });
      }
      if (err && err.code === 'ER_DUP_ENTRY') {
        return NextResponse.json({ error: 'That record already exists' }, { status: 409 });
      }
      if (err && err.code === 'ER_NO_REFERENCED_ROW_2') {
        return NextResponse.json({ error: 'Referenced record does not exist' }, { status: 400 });
      }
      console.error('[api]', err);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  };
}
