'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense } from 'react';

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const next = useSearchParams().get('next') || '/';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err.message || 'Could not sign in');
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 460 }}>
      <h1>Sign in</h1>
      {error && <div className="notice notice--error">{error}</div>}
      <form onSubmit={submit} className="record">
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} required autoComplete="email"
                 onChange={e => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} required autoComplete="current-password"
                 onChange={e => setPassword(e.target.value)} />
        </div>
        <button type="submit" disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button>
      </form>

      <p className="muted" style={{ marginTop: 18 }}>
        New here? <Link href="/register">Create an account</Link>
      </p>

      <div className="record record--perforated" style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 8 }}>Demo accounts</h3>
        <table>
          <tbody>
            <tr><td>admin@plotmatch.dev</td><td>Admin@123</td><td><span className="mark">admin</span></td></tr>
            <tr><td>mod@plotmatch.dev</td><td>Mod@12345</td><td><span className="mark">moderator</span></td></tr>
            <tr><td>sai@plotmatch.dev</td><td>Sai@12345</td><td><span className="mark">user</span></td></tr>
          </tbody>
        </table>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense fallback={<p className="muted">Loading…</p>}><LoginForm /></Suspense>;
}
