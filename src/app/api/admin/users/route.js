// GET   /api/admin/users          — list accounts with their roles
// PATCH /api/admin/users          — change a role (admin only)
// DELETE /api/admin/users?id=…    — delete an account (admin only)
import { NextResponse } from 'next/server';
import { query, callProc } from '@/lib/mysql';
import { requireFreshPermission, withErrorHandling, HttpError } from '@/lib/rbac';

export const runtime = 'nodejs';

async function list() {
  await requireFreshPermission('user.manage_roles');

  const users = await query(
    `SELECT u.id, u.name, u.email, u.is_active, u.created_at, r.name AS role,
            (SELECT COUNT(*) FROM ratings  rt WHERE rt.user_id = u.id) AS ratings,
            (SELECT COUNT(*) FROM sessions s  WHERE s.host_user_id = u.id) AS hosted_sessions,
            GROUP_CONCAT(p.code ORDER BY p.code SEPARATOR ',') AS permissions
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions      p  ON p.id = rp.permission_id
     GROUP BY u.id
     ORDER BY r.name, u.name`
  );

  const roles = await query('SELECT id, name, description FROM roles ORDER BY name');
  return NextResponse.json({ users, roles });
}

async function patch(req) {
  // Fresh check against the database, not the token: a demoted admin's
  // still-valid cookie must not be able to re-promote themselves.
  const actor = await requireFreshPermission('user.manage_roles');
  const { userId, role } = await req.json();

  if (!userId || !role) throw new HttpError(400, 'userId and role are required');
  if (Number(userId) === actor.id) {
    throw new HttpError(400, 'You cannot change your own role');
  }

  // sp_set_user_role re-checks the permission inside the database and writes
  // the audit row, so authorization holds even for a caller who reaches MySQL
  // without going through this API.
  await callProc('sp_set_user_role', [actor.id, userId, role]);

  const [updated] = await query(
    `SELECT u.id, u.name, u.email, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [userId]
  );
  return NextResponse.json({ ok: true, user: updated });
}

async function remove(req) {
  const actor = await requireFreshPermission('user.deactivate');
  const id = Number(req.nextUrl.searchParams.get('id'));

  if (!id) throw new HttpError(400, 'id is required');
  if (id === actor.id) throw new HttpError(400, 'You cannot delete your own account here');

  // sp_delete_user removes ratings explicitly so the statistics triggers fire
  // (MySQL skips triggers on cascaded FK actions), and refuses if the account
  // still hosts an open session.
  await callProc('sp_delete_user', [id]);

  await query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id)
     VALUES (?, 'user.delete', 'user', ?)`,
    [actor.id, id]
  );

  return NextResponse.json({ ok: true, deleted: id });
}

export const GET = withErrorHandling(list);
export const PATCH = withErrorHandling(patch);
export const DELETE = withErrorHandling(remove);
