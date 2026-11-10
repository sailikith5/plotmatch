'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function RegisterPage() {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      router.push('/');
      router.refresh();
    } catch (err) {
      setError(err.message || 'Could not create the account');
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 460 }}>
      <h1>Create an account</h1>
      {error && <div className="notice notice--error">{error}</div>}
      <form onSubmit={submit} className="record">
        <div className="field">
          <label htmlFor="name">Name</label>
          <input id="name" value={form.name} required onChange={set('name')} />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={form.email} required
                 autoComplete="email" onChange={set('email')} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={form.password} required minLength={8}
                 autoComplete="new-password" onChange={set('password')} />
          <div className="hint">At least 8 characters. Stored as a salted scrypt hash.</div>
        </div>
        <button type="submit" disabled={busy}>{busy ? 'Creating' : 'Create account'}</button>
      </form>
      <p className="muted" style={{ marginTop: 18 }}>
        Already registered? <Link href="/login">Sign in</Link>
      </p>
    </main>
  );
}
