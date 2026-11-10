'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Tally from '@/components/Tally';

export default function SessionRoom() {
  const { code } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [justFinalized, setJustFinalized] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${code}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setData(body);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [code]);

  useEffect(() => { load(); }, [load]);

  async function swipe(titleId, liked) {
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${code}/swipe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titleId, liked }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function finalize() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${code}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 5 }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setJustFinalized(true);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <main><div className="notice notice--error">{error}</div></main>;
  if (!data) return <main><p className="muted">Loading the room…</p></main>;

  const { session, members, agreement, pending, recommendations, quorumMet } = data;
  const closed = session.status !== 'open';

  return (
    <main>
      <div className="section__head" style={{ marginBottom: 20 }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>Room {session.invite_code}</h1>
          <span className="muted">
            Hosted by {session.host_name} · {session.title_type === 'any' ? 'films and books' : session.title_type + 's'} ·{' '}
            {members.length} {members.length === 1 ? 'member' : 'members'}
          </span>
        </div>
        {closed && (
          <span className={`stamp ${justFinalized ? 'stamp--animate' : ''}`}>
            {session.status === 'finalized' ? 'DECIDED' : 'CANCELLED'}
          </span>
        )}
      </div>

      {error && <div className="notice notice--error">{error}</div>}

      {/* The decision, when there is one. */}
      {recommendations.length > 0 && (
        <section className="section">
          <div className="section__head"><h2>What you are watching</h2></div>
          <div className="stack">
            {recommendations.map((r, i) => (
              <div key={r.title_id} className="record record--perforated"
                   style={i === 0 ? { borderLeftColor: 'var(--stamp)', borderLeftWidth: 5 } : undefined}>
                <div className="entry__head">
                  <div className="entry__title">
                    {i === 0 && <strong style={{ color: 'var(--stamp)' }}>Pick · </strong>}
                    {r.name}
                  </div>
                  <span className={`mark mark--${r.type === 'book' ? 'book' : 'film'}`}>{r.type}</span>
                </div>
                <div className="muted">
                  Taste match {(Number(r.match_score) * 100).toFixed(0)}%
                  {Number(r.agreement_pct) > 0 && ` · ${Number(r.agreement_pct).toFixed(0)}% of votes in favour`}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid grid--split">
        {/* Voting */}
        <section>
          <div className="section__head">
            <h2>{closed ? 'What the group voted on' : 'Your turn'}</h2>
          </div>

          {!closed && pending.length > 0 && (
            <div className="stack" style={{ marginBottom: 26 }}>
              {pending.slice(0, 4).map(t => (
                <article key={t.id} className="record">
                  <div className="entry__head">
                    <div className="entry__title">{t.name}</div>
                    <span className={`mark mark--${t.type === 'book' ? 'book' : 'film'}`}>{t.type}</span>
                  </div>
                  <div className="entry__meta">{t.release_year} · {t.genres}</div>
                  <p className="entry__blurb">{t.description}</p>
                  <div className="inline">
                    <button className="button--yes" disabled={busy}
                            onClick={() => swipe(t.id, true)}>Interested</button>
                    <button className="button--no" disabled={busy}
                            onClick={() => swipe(t.id, false)}>Pass</button>
                  </div>
                </article>
              ))}
            </div>
          )}

          {!closed && pending.length === 0 && (
            <div className="empty">
              <p>You have voted on everything available. Waiting for the others.</p>
            </div>
          )}

          {agreement.length > 0 && (
            <>
              <div className="section__head"><h3 style={{ margin: 0 }}>Where the group stands</h3></div>
              <div className="stack">
                {agreement.map(a => (
                  <div key={a.title_id} className="record" style={{ paddingTop: 12, paddingBottom: 12 }}>
                    <div className="entry__head" style={{ marginBottom: 6 }}>
                      <div className="entry__title" style={{ fontSize: '0.95rem' }}>{a.name}</div>
                    </div>
                    <Tally likes={a.likes} dislikes={a.dislikes} memberCount={a.member_count} />
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        {/* Room state */}
        <aside>
          <div className="section__head"><h2>Members</h2></div>
          <div className="record" style={{ marginBottom: 20 }}>
            <table>
              <tbody>
                {members.map(m => (
                  <tr key={m.id}>
                    <td>
                      {m.name}
                      {Number(m.is_host) === 1 && <span className="mark" style={{ marginLeft: 6 }}>host</span>}
                      {Number(m.is_me) === 1 && <span className="muted"> · you</span>}
                    </td>
                    <td style={{ textAlign: 'right' }} className="muted">
                      {m.swipe_count} {m.swipe_count === 1 ? 'vote' : 'votes'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="record record--perforated">
            <h3>Invite code</h3>
            <p style={{ fontSize: '1.5rem', fontWeight: 700, letterSpacing: '0.1em', margin: '4px 0 10px' }}>
              {session.invite_code}
            </p>
            <p className="muted" style={{ margin: 0 }}>Share this so others can join the room.</p>
          </div>

          {session.is_host && !closed && (
            <div className="record" style={{ marginTop: 20 }}>
              <h3>Close the room</h3>
              <p className="muted">
                {quorumMet
                  ? 'Everyone has voted enough. Build the shortlist whenever you are ready.'
                  : 'Not everyone has voted three times yet. You can still decide now — the shortlist just has less to go on.'}
              </p>
              <button onClick={finalize} disabled={busy}>
                {busy ? 'Working…' : 'Decide now'}
              </button>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
