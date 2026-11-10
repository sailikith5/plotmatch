'use client';

import { useEffect, useState } from 'react';

export default function AdminPage() {
  const [tab, setTab] = useState('users');
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [health, setHealth] = useState(null);
  const [audit, setAudit] = useState([]);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);

  async function loadUsers() {
    const res = await fetch('/api/admin/users');
    const d = await res.json();
    if (res.ok) { setUsers(d.users); setRoles(d.roles); } else setError(d.error);
  }
  async function loadHealth() {
    const res = await fetch('/api/admin/embeddings');
    const d = await res.json();
    if (res.ok) setHealth(d); else setError(d.error);
  }
  async function loadAudit() {
    const res = await fetch('/api/admin/audit?limit=40');
    const d = await res.json();
    if (res.ok) setAudit(d.entries); else setError(d.error);
  }

  useEffect(() => {
    setError(null);
    if (tab === 'users') loadUsers();
    if (tab === 'vectors') loadHealth();
    if (tab === 'audit') loadAudit();
  }, [tab]);

  async function changeRole(userId, role) {
    setMsg(null); setError(null);
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, role }),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error); return; }
    setMsg(`${d.user.name} is now ${d.user.role}.`);
    loadUsers();
  }

  async function markStale(scope) {
    const res = await fetch('/api/admin/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error); return; }
    setMsg(`${d.markedStale} marked for rebuilding. ${d.next}`);
    loadHealth();
  }

  return (
    <main>
      <h1>Admin</h1>
      <div className="inline section" style={{ marginTop: 4 }}>
        {['users', 'vectors', 'audit'].map(t => (
          <button key={t} className={tab === t ? '' : 'button--quiet'} onClick={() => setTab(t)}>
            {t === 'users' ? 'People and roles' : t === 'vectors' ? 'Vector store' : 'Audit trail'}
          </button>
        ))}
      </div>

      {msg && <div className="notice notice--ok">{msg}</div>}
      {error && <div className="notice notice--error">{error}</div>}

      {tab === 'users' && (
        <section className="record">
          <table>
            <thead>
              <tr><th>Name</th><th>Email</th><th>Role</th><th>Ratings</th>
                  <th>Hosted</th><th>Permissions</th></tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td><b>{u.name}</b></td>
                  <td className="muted">{u.email}</td>
                  <td>
                    <select value={u.role} style={{ width: 'auto' }}
                            onChange={e => changeRole(u.id, e.target.value)}>
                      {roles.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
                    </select>
                  </td>
                  <td>{u.ratings}</td>
                  <td>{u.hosted_sessions}</td>
                  <td className="muted" style={{ fontSize: '0.76rem', maxWidth: 260 }}>
                    {(u.permissions || '').split(',').filter(Boolean).join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
            Role changes run through <code>sp_set_user_role</code>, which re-checks the
            permission inside MySQL and writes to the audit trail. Changing your own
            role here is refused.
          </p>
        </section>
      )}

      {tab === 'vectors' && health && (
        <section>
          <div className="grid grid--split">
            <div className="record">
              <h3>Coverage</h3>
              <table>
                <tbody>
                  <tr><td className="muted">Backend</td><td>{health.backend}</td></tr>
                  <tr><td className="muted">Model</td><td>{health.model}</td></tr>
                  <tr><td className="muted">Dimensions</td><td>{health.dimensions}</td></tr>
                  <tr><td className="muted">Titles ready</td>
                      <td>{health.mysql?.ready ?? 0} of {health.mysql?.total_titles ?? 0}
                          {' '}({health.mysql?.coverage_pct ?? 0}%)</td></tr>
                  <tr><td className="muted">Documents in MongoDB</td><td>{health.mongo.documentCount}</td></tr>
                </tbody>
              </table>
            </div>

            <div className={`record ${health.drift.inSync ? '' : 'record--perforated'}`}>
              <h3>Store agreement</h3>
              {health.drift.inSync ? (
                <p style={{ color: 'var(--consensus)', margin: 0 }}>
                  MySQL and MongoDB hold the same set of titles.
                </p>
              ) : (
                <>
                  <p style={{ color: 'var(--stamp)' }}>The two stores have drifted.</p>
                  <table>
                    <tbody>
                      <tr><td className="muted">Missing vectors</td>
                          <td>{health.drift.missingInMongo.join(', ') || 'none'}</td></tr>
                      <tr><td className="muted">Orphaned vectors</td>
                          <td>{health.drift.orphanedInMongo.join(', ') || 'none'}</td></tr>
                    </tbody>
                  </table>
                </>
              )}
              <div className="inline" style={{ marginTop: 14 }}>
                <button onClick={() => markStale('stale')}>Retry failures</button>
                <button className="button--quiet" onClick={() => markStale('all')}>
                  Rebuild everything
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {tab === 'audit' && (
        <section className="record">
          <table>
            <thead>
              <tr><th>When</th><th>Who</th><th>Action</th><th>On</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {audit.map(a => (
                <tr key={a.id}>
                  <td className="muted">{new Date(a.occurred_at).toLocaleString()}</td>
                  <td>{a.actor_name}</td>
                  <td><span className="mark">{a.action}</span></td>
                  <td className="muted">{a.entity_type} {a.entity_id ?? ''}</td>
                  <td className="muted" style={{ fontSize: '0.78rem' }}>
                    {a.detail ? JSON.stringify(a.detail) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
            The trail outlives the accounts it describes: <code>actor_user_id</code> is
            <code> ON DELETE SET NULL</code>, so a deleted user&rsquo;s actions still show,
            attributed to a removed account.
          </p>
        </section>
      )}
    </main>
  );
}
