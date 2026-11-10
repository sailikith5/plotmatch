// POST /api/sessions/[code]/swipe — record one like/dislike.
import { NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/mysql';
import { requireUser, withErrorHandling, HttpError } from '@/lib/rbac';

export const runtime = 'nodejs';

async function handler(req, { params }) {
  const user = await requireUser();
  const { code } = params;
  const { titleId, liked } = await req.json();

  if (!titleId || typeof liked !== 'boolean') {
    throw new HttpError(400, 'titleId and a boolean `liked` are required');
  }

  const session = await queryOne(
    'SELECT id, status FROM sessions WHERE invite_code = ?',
    [code]
  );
  if (!session) throw new HttpError(404, 'No session with that invite code');

  // Note how little validation this handler does. It does NOT check that the
  // user is a member — fk_ss_member makes a non-member row impossible — and it
  // does NOT check that the room is open — trg_session_swipes_before_insert
  // raises SQLSTATE 45000 if it is not. Both rules live in the schema, so they
  // hold no matter which client writes the row.
  await query(
    `INSERT INTO session_swipes (session_id, user_id, title_id, liked)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE liked = VALUES(liked), swiped_at = CURRENT_TIMESTAMP`,
    [session.id, user.id, titleId, liked]
  );

  const agreement = await queryOne(
    `SELECT likes, dislikes, total_swipes, agreement_pct, member_count, participation_pct
     FROM view_session_agreement
     WHERE session_id = ? AND title_id = ?`,
    [session.id, titleId]
  );

  const quorum = await queryOne('SELECT fn_session_quorum_met(?, 3) AS met', [session.id]);

  return NextResponse.json({
    ok: true,
    agreement,
    quorumMet: Number(quorum.met) === 1,
  });
}

export const POST = withErrorHandling(handler);
