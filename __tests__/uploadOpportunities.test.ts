const mockStorage = new Map<string, string>();
let mockCursorHook: (() => void) | null = null;
let mockDrainHandler: unknown;
const mockNetworkListeners = new Set<(network: any) => void>();
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
  addEventListener: jest.fn(listener => {
    mockNetworkListeners.add(listener);
    return () => mockNetworkListeners.delete(listener);
  }),
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
  ...jest.requireActual('../src/sync/accountSync'),
  createAccountSync: () => mockLegacy,
}));
jest.mock('../src/background/serviceCoordinator', () => ({
  foregroundService: {
    uploading: () => false,
    registerDrain: (handler: unknown) => {
      mockDrainHandler = handler;
      return () => {
        mockDrainHandler = null;
      };
    },
    startUploads: async () => false,
  },
}));
const { syncAccount } = require('../src/sync/background');
const { setTripArmed } = require('../src/services/activityGate');
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1000000);
  jest.clearAllMocks();
  mockStorage.clear();
  mockNetworkListeners.clear();
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
  await syncAccount({ mode: 'background' });
  await syncAccount({ mode: 'background' });
  await syncAccount({ mode: 'background' });
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
  await syncAccount({ mode: 'background' });
  await syncAccount({ mode: 'background' });
  expect(mockLegacy).toHaveBeenCalledTimes(1);
  expect(mockUpload.mock.calls[0][0].id).toBe('new');
});
test('a failing old manifest does not prevent another eligible trip from progressing', async () => {
  mockTrips.push(trip('old', 1), trip('new', 2));
  mockUpload.mockImplementation(async (t: any) => {
    if (t.id === 'old') throw new Error('old manifest');
  });
  expect(await syncAccount()).toMatchObject({
    outcome: 'failed',
    error: expect.objectContaining({ message: 'old manifest' }),
  });
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

test('service drain stops after ten minutes without new acknowledgements', async () => {
  const { drainPostTrip } = require('../src/sync/background');
  mockStorage.set(
    'profile.owner-a',
    JSON.stringify({ consentVersion: 'current', mobileUploads: false }),
  );
  mockTrips.push(trip('stalled', 1));
  const abort = new AbortController();
  let finished = false;
  const work = drainPostTrip(abort.signal, jest.fn()).then(() => {
    finished = true;
  });
  await jest.advanceTimersByTimeAsync(599999);
  expect(finished).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  await work;
  expect(finished).toBe(true);
  expect(mockTrips[0].uploadedRevision).toBeUndefined();
  expect(
    JSON.parse(mockStorage.get('automatic-upload-retry.owner-a')!).nextAt,
  ).toBeGreaterThanOrEqual(Date.now() + 15 * 60000);
});

test('slow failed passes do not extend the ten-minute no-progress deadline', async () => {
  const { drainPostTrip } = require('../src/sync/background');
  mockStorage.set(
    'profile.owner-a',
    JSON.stringify({ consentVersion: 'current', mobileUploads: false }),
  );
  mockTrips.push(trip('stalled', 1));
  mockUpload.mockImplementation(
    async (_trip, _live, _wifi, _persist, _observe, options) =>
      new Promise(resolve => {
        const finish = () => {
          clearTimeout(timer);
          resolve(undefined);
        };
        const timer = setTimeout(finish, 7000);
        options.signal.addEventListener('abort', finish, { once: true });
      }),
  );
  let finished = false;
  const work = drainPostTrip(new AbortController().signal, jest.fn()).then(
    () => {
      finished = true;
    },
  );
  await jest.advanceTimersByTimeAsync(600000);
  expect(finished).toBe(true);
  await work;
});

test('a service joining an existing visible pass retains its new acknowledgement progress', async () => {
  const { drainPostTrip } = require('../src/sync/background');
  mockStorage.set(
    'profile.owner-a',
    JSON.stringify({ consentVersion: 'current', mobileUploads: false }),
  );
  mockTrips.push(trip('shared', 1));
  let finish!: () => void;
  mockUpload
    .mockImplementationOnce(
      async () =>
        new Promise(resolve => {
          finish = () =>
            resolve({
              acknowledged: 7,
              completed: 0,
              pending: true,
              outcome: 'pending',
            } as any);
        }),
    )
    .mockImplementation(
      async (t, _live, _wifi, _persist, _observe, options) => {
        options.onProgress(3, 1);
        t.uploadedRevision = t.revision;
        return {
          acknowledged: 3,
          completed: 1,
          pending: false,
          outcome: 'complete',
        } as any;
      },
    );
  const visible = syncAccount();
  await jest.advanceTimersByTimeAsync(1);
  const progress = jest.fn();
  const work = drainPostTrip(new AbortController().signal, progress);
  await jest.advanceTimersByTimeAsync(1);
  finish();
  await jest.advanceTimersByTimeAsync(1001);
  await Promise.all([visible, work]);
  expect(progress).toHaveBeenCalledWith(
    'Sending saved results. 7 records acknowledged.',
  );
  expect(progress).toHaveBeenLastCalledWith(
    'Sending saved results. 10 records acknowledged.',
  );
});

test('activity teardown preserves the process-owned upload handoff', () => {
  const {
    startAutomaticUploads,
    drainPostTrip,
  } = require('../src/sync/background');
  const stop = startAutomaticUploads();
  expect(mockDrainHandler).toBe(drainPostTrip);
  stop();
  expect(mockDrainHandler).toBe(drainPostTrip);
});

test.each([false, true])(
  'service-owned network checks survive screen teardown (mobileUploads=%s)',
  async mobileUploads => {
    const { drainPostTrip } = require('../src/sync/background');
    mockStorage.set(
      'profile.owner-a',
      JSON.stringify({ consentVersion: 'current', mobileUploads }),
    );
    mockTrips.push(trip('pending', 1));
    let requestSignal!: AbortSignal;
    mockUpload.mockImplementation(
      async (_trip, _live, _wifi, _persist, _observe, options) =>
        new Promise(resolve => {
          requestSignal = options.signal;
          options.signal.addEventListener('abort', () =>
            resolve({
              acknowledged: 0,
              completed: 0,
              pending: true,
              outcome: 'cancelled',
            } as any),
          );
        }),
    );
    const abort = new AbortController();
    const work = drainPostTrip(abort.signal, jest.fn());
    await jest.advanceTimersByTimeAsync(1);
    expect(requestSignal).toBeDefined();
    for (const listener of mockNetworkListeners)
      listener({
        type: 'cellular',
        isConnected: true,
        isInternetReachable: true,
      });
    await jest.advanceTimersByTimeAsync(1);
    expect(requestSignal.aborted).toBe(!mobileUploads);
    expect(mockTrips[0].uploadedRevision).toBeUndefined();
    abort.abort();
    await work;
    expect(mockNetworkListeners.size).toBe(0);
  },
);

test('service drain keeps collecting acknowledgements across passes and finishes without an OS job', async () => {
  const { drainPostTrip } = require('../src/sync/background');
  mockStorage.set(
    'profile.owner-a',
    JSON.stringify({ consentVersion: 'current', mobileUploads: false }),
  );
  mockTrips.push(trip('saved', 1));
  let attempts = 0;
  mockUpload.mockImplementation(
    async (
      t: any,
      _live: any,
      _wifi: any,
      _persist: any,
      _observe: any,
      options: any,
    ) => {
      attempts++;
      options.onProgress(100, 0);
      if (attempts === 2) t.uploadedRevision = t.revision;
      return {
        acknowledged: 100,
        completed: attempts === 2 ? 1 : 0,
        pending: attempts !== 2,
        outcome: attempts === 2 ? 'complete' : 'pending',
      } as any;
    },
  );
  const report = jest.fn();
  let finished = false;
  const work = drainPostTrip(new AbortController().signal, report).then(() => {
    finished = true;
  });
  await jest.advanceTimersByTimeAsync(1001);
  await work;
  expect(finished).toBe(true);
  expect(attempts).toBe(2);
  expect(report).toHaveBeenCalledWith(
    expect.stringContaining('200 records acknowledged'),
  );
  expect(mockUpload.mock.calls[0][5].deadline).toBe(1180000);
});
