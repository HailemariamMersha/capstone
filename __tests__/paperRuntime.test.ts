jest.mock('../src/measurements/paperProbes', () => ({
  paperCharge: jest.requireActual('../src/measurements/paperProbes')
    .paperCharge,
  runPaperProbe: jest.fn(async (attempt, _config, job) => ({
    ...attempt,
    type: job.type,
    targetId: job.targetId,
    roundId: job.roundId,
    success: true,
    durationMs: 0,
    value: job.type === 'cdn_fetch' ? 0 : null,
    paper: { bodyBytes: job.type === 'cdn_fetch' ? 89501 : 113 },
    raw: {
      callbacks: [
        {
          value: {
            bodyBytesKnown: true,
            bodyBytes: job.type === 'cdn_fetch' ? 89501 : 113,
          },
        },
      ],
    },
  })),
}));
jest.mock('../src/reference/tripMlab', () => ({
  requireMlabConsent: jest.fn(async () => {}),
  runTripMlab: jest.fn(async () => [
    { type: 'ndt7_download', success: true },
    { type: 'ndt7_upload', success: true },
  ]),
  MLAB_CONSENT: 'skymeasure-flight-pilot-2026-11-14',
  MLAB_RESERVATION: 200 * 1048576,
}));
const mockEvents: unknown[] = [];
const mockTrips: any[] = [];
const mockSessions: any[] = [];
const mockStore = {
  initialize: jest.fn(),
  saveTripPayment: jest.fn(),
  accountTrips: jest.fn(async () => mockTrips),
  accountSessions: jest.fn(async () => mockSessions),
  saveTrip: jest.fn(async (t: any) => {
    mockTrips[0] = JSON.parse(JSON.stringify(t));
  }),
  createSession: jest.fn(async (config: any, _: unknown, ownerId: string) => {
    const id = `s${mockSessions.length}`;
    mockSessions.push({ id, ownerId, config, state: 'active' });
    return id;
  }),
  endSession: jest.fn(async (id: string) => {
    mockSessions.find(s => s.id === id).state = 'completed';
  }),
  addEvent: jest.fn(async (...args: unknown[]) => {
    mockEvents.push(args);
  }),
  touchSession: jest.fn(),
  saveSnapshot: jest.fn(async (_: unknown, s: any) => ({
    ...s,
    id: 'snapshot',
  })),
  beginAttempt: jest.fn(async (_: unknown, type: string) => ({
    id: 'attempt',
    type,
  })),
  finishAttempt: jest.fn(),
};
jest.mock('../src/storage/database', () => ({
  get measurementStore() {
    return mockStore;
  },
}));
jest.mock('react-native', () => ({
  NativeModules: {
    FlightNetwork: {
      bindWifi: jest.fn(async () => ({
        networkKey: 'wifi',
        handle: '1',
        ssid: 'Home',
        bssid: null,
        validated: true,
        bound: true,
      })),
      release: jest.fn(async () => {}),
    },
  },
  NativeEventEmitter: class {
    addListener() {
      return { remove() {} };
    }
  },
}));
jest.mock('react-native-device-info', () => ({
  getBatteryLevel: jest.fn(async () => 1),
  isBatteryCharging: jest.fn(async () => true),
}));
jest.mock('../src/background/backgroundExecutor', () => ({
  createBackgroundExecutor: () => ({
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
  }),
}));
jest.mock('../src/measurements/runProbe', () => ({
  runProbe: jest.fn(async () => ({ success: true })),
}));
jest.mock('../src/measurements/diagnostics', () => ({
  runDiagnostic: jest.fn(async () => ({ success: true })),
}));
jest.mock('../src/participant/defaults', () => ({
  participantDefaults: {
    serverUrl: 'https://probe.invalid',
    httpEnabled: true,
  },
}));
jest.mock('../src/trips/location', () => ({
  locationFix: jest.fn(async () => null),
}));
jest.mock('../src/trips/sync', () => ({
  uploadTrip: jest.fn(async () => {}),
  cancelTripUpload: jest.fn(),
}));
import {
  startTrip as startTripImpl,
  stopTrip,
  currentTrip,
} from '../src/trips/runtime';
const fullFlight = {
  flightNumber: 'TEST001',
  departure: 'Test origin',
  arrival: 'Test destination',
  expectedMinutes: 1440,
};
const startTrip = (owner: string, flight: any, shadow = false, options?: any) =>
  startTripImpl(owner, { ...fullFlight, ...flight }, shadow, {
    netId: 'abc123',
    ...options,
  });
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1000000);
  mockEvents.length = 0;
  mockTrips.length = 0;
  mockSessions.length = 0;
  jest.clearAllMocks();
  require('../src/measurements/diagnostics')
    .runDiagnostic.mockReset()
    .mockResolvedValue({ success: true });
  require('../src/measurements/runProbe')
    .runProbe.mockReset()
    .mockResolvedValue({ success: true });
  require('../src/reference/tripMlab')
    .runTripMlab.mockReset()
    .mockResolvedValue([
      { type: 'ndt7_download', success: true },
      { type: 'ndt7_upload', success: true },
    ]);
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: (b: Uint8Array) => b.fill(10) },
  });
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    headers: { get: () => '1' },
    text: async () => JSON.stringify({ asn: 1 }),
  })) as any;
});
afterEach(async () => {
  await stopTrip();
  jest.useRealTimers();
});

