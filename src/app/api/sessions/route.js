// GET  /api/sessions — sessions the caller belongs to
// POST /api/sessions — open a new session, or join one by invite code
import { NextResponse } from 'next/server';
import { query, pool } from '@/lib/mysql';
import { requirePermission, requireUser, withErrorHandling, HttpError } from '@/lib/rbac';

export const runtime = 'nodejs';

async function list() {
  const user = await requireUser();

  const sessions = await query(
    `SELECT s.id, s.invite_code, s.title_type, s.status, s.created_at, s.finalized_at,
            (s.host_user_id = ?) AS is_host,
            h.name AS host_name,
            (SELECT COUNT(*) FROM session_members sm2 WHERE sm2.session_id = s.id) AS member_count,
            (SELECT COUNT(*) FROM session_swipes sw
              WHERE sw.session_id = s.id AND sw.user_id = ?)                       AS my_swipes,
            fn_session_quorum_met(s.id, 3) AS quorum_met
     FROM sessions s
     JOIN session_members sm ON sm.session_id = s.id AND sm.user_id = ?
     JOIN users h ON h.id = s.host_user_id
     ORDER BY s.created_at DESC`,
    [user.id, user.id, user.id]
  );

  return NextResponse.json({ sessions });
}

async function create(req) {
  const user = await requirePermission('session.create');
  const body = await req.json();

  // --- Join an existing room ------------------------------------------------
  if (body.inviteCode) {
    const conn = await pool.getConnection();
    try {
      // sp_join_session validates that the room exists and is still open,
      // and raises SQLSTATE 45000 otherwise — which withErrorHandling turns
      // into a 409 with the procedure's own message.
      await conn.query('CALL sp_join_session(?, ?, @sid)', [user.id, body.inviteCode]);
      const [[{ sid }]] = await conn.query('SELECT @sid AS sid');
      return NextResponse.json({ sessionId: sid, inviteCode: body.inviteCode, joined: true });
    } finally {
      conn.release();
    }
  }

  // --- Open a new room ------------------------------------------------------
  const titleType = ['movie', 'book', 'any'].includes(body.titleType) ? body.titleType : 'any';

  const conn = await pool.getConnection();
  try {
    // OUT parameters come back through session variables; a single connection
    // is required so @sid and @code belong to this call and not another
    // request that happened to be in flight.
    await conn.query('CALL sp_create_session(?, ?, @sid, @code)', [user.id, titleType]);
    const [[row]] = await conn.query('SELECT @sid AS sid, @code AS code');

    // The host was seated by trg_sessions_after_insert, not by this handler.
    return NextResponse.json(
      { sessionId: row.sid, inviteCode: row.code, titleType, status: 'open' },
      { status: 201 }
    );
  } finally {
    conn.release();
  }
}

export const GET = withErrorHandling(list);
export const POST = withErrorHandling(create);
