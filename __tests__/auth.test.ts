jest.mock('react-native-url-polyfill/auto', () => {});
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
  await expect(accessToken('a')).rejects.toThrow('Sign in again');
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
  await expect(accessToken('a')).rejects.toThrow('Sign in again');
});
