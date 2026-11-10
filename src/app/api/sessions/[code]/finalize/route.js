// POST /api/sessions/[code]/finalize
//
// The payoff endpoint: this is where the relational and vector halves of the
// project meet.
//
//   1. Read every swipe from MySQL                         (relational truth)
//   2. Build the group centroid from the liked vectors     (MongoDB)
//   3. Find nearest neighbours to that centroid            (vector search)
//   4. Blend similarity with SQL swipe agreement           (both)
//   5. Persist the ranked shortlist and close the room     (one transaction)
//
// Step 5 runs inside sp_finalize_session, so the shortlist and the status
// change either both happen or neither does.

import { NextResponse } from 'next/server';
import { query, queryOne, callProc } from '@/lib/mysql';
import { buildSessionCentroid, searchSimilar, blendScores, vectorConfig } from '@/lib/vector';
import { requireUser, withErrorHandling, HttpError } from '@/lib/rbac';

export const runtime = 'nodejs';

async function handler(req, { params }) {
  const user = await requireUser();
  const { code } = params;
  const body = await req.json().catch(() => ({}));
  const shortlistSize = Math.min(Number(body.limit || 5), 10);

  const session = await queryOne(
    'SELECT id, host_user_id, status, title_type, invite_code FROM sessions WHERE invite_code = ?',
    [code]
  );
  if (!session) throw new HttpError(404, 'No session with that invite code');

  // Only the host closes the room. Any member can swipe; one person decides.
  if (session.host_user_id !== user.id) {
    throw new HttpError(403, 'Only the host can finalize this session');
  }
  if (session.status !== 'open') {
    throw new HttpError(409, `Session is already ${session.status}`);
  }

  // --- 1. Relational state --------------------------------------------------
  const swipes = await query(
    'SELECT title_id AS titleId, user_id, liked FROM session_swipes WHERE session_id = ?',
    [session.id]
  );
  if (!swipes.length) throw new HttpError(409, 'Nobody has swiped yet');

  const memberRow = await queryOne(
    'SELECT COUNT(*) AS n FROM session_members WHERE session_id = ?',
    [session.id]
  );
  const memberCount = Number(memberRow.n);

  const agreementRows = await query(
    `SELECT title_id, agreement_pct, total_swipes
     FROM view_session_agreement WHERE session_id = ?`,
    [session.id]
  );
  const agreementByTitle = new Map(
    agreementRows.map(r => [r.title_id, Number(r.agreement_pct)])
  );

  // --- 2. Group centroid ----------------------------------------------------
  const centroid = await buildSessionCentroid(
    session.id,
    session.invite_code,
    swipes.map(s => ({ titleId: s.titleId, liked: Boolean(s.liked) })),
    memberCount
  );

  if (!centroid) {
    throw new HttpError(
      409,
      'No liked titles with embeddings yet. Run `npm run embed` to populate the vector store.'
    );
  }

  // --- 3. Semantic candidates ----------------------------------------------
  // Exclude anything already voted on: the group has seen those, and the point
  // of the vector search is to surface something they have not.
  const seen = [...new Set(swipes.map(s => s.titleId))];
  const neighbours = await searchSimilar(centroid, {
    type: session.title_type,
    excludeTitleIds: seen,
    limit: shortlistSize * 3,
  });

  // --- 4. Blend -------------------------------------------------------------
  // Two pools: titles the group explicitly liked (high agreement, already
  // seen) and fresh semantic neighbours (unseen, no agreement data yet).
  const candidates = [];

  for (const n of neighbours) {
    candidates.push({
      titleId: n.titleId,
      title: n.title,
      similarity: n.score,
      agreementPct: null,
      blended: blendScores(n.score, null),
      source: 'semantic',
    });
  }

  const likedWithAgreement = agreementRows
    .filter(r => Number(r.agreement_pct) >= 50)
    .map(r => ({
      titleId: r.title_id,
      agreementPct: Number(r.agreement_pct),
      totalSwipes: Number(r.total_swipes),
    }));

  if (likedWithAgreement.length) {
    const ids = likedWithAgreement.map(r => r.titleId);
    const names = await query(
      `SELECT id, name FROM titles WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const nameById = new Map(names.map(r => [r.id, r.name]));

    // Score these against the centroid too, so both pools are comparable.
    const scored = await searchSimilar(centroid, { limit: 1000 });
    const simById = new Map(scored.map(s => [s.titleId, s.score]));

    for (const r of likedWithAgreement) {
      const similarity = simById.get(r.titleId) ?? 0.5;
      candidates.push({
        titleId: r.titleId,
        title: nameById.get(r.titleId),
        similarity,
        agreementPct: r.agreementPct,
        blended: blendScores(similarity, r.agreementPct),
        source: 'voted',
      });
    }
  }

  const shortlist = candidates
    .sort((a, b) => b.blended - a.blended)
    .slice(0, shortlistSize);

  if (!shortlist.length) throw new HttpError(409, 'Could not build a shortlist');

  // --- 5. Persist atomically ------------------------------------------------
  const recsJson = JSON.stringify(
    shortlist.map(c => ({
      title_id: c.titleId,
      // session_recs.match_score is DECIMAL(5,4) with CHECK (-1..1)
      match_score: Number(c.blended.toFixed(4)),
      agreement_pct: Number((c.agreementPct ?? 0).toFixed(2)),
    }))
  );

  await callProc('sp_finalize_session', [session.id, recsJson]);

  // trg_sessions_after_update wrote the status change to audit_log.
  const saved = await query(
    `SELECT sr.rank_position, t.name, t.type, sr.match_score, sr.agreement_pct
     FROM session_recs sr JOIN titles t ON t.id = sr.title_id
     WHERE sr.session_id = ? ORDER BY sr.rank_position`,
    [session.id]
  );

  return NextResponse.json({
    ok: true,
    status: 'finalized',
    backend: vectorConfig.backend,
    memberCount,
    swipesConsidered: swipes.length,
    recommendations: saved,
    explain: shortlist.map(c => ({
      title: c.title,
      source: c.source,
      similarity: Number(c.similarity.toFixed(4)),
      agreementPct: c.agreementPct,
      blended: Number(c.blended.toFixed(4)),
    })),
  });
}

export const POST = withErrorHandling(handler);
