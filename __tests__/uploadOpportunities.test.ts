const mockStorage = new Map<string, string>();
let mockCursorHook: (() => void) | null = null;
const mockLegacy = Object.assign(
  jest.fn(async () => {}),
  { cancel: jest.fn() },
);
const mockUpload = jest.fn<Promise<void>, any[]>(async () => {});
const mockTrips: any[] = [];
const mockSessions: any[] = [];
jest.mock('react-native-background-fetch', () => ({
  configure: jest.fn(),
  finish: jest.fn(),
}));
jest.mock('react-native-background-actions', () => ({
  isRunning: () => false,
}));
jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => () => {}),
  fetch: async () => ({
    isConnected: true,
    isInternetReachable: true,
    type: 'wifi',
  }),
}));
jest.mock('../src/auth/client', () => ({
  localSession: async () => ({ user: { id: 'owner-a' } }),
  api: jest.fn(),
  secureStorage: {
    getItem: async (k: string) => mockStorage.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      mockStorage.set(k, v);
      mockCursorHook?.();
    },
  },
}));
jest.mock('../src/storage/database', () => ({
  measurementStore: {
    accountTrips: async () => mockTrips,
    accountSessions: async () => mockSessions,
    saveTrip: jest.fn(),
    nextUploadAttempt: jest.fn(async () => null),
  },
}));
jest.mock('../src/trips/runtime', () => ({ recoverTrips: jest.fn() }));
jest.mock('../src/trips/sync', () => ({
  uploadTrip: (...a: any[]) => mockUpload(...a),
  cancelTripUpload: jest.fn(),
}));
jest.mock('../src/sync/accountSync', () => ({
  createAccountSync: () => mockLegacy,
}));
const { syncAccount } = require('../src/sync/background');
const { setTripArmed } = require('../src/services/activityGate');
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1000000);
  jest.clearAllMocks();
  mockStorage.clear();
  mockCursorHook = null;
  mockTrips.length = 0;
  mockSessions.length = 0;
  setTripArmed(false);
  mockUpload.mockReset().mockResolvedValue(undefined);
  mockLegacy.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  setTripArmed(false);
  jest.useRealTimers();
});
const trip = (id: string, startedAt: number) => ({
  id,
  startedAt,
  state: 'completed',
  revision: 1,
});
test('two old trips cannot starve a newer trip across bounded opportunities', async () => {
  mockTrips.push(trip('old-1', 1), trip('old-2', 2), trip('new', 3));
  mockUpload.mockImplementation(async () => {
    jest.setSystemTime(Date.now() + 26000);
  });
  await syncAccount();
  await syncAccount();
  await syncAccount();
  expect(mockUpload.mock.calls.map(c => c[0].id)).toEqual([
    'old-1',
    'old-2',
    'new',
  ]);
});
test('a long legacy backlog also yields its next opportunity to a trip', async () => {
  mockSessions.push({
    state: 'completed',
    uploadStatus: 'Saved locally',
    config: {},
  });
  mockTrips.push(trip('new', 3));
  mockLegacy.mockImplementation(async () => {
    jest.setSystemTime(Date.now() + 26000);
  });
  mockUpload.mockImplementation(async () => {
    jest.setSystemTime(Date.now() + 26000);
  });
  await syncAccount();
  await syncAccount();
  expect(mockLegacy).toHaveBeenCalledTimes(1);
  expect(mockUpload.mock.calls[0][0].id).toBe('new');
});
test('a failing old manifest does not prevent another eligible trip from progressing', async () => {
  mockTrips.push(trip('old', 1), trip('new', 2));
  mockUpload.mockImplementation(async (t: any) => {
    if (t.id === 'old') throw new Error('old manifest');
  });
  await expect(syncAccount()).rejects.toThrow('old manifest');
  expect(mockUpload.mock.calls.map(c => c[0].id)).toEqual(['old', 'new']);
});
test('armed collection prevents every upload task', async () => {
  mockTrips.push(trip('new', 1));
  setTripArmed(true);
  await syncAccount();
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockLegacy).not.toHaveBeenCalled();
});
test('completed acknowledgements skip tasks and cursors are scoped to the initiating owner', async () => {
  mockStorage.set('upload-opportunity-cursor.owner-b', 'new');
  mockTrips.push(
    { ...trip('complete', 1), uploadedRevision: 1 },
    trip('new', 2),
  );
  await syncAccount();
  expect(mockUpload.mock.calls.map(c => c[0].id)).toEqual(['new']);
  expect(mockStorage.get('upload-opportunity-cursor.owner-a')).toBe('new');
});

test('visible app automatically retries a pending trip without a Retry button or connection event', async () => {
  const { AppState } = require('react-native');
  const old = AppState.currentState;
  AppState.currentState = 'active';
  mockStorage.set(
    'profile.owner-a',
    JSON.stringify({ consentVersion: 'current', mobileUploads: false }),
  );
  mockTrips.push(trip('pending', 1));
  mockUpload.mockImplementation(async (t: any) => {
    t.uploadedRevision = t.revision;
  });
  const stop = require('../src/sync/background').startAutomaticUploads();
  try {
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60000);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    AppState.currentState = old;
  }
});
test('automatic manifest failure backoff survives foreground scheduler recreation', async () => {
  const { AppState } = require('react-native');
  const old = AppState.currentState;
  AppState.currentState = 'active';
  mockStorage.set(
    'profile.owner-a',
    JSON.stringify({ consentVersion: 'current', mobileUploads: false }),
  );
  mockTrips.push(trip('pending', 1));
  mockUpload.mockRejectedValueOnce(new Error('temporary'));
  let stop = require('../src/sync/background').startAutomaticUploads();
  try {
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(
      mockStorage.get('automatic-upload-retry.owner-a')!,
    );
    expect(saved.nextAt).toBeGreaterThan(Date.now());
    stop();
    stop = require('../src/sync/background').startAutomaticUploads();
    await jest.advanceTimersByTimeAsync(14999);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockUpload).toHaveBeenCalledTimes(2);
  } finally {
    stop();
    AppState.currentState = old;
  }
});

test('a trip starting during cursor persistence prevents the next upload task', async () => {
  mockTrips.push(trip('pending', 1));
  mockCursorHook = () => setTripArmed(true);
  await syncAccount();
  expect(mockUpload).not.toHaveBeenCalled();
});
