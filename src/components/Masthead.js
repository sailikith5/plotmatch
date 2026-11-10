'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

export default function Masthead() {
  const [me, setMe] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setMe(d?.user ?? null))
      .catch(() => setMe(null))
      .finally(() => setLoaded(true));
  }, [pathname]);

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setMe(null);
    router.push('/');
    router.refresh();
  }

  const is = (p) => (pathname === p || pathname.startsWith(p + '/') ? 'active' : '');

  return (
    <>
      <header className="masthead">
        <Link href="/" className="wordmark">Plot<span>Match</span></Link>
        <nav>
          <Link href="/" className={is('/')}>Catalogue</Link>
          {me && <Link href="/sessions" className={is('/sessions')}>Sessions</Link>}
          {me && <Link href="/watchlist" className={is('/watchlist')}>Watchlist</Link>}
          {me?.role === 'admin' && <Link href="/admin" className={is('/admin')}>Admin</Link>}
          {loaded && !me && <Link href="/login">Sign in</Link>}
          {me && (
            <span className="whoami">
              <b>{me.name}</b> · {me.role} ·{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }}>Sign out</a>
            </span>
          )}
        </nav>
      </header>
      <div className="masthead-rule" />
    </>
  );
}