test('new trips execute five independent targets and five CDN providers per complete round without controlled transfers', async () => {
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    headers: { get: () => '1' },
    text: async () => JSON.stringify({ asn: 14593 }),
  })) as any;
  await startTrip('owner', {});
  await jest.advanceTimersByTimeAsync(32 * 60000);
  const { runPaperProbe } = require('../src/measurements/paperProbes');
  const jobs = runPaperProbe.mock.calls.map((c: any) => c[2]);
  const rounds = [...new Set(jobs.map((j: any) => j.roundId))].slice(0, 2);
  expect(rounds).toHaveLength(2);
  for (const round of rounds) {
    const rows = jobs.filter((j: any) => j.roundId === round);
    expect(
      new Set(
        rows
          .filter((j: any) => j.type === 'traceroute')
          .map((j: any) => j.targetId),
      ).size,
    ).toBe(5);
    expect(
      new Set(
        rows
          .filter((j: any) => j.type === 'cdn_fetch')
          .map((j: any) => j.targetId),
      ).size,
    ).toBe(5);
    expect(rows.filter((j: any) => j.type === 'dns_resolver')).toHaveLength(1);
  }
  expect(
    require('../src/measurements/runProbe').runProbe,
  ).not.toHaveBeenCalled();
  expect(currentTrip()!.transferPairs).toBe(0);
  expect(currentTrip()!.nextTransferAt).toBeNull();
  expect(currentTrip()!.used.transfers).toBe(10 * 89501);
  expect(currentTrip()!.contentReservations).toEqual({});
  expect(
    mockSessions.every(
      s =>
        s.config.httpEnabled === false &&
        s.config.measurementSuiteVersion === 'paper-core-v1' &&
        !s.config.transferSchedule,
    ),
  ).toBe(true);
  expect(mockSessions[0].config.maxPayloadBytes).toBeNull();
  expect(mockSessions[0].config.pilotTestAsnsEnabled).toBe(false);
  expect(
    require('../src/reference/tripMlab').runTripMlab,
  ).toHaveBeenCalledTimes(1);
  expect(
    require('../src/reference/tripMlab').runTripMlab.mock.calls[0][7],
  ).toBe(true);
});
test('Stop retains partial CDN bytes and settles its reservation without treating cancellation as completed content', async () => {
  const { runPaperProbe } = require('../src/measurements/paperProbes');
  runPaperProbe.mockImplementation(
    async (attempt: any, _c: any, job: any, _h: any, signal: AbortSignal) => {
      if (job.type !== 'cdn_fetch')
        return { ...attempt, success: true, durationMs: 0 };
      return new Promise(resolve =>
        signal.addEventListener(
          'abort',
          () =>
            resolve({
              ...attempt,
              type: 'cdn_fetch',
              success: false,
              errorType: 'cancelled',
              durationMs: 30000,
              value: null,
              paper: { bodyBytes: 128 },
              raw: {
                callbacks: [
                  { value: { bodyBytesKnown: true, bodyBytes: 128 } },
                ],
              },
            }),
          { once: true },
        ),
      );
    },
  );
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    headers: { get: () => '1' },
    text: async () => JSON.stringify({ asn: 14593 }),
  })) as any;
  await startTrip('owner', {});
  await jest.advanceTimersByTimeAsync(5 * 60000);
  await stopTrip();
  expect(currentTrip()!.used.transfers).toBe(128);
  expect(currentTrip()!.contentReservations).toEqual({});
  expect(
    mockStore.finishAttempt.mock.calls.some(
      (c: any) =>
        c[0].type === 'cdn_fetch' &&
        c[0].errorType === 'interrupted' &&
        c[0].interruptionReason === 'participant_stop',
    ),
  ).toBe(true);
});
