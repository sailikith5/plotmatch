// GET  /api/titles  — browse the catalogue (public)
// POST /api/titles  — add a title (requires title.create)
import { NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/mysql';
import { requireFreshPermission, withErrorHandling, HttpError } from '@/lib/rbac';

export const runtime = 'nodejs';

async function list(req) {
  const sp = req.nextUrl.searchParams;
  const type = sp.get('type');              // movie | book
  const genre = sp.get('genre');
  const sort = sp.get('sort') || 'rating';  // rating | bayesian | year | name
  const limit = Math.min(Number(sp.get('limit') || 24), 100);
  const offset = Math.max(Number(sp.get('offset') || 0), 0);

  // Filters are composed as parameterised fragments. The values never touch
  // the SQL string; only fixed column names chosen from a whitelist do.
  const where = ['t.is_archived = FALSE'];
  const params = [];

  if (type === 'movie' || type === 'book') {
    where.push('t.type = ?');
    params.push(type);
  }
  if (genre) {
    where.push('EXISTS (SELECT 1 FROM title_genres tg JOIN genres g ON g.id = tg.genre_id WHERE tg.title_id = t.id AND g.name = ?)');
    params.push(genre);
  }

  // Whitelist, not interpolation — an ORDER BY cannot be a bound parameter,
  // so the only safe approach is to map user input onto a fixed set.
  const ORDERINGS = {
    rating:   't.avg_rating DESC, t.rating_count DESC',
    bayesian: 'fn_title_bayesian_score(t.id, 5) DESC',
    year:     't.release_year DESC',
    name:     't.name ASC',
  };
  const orderBy = ORDERINGS[sort] || ORDERINGS.rating;

  const rows = await query(
    `SELECT t.id, t.name, t.type, t.release_year, t.description, t.poster_url,
            t.avg_rating, t.rating_count, t.is_rated,
            fn_title_bayesian_score(t.id, 5) AS bayesian_score,
            GROUP_CONCAT(DISTINCT g.name ORDER BY g.name SEPARATOR ', ') AS genres
     FROM titles t
     LEFT JOIN title_genres tg ON tg.title_id = t.id
     LEFT JOIN genres       g  ON g.id = tg.genre_id
     WHERE ${where.join(' AND ')}
     GROUP BY t.id
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  );

  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM titles t WHERE ${where.join(' AND ')}`,
    params
  );

  return NextResponse.json({ titles: rows, total, limit, offset });
}

async function create(req) {
  // Fresh check: adding catalogue entries is a curation privilege that an
  // admin may have revoked since this token was issued.
  const user = await requireFreshPermission('title.create');
  const { name, type, release_year, description, poster_url, genres = [] } = await req.json();

  if (!name || !['movie', 'book'].includes(type)) {
    throw new HttpError(400, 'name and a valid type (movie|book) are required');
  }

  const result = await query(
    `INSERT INTO titles (name, type, release_year, description, poster_url)
     VALUES (?, ?, ?, ?, ?)`,
    [name, type, release_year ?? null, description ?? null, poster_url ?? null]
  );
  const titleId = result.insertId;

  // trg_titles_after_insert has already registered a 'pending' embedding row.
  for (const g of genres) {
    await query(
      `INSERT IGNORE INTO title_genres (title_id, genre_id)
       SELECT ?, id FROM genres WHERE name = ?`,
      [titleId, g]
    );
  }

  await query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, detail)
     VALUES (?, 'title.create', 'title', ?, JSON_OBJECT('name', ?, 'type', ?))`,
    [user.id, titleId, name, type]
  );

  const created = await queryOne('SELECT * FROM view_title_summary WHERE id = ?', [titleId]);
  return NextResponse.json({ title: created }, { status: 201 });
}

export const GET = withErrorHandling(list);
export const POST = withErrorHandling(create);
