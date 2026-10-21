'use client';
import { createClient } from '@supabase/supabase-js';
export const configured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY &&
    process.env.NEXT_PUBLIC_API_URL,
);
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://unconfigured.supabase.co',
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'unconfigured',
  { auth: { flowType: 'pkce', detectSessionInUrl: false } },
);
export async function request(path: string, init: RequestInit = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error('Sign in to access the research workspace.');
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/api/v2${path}`,
    {
      ...init,
      cache: 'no-store',
      signal: init.signal ?? AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    },
  );
  if (!response.ok)
    throw new Error(
      response.status === 403
        ? 'Researcher access is required. Ask your study administrator to approve your participant identifier.'
        : response.status === 401
        ? 'Your session expired. Please sign in again.'
        : `Request failed (${response.status}). Try again.`,
    );
  return response;
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return (await request(path, init)).json();
}
export async function download(path: string, name: string) {
  const blob = await (await request(path)).blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
