import 'react-native-url-polyfill/auto';
import 'react-native-get-random-values';
import 'fast-text-encoding';
import { sha256 } from '@noble/hashes/sha2.js';
import { createClient, type Session } from '@supabase/supabase-js';
import * as Keychain from 'react-native-keychain';
import { InAppBrowser } from 'react-native-inappbrowser-reborn';
import configuration from '../config/public.json';

// React Native supplies randomness through get-random-values. Supabase's PKCE
// must use S256 even where WebCrypto.digest is absent (never the plain fallback).
const cryptoGlobal = (globalThis as unknown as { crypto: { subtle?: unknown } })
  .crypto;
if (!cryptoGlobal.subtle) {
  Object.defineProperty(cryptoGlobal, 'subtle', {
    value: {
      async digest(algorithm: string, data: ArrayBuffer) {
        if (algorithm !== 'SHA-256') throw new Error('Unsupported digest');
        return sha256(new Uint8Array(data)).buffer;
      },
    },
  });
}
export const secureStorage = {
  async getItem(key: string) {
    const result = await Keychain.getGenericPassword({
      service: `skymeasure.${key}`,
    });
    return result ? result.password : null;
  },
  async setItem(key: string, value: string) {
    await Keychain.setGenericPassword('skymeasure', value, {
      service: `skymeasure.${key}`,
      accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  },
  async removeItem(key: string) {
    await Keychain.resetGenericPassword({ service: `skymeasure.${key}` });
  },
};
export const configured = Boolean(
  configuration.supabaseUrl &&
    configuration.supabasePublishableKey &&
    configuration.apiUrl,
);
export const auth = createClient(
  configuration.supabaseUrl || 'https://unconfigured.supabase.co',
  configuration.supabasePublishableKey || 'unconfigured',
  {
    global: {
      fetch: async (input, init) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          return await fetch(input, {
            ...init,
            signal: init?.signal ?? controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      },
    },
    auth: {
      storageKey: 'skymeasure.auth',
      storage: secureStorage,
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  },
);
// Read only the encrypted prior session for offline UI. Authorization still
// requires a refreshed/verified token in api(); cached identity grants no server access.
export async function localSession(): Promise<Session | null> {
  const raw =
    (await secureStorage.getItem('participant.identity')) ??
    (await secureStorage.getItem('skymeasure.auth'));
  if (!raw) return null;
  try {
    const session = JSON.parse(raw);
    return typeof session?.user?.id === 'string' &&
      typeof session?.access_token === 'string'
      ? session
      : null;
  } catch {
    return null;
  }
}
const participantListeners = new Set<(session: Session | null) => void>();
export function subscribeParticipant(
  listener: (session: Session | null) => void,
) {
  participantListeners.add(listener);
  return () => {
    participantListeners.delete(listener);
  };
}
export async function rememberParticipant(session: Session) {
  await secureStorage.setItem('participant.identity', JSON.stringify(session));
  participantListeners.forEach(listener => listener(session));
}
export async function signOutParticipant() {
  try {
    await auth.auth.signOut({ scope: 'local' });
  } finally {
    await secureStorage.removeItem('participant.identity');
    await secureStorage.removeItem('skymeasure.auth');
    await secureStorage.removeItem('oauth-started');
    participantListeners.forEach(listener => listener(null));
  }
}
let exchanging: Promise<void> | null = null;
export async function handleAuthCallback(url: string) {
  const parsed = new URL(url);
  const expected = new URL(configuration.redirectUrl);
  if (
    parsed.protocol !== expected.protocol ||
    parsed.host !== expected.host ||
    parsed.pathname !== expected.pathname ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  )
    return;
  const pending = Number(await secureStorage.getItem('oauth-started'));
  if (!pending || Date.now() - pending > 600000) return;
  if (parsed.searchParams.has('error')) {
    await secureStorage.removeItem('oauth-started');
    throw new Error(
      'Google sign-in was cancelled or declined. Please try again.',
    );
  }
  const code = parsed.searchParams.get('code');
  if (!code) return;
  if (exchanging) return exchanging;
  exchanging = (async () => {
    const { error } = await auth.auth.exchangeCodeForSession(
      code,
      parsed.searchParams.get('sb_flow_id')
        ? { flowId: parsed.searchParams.get('sb_flow_id')! }
        : undefined,
    );
    await secureStorage.removeItem('oauth-started');
    if (error)
      throw new Error('Sign-in could not be completed. Please try again.');
  })();
  try {
    await exchanging;
  } finally {
    exchanging = null;
  }
}
export async function signIn() {
  if (!configured)
    throw new Error(
      'This staging build needs its research service configuration. See the SkyMeasure setup guide.',
    );
  await secureStorage.setItem('oauth-started', String(Date.now()));
  const { data, error } = await auth.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: configuration.redirectUrl,
      skipBrowserRedirect: true,
    },
  });
  if (error || !data.url)
    throw new Error('Could not open Google sign-in. Check your connection.');
  if (
    new URL(data.url).searchParams
      .get('code_challenge_method')
      ?.toLowerCase() !== 's256'
  )
    throw new Error('Secure sign-in could not be initialized.');
  const result = await InAppBrowser.openAuth(
    data.url,
    configuration.redirectUrl,
    { ephemeralWebSession: true, showTitle: false },
  );
  if (result.type === 'success') await handleAuthCallback(result.url);
  else await secureStorage.removeItem('oauth-started');
}
export interface Profile {
  participantId: string;
  role: 'participant' | 'researcher' | 'administrator';
  consentVersion: string | null;
  requiredConsentVersion: string;
  mobileUploads: boolean;
}
export async function accessToken(expectedOwner?: string) {
  let {
    data: { session },
  } = await auth.auth.getSession();
  if (!session || (expectedOwner && session.user.id !== expectedOwner))
    throw new Error('Sign in again to upload your saved sessions.');
  if ((session.expires_at ?? 0) < Date.now() / 1000 + 90) {
    const refreshed = await auth.auth.refreshSession();
    if (refreshed.error || !refreshed.data.session)
      throw new Error('Sign in again to upload your saved sessions.');
    session = refreshed.data.session;
  }
  if (expectedOwner && session.user.id !== expectedOwner)
    throw new Error('Account changed');
  return session.access_token;
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
  owner?: string,
): Promise<T> {
  const token = await accessToken(owner);
  if (options.signal?.aborted)
    throw new Error('Upload opportunity ended; retry pending');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response: Response;
  try {
    response = await fetch(`${configuration.apiUrl}/api/v2${path}`, {
      ...options,
      signal: options.signal ?? controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new Error(
        'Action needed: sign in again or review your research access.',
      );
    throw new Error(
      `Research service could not complete this request (${response.status}). Your saved data is safe.`,
    );
  }
  return response.json();
}
export async function loadProfile(owner: string): Promise<Profile> {
  const result = await api<Profile>('/profile', {}, owner);
  await secureStorage.setItem(`profile.${owner}`, JSON.stringify(result));
  return result;
}
