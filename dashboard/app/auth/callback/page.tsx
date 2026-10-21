'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/client';
let exchange: Promise<unknown> | null = null;
export default function Callback() {
  const [error, setError] = useState('');
  useEffect(() => {
    const params = new URL(window.location.href).searchParams;
    const code = params.get('code');
    if (!code) {
      setError('Sign-in was cancelled. Return to the workspace to try again.');
      return;
    }
    exchange ??= supabase.auth
      .exchangeCodeForSession(
        code,
        params.get('sb_flow_id')
          ? { flowId: params.get('sb_flow_id')! }
          : undefined,
      )
      .then(({ error: e }) => {
        if (e) throw e;
      });
    exchange
      .then(() => window.location.replace('/'))
      .catch(() =>
        setError('Sign-in could not be completed. Please try again.'),
      );
  }, []);
  return (
    <main className="mx-auto max-w-lg p-12">
      <h1 className="text-3xl font-semibold">SkyMeasure</h1>
      <p className="my-6" role="status">
        {error || 'Completing your secure sign-in…'}
      </p>
      {error && <a href="/">Return to sign-in</a>}
    </main>
  );
}
