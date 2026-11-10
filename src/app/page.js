'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

/** A five-segment rating meter. Reads at a glance and, unlike five star
 *  glyphs, keeps its meaning when a rating falls between whole numbers. */
function Meter({ value }) {
  return (
    <span className="meter" role="img" aria-label={`${value.toFixed(1)} out of 5`}>
      {[1, 2, 3, 4, 5].map(n => (
        <i key={n} className={value >= n - 0.5 ? 'on' : ''} />
      ))}
    </span>
  );
}

export default function Catalogue() {
  const [titles, setTitles] = useState([]);
  const [total, setTotal] = useState(0);
  const [type, setType] = useState('');
  const [sort, setSort] = useState('bayesian');
  const [loading, setLoading] = useState(true);

  // Search state
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ sort, limit: '24' });
    if (type) params.set('type', type);
    fetch(`/api/titles?${params}`)
      .then(r => r.json())
      .then(d => { setTitles(d.titles || []); setTotal(d.total || 0); })
      .catch(() => setError('Could not load the catalogue. Is MySQL running?'))
      .finally(() => setLoading(false));
  }, [type, sort]);

  async function search(e) {
    e.preventDefault();
    if (!q.trim()) { setResults(null); return; }
    setSearching(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q, mode: 'both', limit: '8' });
      if (type) params.set('type', type);
      const res = await fetch(`/api/search?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResults(data);
    } catch (err) {
      setError(err.message || 'Search failed');
    } finally {
      setSearching(false);
    }
  }

  return (
    <main>
      {/* The hero is the search box, because the product's claim is that it
          understands a sentence rather than keywords. Leading with that puts
          the claim in front of the visitor immediately. */}
      <section className="hero">
        <h1>Describe what you feel like. <em>Not what it is called.</em></h1>
        <p className="hero__lede">
          PlotMatch reads meaning, so &ldquo;a story about losing someone you love&rdquo; finds
          the right film even when none of its words appear in the description.
          Then it gets a whole group to one answer.
        </p>

        <form onSubmit={search} className="searchbar">
          <div>
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="a quiet film about grief and time"
              aria-label="Describe what you want to watch or read"
            />
          </div>
          <button type="submit" disabled={searching}>
            {searching ? 'Searching' : 'Search'}
          </button>
          {results && (
            <button type="button" className="button--quiet"
                    onClick={() => { setResults(null); setQ(''); }}>
              Clear
            </button>
          )}
        </form>
      </section>

      {error && <div className="notice notice--error">{error}</div>}

      {/* The comparison that justifies the vector database. Showing both
          result sets side by side is the demonstration, so it is the UI. */}
      {results && (
        <section className="section">
          <div className="section__head">
            <h2>Two ways of searching &ldquo;{results.query}&rdquo;</h2>
            <span className="muted">
              {results.tookMs} ms · vector backend: {results.backend}
            </span>
          </div>

          <div className="grid grid--split">
            <div className="record record--perforated">
              <h3>By meaning <span className="mark">MongoDB vector search</span></h3>
              {results.semantic?.length ? (
                <table>
                  <thead>
                    <tr><th>Title</th><th>Kind</th><th style={{ textAlign: 'right' }}>Similarity</th></tr>
                  </thead>
                  <tbody>
                    {results.semantic.map(r => (
                      <tr key={r.titleId}>
                        <td><Link href={`/titles/${r.titleId}`}>{r.title}</Link></td>
                        <td><span className={`mark mark--${r.type === 'book' ? 'book' : 'film'}`}>{r.type}</span></td>
                        <td style={{ textAlign: 'right' }}>{r.score.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted">
                  Nothing yet — run <code>npm run embed</code> to build the vectors.
                </p>
              )}
            </div>

            <div className="record">
              <h3>By keyword <span className="mark">MySQL FULLTEXT</span></h3>
              {results.keyword?.length ? (
                <table>
                  <thead>
                    <tr><th>Title</th><th style={{ textAlign: 'right' }}>Relevance</th></tr>
                  </thead>
                  <tbody>
                    {results.keyword.map(r => (
                      <tr key={r.titleId}>
                        <td><Link href={`/titles/${r.titleId}`}>{r.title}</Link></td>
                        <td style={{ textAlign: 'right' }}>{Number(r.score).toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted">
                  No keyword matches. FULLTEXT needs the query&rsquo;s words to appear
                  in the text — which is the limitation the vector index removes.
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      <section className="section">
        <div className="section__head">
          <h2>Catalogue</h2>
          <div className="toolbar">
            <select value={type} onChange={e => setType(e.target.value)}
                    aria-label="Filter by kind" style={{ width: 'auto' }}>
              <option value="">Films and books</option>
              <option value="movie">Films only</option>
              <option value="book">Books only</option>
            </select>
            <select value={sort} onChange={e => setSort(e.target.value)}
                    aria-label="Sort order" style={{ width: 'auto' }}>
              <option value="bayesian">Best rated (weighted)</option>
              <option value="rating">Best rated (raw mean)</option>
              <option value="year">Newest</option>
              <option value="name">A to Z</option>
            </select>
            <span className="muted">{total} entries</span>
          </div>
        </div>

        {loading ? (
          <p className="muted">Loading…</p>
        ) : titles.length === 0 ? (
          <div className="empty">
            <p>The catalogue is empty. Load the seed data with <code>npm run db:setup</code>.</p>
          </div>
        ) : (
          <div className="grid grid--catalogue">
            {titles.map(t => (
              <article key={t.id}
                       className={`record entry entry--${t.type === 'book' ? 'book' : 'film'}`}>
                <div className="entry__head">
                  <div className="entry__title">
                    <Link href={`/titles/${t.id}`}>{t.name}</Link>
                  </div>
                  <span className={`mark mark--${t.type === 'book' ? 'book' : 'film'}`}>
                    {t.type === 'book' ? 'book' : 'film'}
                  </span>
                </div>
                <div className="entry__meta">
                  {t.release_year ?? 'year unknown'}
                  {t.genres ? ` · ${t.genres}` : ''}
                </div>
                <p className="entry__blurb">{t.description}</p>
                <div className="entry__foot">
                  {t.rating_count > 0 ? (
                    <>
                      <span className="score">
                        {Number(t.avg_rating).toFixed(1)}
                        <small> /5</small>
                      </span>
                      <Meter value={Number(t.avg_rating)} />
                      <span className="muted">
                        {t.rating_count} {t.rating_count === 1 ? 'rating' : 'ratings'}
                      </span>
                    </>
                  ) : (
                    <span className="muted">Not yet rated</span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
