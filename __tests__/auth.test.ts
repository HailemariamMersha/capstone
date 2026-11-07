jest.mock('react-native-url-polyfill/auto', () => {});
jest.mock('../src/config/public.json', () => ({
  supabaseUrl: 'https://test.supabase.co',
  supabasePublishableKey: 'sb_publishable_test',
  apiUrl: 'https://api.example.invalid',
  redirectUrl: 'com.labpracticeapp://auth/callback',
}));
const mockValues = new Map<string, string>();
jest.mock('react-native-get-random-values', () => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {},
  });
});
jest.mock('@noble/hashes/sha2.js', () => ({
  sha256: jest.fn(() => new Uint8Array(32)),
}));
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'secure' },
  getGenericPassword: jest.fn(async ({ service }) =>
    mockValues.has(service) ? { password: mockValues.get(service) } : false,
  ),
  setGenericPassword: jest.fn(async (_user, value, { service }) =>
    mockValues.set(service, value),
  ),
  resetGenericPassword: jest.fn(async ({ service }) =>
    mockValues.delete(service),
  ),
}));
jest.mock('@supabase/supabase-js', () => ({
  processLock: jest.fn(),
  createClient: jest.fn(() => ({
    auth: {
      exchangeCodeForSession: jest.fn().mockResolvedValue({ error: null }),
      getSession: jest.fn(),
      signInAnonymously: jest.fn(),
      refreshSession: jest.fn(),
      signInWithOAuth: jest.fn(),
    },
  })),
}));
jest.mock('react-native-inappbrowser-reborn', () => ({
  InAppBrowser: { openAuth: jest.fn() },
}));
import {
  auth,
  handleAuthCallback,
  secureStorage,
  accessToken,
  signIn,
  api,
} from '../src/auth/client';
beforeEach(() => {
  mockValues.clear();
  jest.clearAllMocks();
});
test('only exact callback origin/path with a recent locally started flow exchanges a code', async () => {
  await handleAuthCallback(
    'com.labpracticeapp://auth/callback?code=unsolicited',
  );
  expect(auth.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  await secureStorage.setItem('oauth-started', String(Date.now()));
  for (const url of [
    'https://auth/callback?code=x',
    'com.labpracticeapp://evil/callback?code=x',
    'com.labpracticeapp://auth/callback/extra?code=x',
    'com.labpracticeapp://auth/callback?code=x#access_token=bad',
  ])
    await handleAuthCallback(url);
  expect(auth.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  await handleAuthCallback('com.labpracticeapp://auth/callback?code=valid');
  expect(auth.auth.exchangeCodeForSession).toHaveBeenCalledWith(
    'valid',
    undefined,
  );
  await handleAuthCallback('com.labpracticeapp://auth/callback?code=valid');
  expect(auth.auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
});
test('cancelled and expired flows never exchange tokens', async () => {
  await secureStorage.setItem('oauth-started', String(Date.now() - 700000));
  await handleAuthCallback('com.labpracticeapp://auth/callback?code=old');
  await secureStorage.setItem('oauth-started', String(Date.now()));
  await expect(
    handleAuthCallback(
      'com.labpracticeapp://auth/callback?error=access_denied',
    ),
  ).rejects.toThrow('cancelled');
  expect(auth.auth.exchangeCodeForSession).not.toHaveBeenCalled();
});
test('uploads refresh expired tokens and refuse account switching', async () => {
  (auth.auth.getSession as jest.Mock).mockResolvedValue({
    data: { session: { user: { id: 'a' }, expires_at: 1 } },
  });
  (auth.auth.refreshSession as jest.Mock).mockResolvedValue({
    data: { session: { user: { id: 'b' }, access_token: 'wrong' } },
    error: null,
  });
  await expect(accessToken('a')).rejects.toThrow('Account changed');
  (auth.auth.refreshSession as jest.Mock).mockResolvedValue({
    data: { session: null },
    error: new Error('revoked'),
  });
  await expect(accessToken('a')).rejects.toThrow(
    'sign-in needs to be restored',
  );
});

test('cached identity survives missing or expired API credentials for offline collection', async () => {
  const { localSession } = require('../src/auth/client');
  await secureStorage.setItem(
    'participant.identity',
    JSON.stringify({
      user: { id: 'a' },
      access_token: 'expired',
      expires_at: 1,
    }),
  );
  (auth.auth.getSession as jest.Mock).mockResolvedValue({
    data: { session: null },
  });
  expect((await localSession()).user.id).toBe('a');
  await expect(accessToken('a')).rejects.toThrow(
    'sign-in needs to be restored',
  );
});

test('anonymous enrollment preserves existing identities and explains disabled signup', async () => {
  const { enrollParticipant } = require('../src/auth/client');
  await secureStorage.setItem('participant.identity', '{corrupt');
  await expect(enrollParticipant()).rejects.toThrow('identity');
  expect(auth.auth.signInAnonymously).not.toHaveBeenCalled();
  await secureStorage.removeItem('participant.identity');
  (auth.auth.signInAnonymously as jest.Mock).mockResolvedValue({
    data: { session: null },
    error: { code: 'anonymous_provider_disabled' },
  });
  await expect(enrollParticipant()).rejects.toThrow('not enabled');
  expect(await secureStorage.getItem('participant.identity')).toBeNull();
  const saved = {
    user: { id: 'new-anonymous-owner', is_anonymous: true },
    access_token: 'test-token',
  };
  (auth.auth.signInAnonymously as jest.Mock).mockResolvedValue({
    data: { session: saved },
    error: null,
  });
  await enrollParticipant('test-captcha');
  expect(auth.auth.signInAnonymously).toHaveBeenLastCalledWith({
    options: { captchaToken: 'test-captcha' },
  });
  expect(
    JSON.parse((await secureStorage.getItem('participant.identity'))!).user.id,
  ).toBe('new-anonymous-owner');
});

test('Google sign-in requests an account chooser and retains S256 PKCE', async () => {
  const { InAppBrowser } = require('react-native-inappbrowser-reborn');
  (auth.auth.signInWithOAuth as jest.Mock).mockResolvedValue({
    data: {
      url: 'https://test.supabase.co/auth/v1/authorize?code_challenge_method=s256',
    },
    error: null,
  });
  InAppBrowser.openAuth.mockResolvedValue({ type: 'cancel' });
  await signIn();
  expect(auth.auth.signInWithOAuth).toHaveBeenCalledWith({
    provider: 'google',
    options: {
      redirectTo: 'com.labpracticeapp://auth/callback',
      skipBrowserRedirect: true,
      queryParams: { prompt: 'select_account' },
    },
  });
  expect(InAppBrowser.openAuth).toHaveBeenCalledWith(
    expect.any(String),
    'com.labpracticeapp://auth/callback',
    expect.objectContaining({ forceCloseOnRedirection: true }),
  );
  expect(await secureStorage.getItem('oauth-started')).toBeNull();
});
test('one server 401 refreshes credentials and retries for the same owner', async () => {
  const session = {
    user: { id: 'a' },
    access_token: 'old',
    expires_at: Date.now() / 1000 + 3600,
  };
  (auth.auth.getSession as jest.Mock).mockResolvedValue({ data: { session } });
  (auth.auth.refreshSession as jest.Mock).mockResolvedValue({
    data: { session: { ...session, access_token: 'fresh' } },
    error: null,
  });
  globalThis.fetch = jest
    .fn()
    .mockResolvedValueOnce({ status: 401, ok: false })
    .mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ role: 'participant' }),
    });
  expect(await api('/profile', {}, 'a')).toEqual({ role: 'participant' });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(
    (fetch as jest.Mock).mock.calls.map(c => c[1].headers.Authorization),
  ).toEqual(['Bearer old', 'Bearer fresh']);
});
test('401 recovery never retries a record with a different account', async () => {
  const session = {
    user: { id: 'a' },
    access_token: 'old',
    expires_at: Date.now() / 1000 + 3600,
  };
  (auth.auth.getSession as jest.Mock).mockResolvedValue({ data: { session } });
  (auth.auth.refreshSession as jest.Mock).mockResolvedValue({
    data: { session: { ...session, user: { id: 'b' }, access_token: 'wrong' } },
    error: null,
  });
  globalThis.fetch = jest.fn().mockResolvedValue({ status: 401, ok: false });
  await expect(api('/profile', {}, 'a')).rejects.toThrow('Account changed');
  expect(fetch).toHaveBeenCalledTimes(1);
});
test.each([
  ['Account deletion requested; uploads are disabled', 'account_deleted'],
  ['Researcher access required', 'researcher_required'],
  ['Current research consent required', 'consent_required'],
])(
  '403 %s is explained without opening a reauthentication loop',
  async (detail, reason) => {
    (auth.auth.getSession as jest.Mock).mockResolvedValue({
      data: {
        session: {
          user: { id: 'a' },
          access_token: 'token',
          expires_at: Date.now() / 1000 + 3600,
        },
      },
    });
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 403,
      ok: false,
      json: async () => ({ detail }),
    });
    await expect(api('/profile', {}, 'a')).rejects.toMatchObject({
      status: 403,
      reason,
    });
    expect(auth.auth.refreshSession).not.toHaveBeenCalled();
  },
);
test('a repeated server 401 stops after one refresh attempt', async () => {
  const session = {
    user: { id: 'a' },
    access_token: 'token',
    expires_at: Date.now() / 1000 + 3600,
  };
  (auth.auth.getSession as jest.Mock).mockResolvedValue({ data: { session } });
  (auth.auth.refreshSession as jest.Mock).mockResolvedValue({
    data: { session },
    error: null,
  });
  globalThis.fetch = jest.fn().mockResolvedValue({ status: 401, ok: false });
  await expect(api('/profile', {}, 'a')).rejects.toMatchObject({
    status: 401,
    reason: 'sign_in_required',
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
test('ingestion is not silently replayed outside durable retry/budget accounting', async () => {
  const session = {
    user: { id: 'a' },
    access_token: 'token',
    expires_at: Date.now() / 1000 + 3600,
  };
  (auth.auth.getSession as jest.Mock).mockResolvedValue({ data: { session } });
  globalThis.fetch = jest.fn().mockResolvedValue({ status: 401, ok: false });
  await expect(
    api('/sessions/s/records', { method: 'POST', body: '{"records":[]}' }, 'a'),
  ).rejects.toMatchObject({ status: 401 });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(auth.auth.refreshSession).not.toHaveBeenCalled();
});

test('upload parent cancellation does not replace the per-request timeout', async () => {
  jest.useFakeTimers();
  (auth.auth.getSession as jest.Mock).mockResolvedValue({
    data: {
      session: {
        user: { id: 'a' },
        access_token: 'token',
        expires_at: Date.now() / 1000 + 3600,
      },
    },
  });
  const parent = new AbortController();
  globalThis.fetch = jest.fn(
    (_url, options) =>
      new Promise((_, reject) => {
        options!.signal!.addEventListener(
          'abort',
          () => reject(new Error('request timeout')),
          { once: true },
        );
      }),
  ) as any;
  const pending = api(
    '/sessions/s/complete',
    { method: 'POST', signal: parent.signal },
    'a',
  );
  const rejected = expect(pending).rejects.toThrow('request timeout');
  await jest.advanceTimersByTimeAsync(15000);
  await rejected;
  expect(parent.signal.aborted).toBe(false);
  expect((fetch as jest.Mock).mock.calls[0][1].signal).not.toBe(parent.signal);
  jest.useRealTimers();
});
