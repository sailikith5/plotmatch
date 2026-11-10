// GET /api/search?q=...&mode=semantic|keyword|both
//
// The endpoint that demonstrates the problem statement. `mode=both` runs the
// same sentence through MySQL FULLTEXT and MongoDB vector search and returns
// both result sets, which is the comparison reproduced in the report.

import { NextResponse } from 'next/server';
import { query } from '@/lib/mysql';
import { semanticSearch, vectorConfig } from '@/lib/vector';
import { searchLogs } from '@/lib/mongo';
import { currentUser } from '@/lib/auth';
import { withErrorHandling, HttpError } from '@/lib/rbac';

export const runtime = 'nodejs';

/** MySQL FULLTEXT: matches tokens. Fast, exact, and literal-minded. */
async function keywordSearch(q, type, limit) {
  const params = [q, q];
  let typeClause = '';
  if (type === 'movie' || type === 'book') {
    typeClause = 'AND t.type = ?';
    params.push(type);
  }
  params.push(String(limit));

  return query(
    `SELECT t.id AS titleId, t.name AS title, t.type, t.avg_rating,
            ROUND(MATCH(t.name, t.description) AGAINST (? IN NATURAL LANGUAGE MODE), 4) AS score
     FROM titles t
     WHERE MATCH(t.name, t.description) AGAINST (? IN NATURAL LANGUAGE MODE)
       AND t.is_archived = FALSE
       ${typeClause}
     ORDER BY score DESC
     LIMIT ?`,
    params
  );
}

async function handler(req) {
  const sp = req.nextUrl.searchParams;
  const q = (sp.get('q') || '').trim();
  const mode = sp.get('mode') || 'semantic';
  const type = sp.get('type') || undefined;
  const limit = Math.min(Number(sp.get('limit') || 10), 50);

  if (!q) throw new HttpError(400, 'Query parameter `q` is required');
  if (q.length > 500) throw new HttpError(400, 'Query too long');

  const started = Date.now();
  const out = { query: q, mode, backend: vectorConfig.backend };

  if (mode === 'keyword' || mode === 'both') {
    out.keyword = await keywordSearch(q, type, limit);
  }

  if (mode === 'semantic' || mode === 'both') {
    const hits = await semanticSearch(q, { type, limit });

    // The vector store holds titleId, not the live relational row. Re-read the
    // catalogue data from MySQL so ratings and archive status are current —
    // MongoDB is an index over meaning, not a second source of truth.
    if (hits.length) {
      const ids = hits.map(h => h.titleId);
      const rows = await query(
        `SELECT id, name, type, avg_rating, rating_count, is_archived
         FROM titles WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
      const byId = new Map(rows.map(r => [r.id, r]));

      out.semantic = hits
        .filter(h => byId.get(h.titleId) && !byId.get(h.titleId).is_archived)
        .map(h => ({
          titleId: h.titleId,
          title: byId.get(h.titleId).name,
          type: byId.get(h.titleId).type,
          avg_rating: byId.get(h.titleId).avg_rating,
          rating_count: byId.get(h.titleId).rating_count,
          score: Number(h.score.toFixed(4)),
        }));
    } else {
      out.semantic = [];
    }
  }

  out.tookMs = Date.now() - started;

  // Log to MongoDB rather than MySQL: the payload shape differs per mode, and
  // a document store absorbs that without a sparse table or a migration.
  try {
    const user = await currentUser();
    const logs = await searchLogs();
    await logs.insertOne({
      kind: mode,
      q,
      userId: user?.id ?? null,
      params: { type: type ?? null, limit },
      resultCounts: {
        semantic: out.semantic?.length ?? null,
        keyword: out.keyword?.length ?? null,
      },
      tookMs: out.tookMs,
      at: new Date(),
    });
  } catch {
    // Analytics must never break a search. Swallow and continue.
  }

  return NextResponse.json(out);
}

export const GET = withErrorHandling(handler);
