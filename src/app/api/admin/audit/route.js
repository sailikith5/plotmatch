// GET /api/admin/audit — the audit trail.
import { NextResponse } from 'next/server';
import { query } from '@/lib/mysql';
import { requireFreshPermission, withErrorHandling } from '@/lib/rbac';

export const runtime = 'nodejs';

async function handler(req) {
  await requireFreshPermission('audit.read');

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Number(sp.get('limit') || 50), 200);
  const action = sp.get('action');

  const where = [];
  const params = [];
  if (action) { where.push('a.action = ?'); params.push(action); }
  params.push(String(limit));

  const entries = await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.detail, a.occurred_at,
            a.actor_user_id, COALESCE(u.name, '(deleted account)') AS actor_name
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.actor_user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.occurred_at DESC, a.id DESC
     LIMIT ?`,
    params
  );

  // Note the LEFT JOIN and the COALESCE: audit_log.actor_user_id is
  // ON DELETE SET NULL, so the trail survives the account it describes.
  const actions = await query(
    'SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC'
  );

  return NextResponse.json({ entries, actions });
}

export const GET = withErrorHandling(handler);
