'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function WatchlistPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const res = await fetch('/api/watchlist');
    if (res.ok) setItems((await res.json()).items || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function remove(titleId) {
    await fetch(`/api/watchlist?titleId=${titleId}`, { method: 'DELETE' });
    load();
  }

  return (
    <main>
      <h1>Watchlist</h1>
      {loading ? <p className="muted">Loading…</p> : items.length === 0 ? (
        <div className="empty">
          <p>Nothing saved yet. Add titles from the catalogue and they will wait here.</p>
          <Link href="/" className="button">Browse the catalogue</Link>
        </div>
      ) : (
        <div className="record">
          <table>
            <thead>
              <tr><th>Title</th><th>Kind</th><th>Rating</th><th>You rated</th><th></th></tr>
            </thead>
            <tbody>
              {items.map(i => (
                <tr key={i.id}>
                  <td><Link href={`/titles/${i.id}`}>{i.name}</Link>
                      <span className="muted"> · {i.release_year}</span></td>
                  <td><span className={`mark mark--${i.type === 'book' ? 'book' : 'film'}`}>{i.type}</span></td>
                  <td>{i.rating_count > 0 ? `${Number(i.avg_rating).toFixed(1)} /5` : <span className="muted">—</span>}</td>
                  <td>{i.my_score ? `${i.my_score} /5` : <span className="muted">not yet</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="button--quiet" onClick={() => remove(i.id)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
