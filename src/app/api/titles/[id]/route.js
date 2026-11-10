// GET    /api/titles/[id] — one title with credits, genres and reviews
// PATCH  /api/titles/[id] — edit metadata (requires title.update)
// DELETE /api/titles/[id] — archive (title.archive) or hard delete (title.delete)
import { NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/mysql';
import { currentUser } from '@/lib/auth';
import { requireFreshPermission, withErrorHandling, HttpError } from '@/lib/rbac';

export const runtime = 'nodejs';

async function detail(req, { params }) {
  const id = Number(params.id);
  const user = await currentUser();

  const title = await queryOne(
    `SELECT t.*, fn_title_bayesian_score(t.id, 5) AS bayesian_score
     FROM titles t WHERE t.id = ?`,
    [id]
  );
  if (!title) throw new HttpError(404, 'No such title');

  const genres = await query(
    `SELECT g.name FROM title_genres tg JOIN genres g ON g.id = tg.genre_id
     WHERE tg.title_id = ? ORDER BY g.name`,
    [id]
  );

  const credits = await query(
    `SELECT p.name, tp.role, tp.billing
     FROM title_people tp JOIN people p ON p.id = tp.person_id
     WHERE tp.title_id = ?
     ORDER BY FIELD(tp.role, 'director', 'author', 'actor'), tp.billing, p.name`,
    [id]
  );

  const reviews = await query(
    `SELECT u.name AS reviewer, r.score, r.review_text, r.created_at, r.updated_at,
            (r.user_id = ?) AS is_mine
     FROM ratings r JOIN users u ON u.id = r.user_id
     WHERE r.title_id = ?
     ORDER BY is_mine DESC, r.created_at DESC`,
    [user?.id ?? 0, id]
  );

  // "More like this" straight from the recursive co-credit walk in
  // 05_queries.sql — the non-semantic fallback for a cold-start user.
  const related = await query(
    `WITH RECURSIVE title_graph AS (
        SELECT t.id AS title_id, 0 AS depth,
               CAST(CONCAT('|', t.id, '|') AS CHAR(500)) AS visited
        FROM titles t WHERE t.id = ?
        UNION ALL
        SELECT t2.id, g.depth + 1, CONCAT(g.visited, t2.id, '|')
        FROM title_graph g
        JOIN title_people tp1 ON tp1.title_id  = g.title_id
        JOIN title_people tp2 ON tp2.person_id = tp1.person_id
        JOIN titles       t2  ON t2.id = tp2.title_id
        WHERE g.depth < 2
          AND INSTR(g.visited, CONCAT('|', t2.id, '|')) = 0
     )
     SELECT MIN(g.depth) AS degrees, t.id, t.name, t.type, t.avg_rating
     FROM title_graph g JOIN titles t ON t.id = g.title_id
     WHERE g.depth > 0 AND t.is_archived = FALSE
     GROUP BY t.id, t.name, t.type, t.avg_rating
     ORDER BY degrees, t.avg_rating DESC
     LIMIT 6`,
    [id]
  );

  const embedding = await queryOne(
    'SELECT model_name, dimensions, status, embedded_at FROM title_embeddings WHERE title_id = ?',
    [id]
  );

  return NextResponse.json({
    title: { ...title, genres: genres.map(g => g.name) },
    credits,
    reviews,
    related,
    embedding,
  });
}

async function update(req, { params }) {
  const user = await requireFreshPermission('title.update');
  const id = Number(params.id);
  const body = await req.json();

  const allowed = ['name', 'type', 'release_year', 'description', 'poster_url'];
  const sets = [];
  const values = [];
  for (const field of allowed) {
    if (body[field] !== undefined) {
      sets.push(`${field} = ?`);          // field comes from the whitelist above
      values.push(body[field]);
    }
  }
  if (!sets.length) throw new HttpError(400, 'No updatable fields supplied');
  values.push(id);

  await query(`UPDATE titles SET ${sets.join(', ')} WHERE id = ?`, values);

  // If name or description changed, trg_titles_after_update has just marked
  // the embedding 'stale' — report that back so the UI can say so.
  const embedding = await queryOne(
    'SELECT status FROM title_embeddings WHERE title_id = ?',
    [id]
  );

  await query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, detail)
     VALUES (?, 'title.update', 'title', ?, ?)`,
    [user.id, id, JSON.stringify(Object.keys(body))]
  );

  const updated = await queryOne('SELECT * FROM titles WHERE id = ?', [id]);
  return NextResponse.json({ title: updated, embeddingStatus: embedding?.status });
}

async function remove(req, { params }) {
  const id = Number(params.id);
  const hard = req.nextUrl.searchParams.get('hard') === 'true';

  if (hard) {
    // Hard delete cascades to ratings, watchlist, swipes and the embedding
    // registry. It is a separate, rarer permission than archiving for exactly
    // that reason.
    const user = await requireFreshPermission('title.delete');
    await query('DELETE FROM titles WHERE id = ?', [id]);
    await query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id)
       VALUES (?, 'title.delete', 'title', ?)`,
      [user.id, id]
    );
    return NextResponse.json({ ok: true, deleted: id });
  }

  const user = await requireFreshPermission('title.archive');
  await query('UPDATE titles SET is_archived = TRUE WHERE id = ?', [id]);
  await query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id)
     VALUES (?, 'title.archive', 'title', ?)`,
    [user.id, id]
  );
  return NextResponse.json({ ok: true, archived: id });
}

export const GET = withErrorHandling(detail);
export const PATCH = withErrorHandling(update);
export const DELETE = withErrorHandling(remove);
