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
export function requestError(error: unknown): Error {
  if (error instanceof Error && error.name === 'TimeoutError')
    return new Error(
      'The server took too long to return this data. Retry the request. Your saved measurements have not been deleted.',
    );
  if (error instanceof Error && error.name === 'AbortError')
    return new Error('The request was cancelled. You can retry it.');
  return error instanceof Error
    ? error
    : new Error('Unable to load data. Please retry.');
}
async function request<T>(
  path: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
  timeoutMs = 30000,
): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error('Sign in to access the research workspace.');
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL}/api/v2${path}`,
      {
        ...init,
        cache: 'no-store',
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
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
    return await consume(response);
  } catch (error) {
    // Browsers can report AbortError while consuming a timed-out response body.
    throw requestError(
      timeout.aborted && !init.signal?.aborted ? timeout.reason : error,
    );
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return request(
    path,
    init ?? {},
    response => response.json(),
    path.includes('/research/sessions/') ? 120000 : 30000,
  );
}
export async function download(path: string, name: string) {
  const blob = await request(path, {}, response => response.blob(), 120000);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
