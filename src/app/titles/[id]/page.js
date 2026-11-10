'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

export default function TitlePage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [me, setMe] = useState(null);
  const [score, setScore] = useState(0);
  const [review, setReview] = useState('');
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/titles/${id}`);
    const body = await res.json();
    if (res.ok) {
      setData(body);
      const mine = body.reviews?.find(r => Number(r.is_mine) === 1);
      if (mine) { setScore(mine.score); setReview(mine.review_text || ''); }
    } else setError(body.error);
  }, [id]);

  useEffect(() => {
    load();
    fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(d => setMe(d?.user ?? null));
  }, [load]);

  async function submitRating(e) {
    e.preventDefault();
    setError(null); setMsg(null);
    const res = await fetch('/api/ratings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titleId: Number(id), score, review }),
    });
    const body = await res.json();
    if (!res.ok) { setError(body.error); return; }
    setMsg(`Saved. The average is now ${Number(body.title.avg_rating).toFixed(2)} from ${body.title.rating_count} ratings.`);
    load();
  }

  async function addToWatchlist() {
    const res = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titleId: Number(id) }),
    });
    setMsg(res.ok ? 'Added to your watchlist.' : 'Could not add it.');
  }

  if (error && !data) return <main><div className="notice notice--error">{error}</div></main>;
  if (!data) return <main><p className="muted">Loading…</p></main>;

  const { title, credits, reviews, related, embedding } = data;

  return (
    <main>
      <div className="section__head" style={{ marginBottom: 20 }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>{title.name}</h1>
          <span className="muted">
            {title.release_year ?? 'year unknown'} · {title.genres?.join(', ')}
          </span>
        </div>
        <span className={`mark mark--${title.type === 'book' ? 'book' : 'film'}`}>{title.type}</span>
      </div>

      {msg && <div className="notice notice--ok">{msg}</div>}
      {error && <div className="notice notice--error">{error}</div>}

      <div className="grid grid--split">
        <div>
          <p style={{ fontSize: '1.02rem' }}>{title.description}</p>

          {credits.length > 0 && (
            <div className="record" style={{ marginBottom: 22 }}>
              <h3>Credits</h3>
              <table>
                <tbody>
                  {credits.map((c, i) => (
                    <tr key={i}><td>{c.name}</td><td className="muted">{c.role}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="section__head"><h2>Reviews</h2></div>
          {reviews.length === 0 ? (
            <div className="empty"><p>No reviews yet. Be the first.</p></div>
          ) : (
            <div className="stack">
              {reviews.map((r, i) => (
                <div key={i} className="record" style={{ paddingTop: 12, paddingBottom: 12 }}>
                  <div className="entry__head" style={{ marginBottom: 4 }}>
                    <b>{r.reviewer}{Number(r.is_mine) === 1 && <span className="muted"> · you</span>}</b>
                    <span className="score">{r.score}<small> /5</small></span>
                  </div>
                  {r.review_text && <p style={{ margin: 0, fontSize: '0.92rem' }}>{r.review_text}</p>}
                </div>
              ))}
            </div>
          )}
        </div>

        <aside>
          <div className="record" style={{ marginBottom: 20 }}>
            <h3>Rating</h3>
            {title.rating_count > 0 ? (
              <>
                <p style={{ fontSize: '2rem', fontWeight: 700, margin: '0 0 2px' }}>
                  {Number(title.avg_rating).toFixed(1)}<span style={{ fontSize: '1rem', fontWeight: 400, color: 'var(--ink-faint)' }}> /5</span>
                </p>
                <p className="muted" style={{ margin: 0 }}>
                  {title.rating_count} {title.rating_count === 1 ? 'rating' : 'ratings'} ·
                  weighted {Number(title.bayesian_score).toFixed(2)}
                </p>
              </>
            ) : <p className="muted">Not yet rated.</p>}
          </div>

          {me ? (
            <form onSubmit={submitRating} className="record record--perforated" style={{ marginBottom: 20 }}>
              <h3>Your rating</h3>
              <div className="field">
                <label htmlFor="score">Score</label>
                <select id="score" value={score} onChange={e => setScore(Number(e.target.value))} required>
                  <option value={0} disabled>Choose…</option>
                  {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} / 5</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="review">Review (optional)</label>
                <textarea id="review" rows={3} value={review} onChange={e => setReview(e.target.value)} />
              </div>
              <div className="inline">
                <button type="submit" disabled={!score}>Save rating</button>
                <button type="button" className="button--quiet" onClick={addToWatchlist}>
                  Add to watchlist
                </button>
              </div>
            </form>
          ) : (
            <div className="record" style={{ marginBottom: 20 }}>
              <p className="muted" style={{ margin: 0 }}>
                <Link href="/login">Sign in</Link> to rate this and build a watchlist.
              </p>
            </div>
          )}

          {related.length > 0 && (
            <div className="record" style={{ marginBottom: 20 }}>
              <h3>Connected titles</h3>
              <p className="muted" style={{ fontSize: '0.8rem' }}>
                Found by walking shared credits, not by similarity.
              </p>
              <table>
                <tbody>
                  {related.map(r => (
                    <tr key={r.id}>
                      <td><Link href={`/titles/${r.id}`}>{r.name}</Link></td>
                      <td className="muted" style={{ textAlign: 'right' }}>
                        {r.degrees} {r.degrees === 1 ? 'step' : 'steps'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {embedding && (
            <div className="record">
              <h3>Vector</h3>
              <table>
                <tbody>
                  <tr><td className="muted">Model</td><td>{embedding.model_name}</td></tr>
                  <tr><td className="muted">Dimensions</td><td>{embedding.dimensions}</td></tr>
                  <tr><td className="muted">State</td><td>{embedding.status}</td></tr>
                </tbody>
              </table>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
