// POST   /api/ratings — create or update the caller's own rating
// DELETE /api/ratings?titleId=… — remove it (own rating, or rating.moderate)
import { NextResponse } from 'next/server';
import { query, queryOne, callProc } from '@/lib/mysql';
import { requireUser, requirePermission, withErrorHandling, HttpError } from '@/lib/rbac';

export const runtime = 'nodejs';

async function upsert(req) {
  const user = await requirePermission('rating.write');
  const { titleId, score, review } = await req.json();

  if (!titleId) throw new HttpError(400, 'titleId is required');
  const s = Number(score);
  if (!Number.isInteger(s) || s < 1 || s > 5) {
    throw new HttpError(400, 'score must be an integer from 1 to 5');
  }

  // Always the caller's own id — never a user id taken from the request body.
  // Accepting one would let any signed-in user write ratings as anybody else.
  await callProc('sp_upsert_rating', [user.id, titleId, s, review ?? null]);

  // sp_upsert_rating -> trigger -> sp_recalc_title_stats has already updated
  // the derived columns, so this read reflects the new average.
  const title = await queryOne(
    'SELECT id, name, avg_rating, rating_count FROM titles WHERE id = ?',
    [titleId]
  );

  return NextResponse.json({ ok: true, title });
}

async function remove(req) {
  const user = await requireUser();
  const titleId = Number(req.nextUrl.searchParams.get('titleId'));
  const targetUserId = Number(req.nextUrl.searchParams.get('userId') || user.id);

  if (!titleId) throw new HttpError(400, 'titleId is required');

  // Row-level ownership: delete your own, or hold rating.moderate to delete
  // anyone's. This rule cannot be expressed as a table GRANT, which is exactly
  // why the application RBAC layer exists alongside the DCL layer.
  if (targetUserId !== user.id && !user.permissions.includes('rating.moderate')) {
    throw new HttpError(403, 'You may only delete your own rating');
  }

  const result = await query(
    'DELETE FROM ratings WHERE user_id = ? AND title_id = ?',
    [targetUserId, titleId]
  );

  if (result.affectedRows === 0) throw new HttpError(404, 'No such rating');

  if (targetUserId !== user.id) {
    await query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, detail)
       VALUES (?, 'rating.moderate_delete', 'rating', ?, JSON_OBJECT('target_user', ?))`,
      [user.id, titleId, targetUserId]
    );
  }

  const title = await queryOne(
    'SELECT id, name, avg_rating, rating_count FROM titles WHERE id = ?',
    [titleId]
  );
  return NextResponse.json({ ok: true, title });
}

export const POST = withErrorHandling(upsert);
export const DELETE = withErrorHandling(remove);
