// GET  /api/admin/embeddings — vector-store health
// POST /api/admin/embeddings — mark the catalogue for re-embedding
import { NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/mysql';
import { titleVectors } from '@/lib/mongo';
import { vectorConfig } from '@/lib/vector';
import { requireFreshPermission, withErrorHandling } from '@/lib/rbac';

export const runtime = 'nodejs';

async function health() {
  await requireFreshPermission('embedding.rebuild');

  // The MySQL registry's view of the world...
  const mysqlHealth = await queryOne('SELECT * FROM view_embedding_health');
  const byStatus = await query(
    'SELECT status, COUNT(*) AS n FROM title_embeddings GROUP BY status'
  );

  // ...and MongoDB's. Comparing them is the whole point: a divergence means
  // the two stores have drifted and a reconciliation sweep is needed.
  const col = await titleVectors();
  const mongoCount = await col.countDocuments();
  const mongoIds = await col.distinct('titleId');

  const mysqlIds = (await query('SELECT id FROM titles WHERE is_archived = FALSE'))
    .map(r => r.id);

  const missingInMongo = mysqlIds.filter(id => !mongoIds.includes(id));
  const orphanedInMongo = mongoIds.filter(id => !mysqlIds.includes(id));

  return NextResponse.json({
    backend: vectorConfig.backend,
    model: vectorConfig.model,
    dimensions: vectorConfig.dimensions,
    mysql: { ...mysqlHealth, byStatus },
    mongo: { documentCount: mongoCount },
    drift: {
      missingInMongo,
      orphanedInMongo,
      inSync: missingInMongo.length === 0 && orphanedInMongo.length === 0,
    },
  });
}

async function rebuild(req) {
  const actor = await requireFreshPermission('embedding.rebuild');
  const body = await req.json().catch(() => ({}));
  const scope = body.scope === 'all' ? 'all' : 'stale';

  // This endpoint only flags work. The actual embedding runs in
  // scripts/embed.mjs, because loading a 90 MB transformer model inside a
  // request handler would block the event loop and time out the request.
  const result = scope === 'all'
    ? await query("UPDATE title_embeddings SET status = 'stale' WHERE status = 'ready'")
    : await query("UPDATE title_embeddings SET status = 'stale' WHERE status = 'failed'");

  await query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, detail)
     VALUES (?, 'embedding.rebuild', 'title_embeddings', JSON_OBJECT('scope', ?, 'marked', ?))`,
    [actor.id, scope, result.affectedRows]
  );

  return NextResponse.json({
    ok: true,
    scope,
    markedStale: result.affectedRows,
    next: 'Run `npm run embed:stale` to process the queue.',
  });
}

export const GET = withErrorHandling(health);
export const POST = withErrorHandling(rebuild);
