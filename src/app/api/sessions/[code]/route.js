// GET /api/sessions/[code] — full state of one session room.
import { NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/mysql';
import { requireUser, withErrorHandling, HttpError } from '@/lib/rbac';

export const runtime = 'nodejs';

async function handler(req, { params }) {
  const user = await requireUser();
  const { code } = params;

  const session = await queryOne(
    `SELECT s.id, s.invite_code, s.title_type, s.status, s.created_at, s.finalized_at,
            s.host_user_id, h.name AS host_name
     FROM sessions s JOIN users h ON h.id = s.host_user_id
     WHERE s.invite_code = ?`,
    [code]
  );
  if (!session) throw new HttpError(404, 'No session with that invite code');

  // Membership is the authorization boundary for a room: you cannot read a
  // session you have not joined, even with a valid session cookie.
  const membership = await queryOne(
    'SELECT 1 AS ok FROM session_members WHERE session_id = ? AND user_id = ?',
    [session.id, user.id]
  );
  if (!membership) throw new HttpError(403, 'You are not a member of this session');

  const members = await query(
    `SELECT u.id, u.name,
            (u.id = ?) AS is_me,
            (u.id = ?) AS is_host,
            (SELECT COUNT(*) FROM session_swipes sw
              WHERE sw.session_id = ? AND sw.user_id = u.id) AS swipe_count
     FROM session_members sm JOIN users u ON u.id = sm.user_id
     WHERE sm.session_id = ?
     ORDER BY is_host DESC, u.name`,
    [user.id, session.host_user_id, session.id, session.id]
  );

  // The relational agreement picture — the SQL half of the recommendation.
  const agreement = await query(
    `SELECT t.id AS title_id, t.name, t.type, t.avg_rating,
            va.likes, va.dislikes, va.total_swipes,
            va.agreement_pct, va.member_count, va.participation_pct
     FROM view_session_agreement va
     JOIN titles t ON t.id = va.title_id
     WHERE va.session_id = ?
     ORDER BY va.agreement_pct DESC, va.total_swipes DESC`,
    [session.id]
  );

  // Candidates this user has not yet voted on.
  const pending = await query(
    `SELECT t.id, t.name, t.type, t.release_year, t.description, t.avg_rating,
            GROUP_CONCAT(DISTINCT g.name ORDER BY g.name SEPARATOR ', ') AS genres
     FROM titles t
     LEFT JOIN title_genres tg ON tg.title_id = t.id
     LEFT JOIN genres       g  ON g.id = tg.genre_id
     WHERE t.is_archived = FALSE
       AND (? = 'any' OR t.type = ?)
       AND NOT EXISTS (
           SELECT 1 FROM session_swipes sw
           WHERE sw.session_id = ? AND sw.user_id = ? AND sw.title_id = t.id)
     GROUP BY t.id
     ORDER BY t.avg_rating DESC, t.rating_count DESC
     LIMIT 10`,
    [session.title_type, session.title_type, session.id, user.id]
  );

  const recommendations = await query(
    `SELECT sr.rank_position, t.id AS title_id, t.name, t.type,
            sr.match_score, sr.agreement_pct, sr.generated_at
     FROM session_recs sr JOIN titles t ON t.id = sr.title_id
     WHERE sr.session_id = ?
     ORDER BY sr.rank_position`,
    [session.id]
  );

  const quorum = await queryOne(
    'SELECT fn_session_quorum_met(?, 3) AS met',
    [session.id]
  );

  return NextResponse.json({
    session: { ...session, is_host: session.host_user_id === user.id },
    members,
    agreement,
    pending,
    recommendations,
    quorumMet: Number(quorum.met) === 1,
  });
}

export const GET = withErrorHandling(handler);
