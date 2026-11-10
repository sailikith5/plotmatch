'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function SessionsPage() {
  const [sessions, setSessions] = useState([]);
  const [joinCode, setJoinCode] = useState('');
  const [titleType, setTitleType] = useState('any');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function load() {
    const res = await fetch('/api/sessions');
    if (res.ok) setSessions((await res.json()).sessions || []);
  }
  useEffect(() => { load(); }, []);

  async function post(body) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      router.push(`/sessions/${data.inviteCode}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Sessions</h1>
      <p style={{ color: 'var(--ink-soft)' }}>
        Open a room, share the code, everyone votes. PlotMatch builds one shortlist
        from what the group liked — including things nobody has seen yet.
      </p>

      {error && <div className="notice notice--error">{error}</div>}

      <div className="grid grid--split section">
        <div className="record">
          <h3>Start a room</h3>
          <div className="field">
            <label htmlFor="kind">What are you choosing?</label>
            <select id="kind" value={titleType} onChange={e => setTitleType(e.target.value)}>
              <option value="any">Films or books</option>
              <option value="movie">A film</option>
              <option value="book">A book</option>
            </select>
          </div>
          <button disabled={busy} onClick={() => post({ titleType })}>
            {busy ? 'Opening…' : 'Open room'}
          </button>
        </div>

        <div className="record record--perforated">
          <h3>Join a room</h3>
          <div className="field">
            <label htmlFor="code">Invite code</label>
            <input id="code" value={joinCode} placeholder="MOVIE001"
                   onChange={e => setJoinCode(e.target.value.toUpperCase())} />
          </div>
          <button disabled={busy || !joinCode} onClick={() => post({ inviteCode: joinCode })}>
            Join
          </button>
        </div>
      </div>

      <div className="section">
        <div className="section__head"><h2>Your rooms</h2></div>
        {sessions.length === 0 ? (
          <div className="empty"><p>No rooms yet. Open one above, or join with a code from a friend.</p></div>
        ) : (
          <div className="record">
            <table>
              <thead>
                <tr><th>Code</th><th>Host</th><th>Choosing</th><th>Members</th>
                    <th>Your votes</th><th>Status</th></tr>
              </thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.id}>
                    <td><Link href={`/sessions/${s.invite_code}`}><b>{s.invite_code}</b></Link></td>
                    <td>{Number(s.is_host) === 1 ? 'You' : s.host_name}</td>
                    <td>{s.title_type === 'any' ? 'films or books' : s.title_type + 's'}</td>
                    <td>{s.member_count}</td>
                    <td>{s.my_swipes}</td>
                    <td>
                      {s.status === 'finalized'
                        ? <span className="mark mark--book">decided</span>
                        : s.status === 'cancelled'
                          ? <span className="mark">cancelled</span>
                          : <span className="mark mark--film">open</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
