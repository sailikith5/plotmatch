// GET    /api/watchlist           — the caller's watchlist
// POST   /api/watchlist           — add a title
// DELETE /api/watchlist?titleId=… — remove one
import { NextResponse } from 'next/server';
import { query } from '@/lib/mysql';
import { requirePermission, requireUser, withErrorHandling, HttpError } from '@/lib/rbac';

export const runtime = 'nodejs';

async function list() {
  const user = await requireUser();
  const items = await query(
    `SELECT t.id, t.name, t.type, t.release_year, t.avg_rating, t.rating_count,
            w.added_at,
            (SELECT r.score FROM ratings r
              WHERE r.user_id = w.user_id AND r.title_id = t.id) AS my_score
     FROM watchlist w JOIN titles t ON t.id = w.title_id
     WHERE w.user_id = ?
     ORDER BY w.added_at DESC`,
    [user.id]
  );
  return NextResponse.json({ items });
}

async function add(req) {
  const user = await requirePermission('watchlist.write');
  const { titleId } = await req.json();
  if (!titleId) throw new HttpError(400, 'titleId is required');

  // INSERT IGNORE: adding a title twice is not an error, it is a no-op.
  // The PRIMARY KEY (user_id, title_id) is what actually enforces uniqueness.
  await query('INSERT IGNORE INTO watchlist (user_id, title_id) VALUES (?, ?)',
              [user.id, titleId]);
  return NextResponse.json({ ok: true });
}

async function remove(req) {
  const user = await requirePermission('watchlist.write');
  const titleId = Number(req.nextUrl.searchParams.get('titleId'));
  if (!titleId) throw new HttpError(400, 'titleId is required');

  // Scoped to the caller's own id, so one user cannot clear another's list.
  const result = await query('DELETE FROM watchlist WHERE user_id = ? AND title_id = ?',
                             [user.id, titleId]);
  if (result.affectedRows === 0) throw new HttpError(404, 'Not on your watchlist');
  return NextResponse.json({ ok: true });
}

export const GET = withErrorHandling(list);
export const POST = withErrorHandling(add);
export const DELETE = withErrorHandling(remove);
