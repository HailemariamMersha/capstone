// These frozen lifecycle fixtures exercise the pre-paper policies, which remain readable.
jest.mock('../src/trips/policy', () => ({
  newTripPolicy: (pilot: boolean) => {
    const model = jest.requireActual('../src/trips/model');
    return pilot ? model.PILOT_TRIP_POLICY : model.TRIP_POLICY;
  },
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
  tripRunning,
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
import { uploadTrip } from '../src/trips/sync';
import { currentActivity, isTripArmed } from '../src/services/activityGate';
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
test('a nonqualifying trip stays armed, rotates owned segments and preserves its allowance', async () => {
  await startTrip('owner', { flightNumber: 'TEST' });
  await jest.advanceTimersByTimeAsync(900001);
  expect(tripRunning()).toBe(true);
  expect(currentTrip()).toMatchObject({
    phase: 'watching',
    firstQualifiedAt: null,
    segmentCount: 2,
  });
  expect(mockSessions.map(s => s.config.segmentIndex)).toEqual([0, 1]);
  expect(mockSessions[0].state).toBe('completed');
  expect(mockSessions.every(s => s.ownerId === 'owner')).toBe(true);
  expect(uploadTrip).toHaveBeenCalledTimes(1);
  expect(currentTrip()!.used.diagnostics).toBeGreaterThan(2048);
  expect(isTripArmed()).toBe(true);
  expect(currentActivity()).toBe('measurement');
  await stopTrip();
  expect(tripRunning()).toBe(false);
  expect(isTripArmed()).toBe(false);
  expect(currentActivity()).toBeNull();
});
test('shadow collection is labelled and segment rotation does not reset probe deadlines', async () => {
  await startTrip('researcher', {}, true);
  await jest.advanceTimersByTimeAsync(900001);
  expect(mockStore.beginAttempt).toHaveBeenCalled();
  expect(
    mockSessions.every(s => s.config.collectionMode === 'detector_shadow'),
  ).toBe(true);
  expect(currentTrip()!.due.traceroute).toBeGreaterThan(1000000);
  expect(mockEvents.some((row: any) => row[1] === 'upload_pause')).toBe(true);
});

test('M-Lab runs once across segment rotations and reserves 200 MiB without resetting controlled transfers', async () => {
  const { runTripMlab } = require('../src/reference/tripMlab');
  await startTrip('researcher', {}, true);
  await jest.advanceTimersByTimeAsync(1800001);
  expect(runTripMlab).toHaveBeenCalledTimes(1);
  expect(runTripMlab.mock.calls[0][1]).toBe('s0');
  expect(currentTrip()!.segmentCount).toBe(3);
  expect(currentTrip()!.mlab).toMatchObject({
    reserved: true,
    status: 'complete',
  });
  expect(currentTrip()!.used.transfers).toBe(200 * 1048576 + 6000000);
  expect(currentTrip()!.transferPairs).toBe(1);
  expect(mockSessions[0].config.maxPayloadBytes).toBe(300 * 1048576);
});
test('waiting without qualifying connectivity never publishes an M-Lab test', async () => {
  const { runTripMlab } = require('../src/reference/tripMlab');
  await startTrip('owner', {});
  await jest.advanceTimersByTimeAsync(1200001);
  expect(runTripMlab).not.toHaveBeenCalled();
  expect(currentTrip()!.used.transfers).toBe(0);
});

test('ASN alone qualifies without reading GPS or needing an airline SSID', async () => {
  const { NativeModules } = require('react-native');
  NativeModules.FlightNetwork.bindWifi.mockResolvedValueOnce({
    networkKey: 'network:1',
    handle: '1',
    ssid: null,
    bssid: null,
    validated: true,
    bound: true,
  });
  // Keep the same Wi-Fi handle throughout both confirmation observations.
  NativeModules.FlightNetwork.bindWifi.mockResolvedValue({
    networkKey: 'network:1',
    handle: '1',
    ssid: null,
    bssid: null,
    validated: true,
    bound: true,
  });
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    headers: { get: () => '1' },
    text: async () => JSON.stringify({ asn: 14593 }),
  })) as any;
  try {
    await startTrip('owner', {}, false);
    await jest.advanceTimersByTimeAsync(31000);
    expect(currentTrip()).toMatchObject({
      phase: 'collecting',
      detectorPolicy: { version: 'asn-only-v1' },
      evidence: { confidence: 'asn_matched', gpsDetails: null },
    });
    expect(require('../src/trips/location').locationFix).not.toHaveBeenCalled();
    expect(mockSessions[0].config.detectorPolicy.version).toBe('asn-only-v1');
    expect(mockStore.beginAttempt).toHaveBeenCalled();
  } finally {
    NativeModules.FlightNetwork.bindWifi.mockResolvedValue({
      networkKey: 'wifi',
      handle: '1',
      ssid: 'Home',
      bssid: null,
      validated: true,
      bound: true,
    });
  }
});

test('a simulated 35-minute sleep records a gap without firing overdue heavy tasks', async () => {
  const { runProbe } = require('../src/measurements/runProbe');
  const { runTripMlab } = require('../src/reference/tripMlab');
  await startTrip('researcher', {}, true);
  await jest.advanceTimersByTimeAsync(1000);
  jest.setSystemTime(Date.now() + 35 * 60000);
  await jest.advanceTimersByTimeAsync(1000);
  expect(
    mockEvents.some(
      (r: any) => r[1] === 'collector_gap' && r[2].durationMs >= 35 * 60000,
    ),
  ).toBe(true);
  expect(runProbe).not.toHaveBeenCalled();
  expect(runTripMlab).not.toHaveBeenCalled();
  expect(
    mockStore.beginAttempt.mock.calls.filter(
      (r: any) => r[1] === 'tcp_connect',
    ),
  ).toHaveLength(0);
});

test('detection keeps ticking while a measurement is busy and logs its real scheduling time', async () => {
  const { runDiagnostic } = require('../src/measurements/diagnostics');
  runDiagnostic.mockImplementationOnce(
    () =>
      new Promise(resolve =>
        setTimeout(() => resolve({ success: true }), 100000),
      ),
  );
  await startTrip('researcher', {}, true);
  await jest.advanceTimersByTimeAsync(91000);
  expect(
    mockEvents.filter((r: any) => r[1] === 'flight_detection').length,
  ).toBeGreaterThanOrEqual(4);
  expect(mockStore.finishAttempt).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(20000);
  expect(mockStore.finishAttempt.mock.calls[0][0]).toMatchObject({
    scheduledAt: expect.any(String),
    scheduling: { wallDurationMs: 100000, latenessMs: expect.any(Number) },
  });
  expect(mockEvents.some((r: any) => r[1] === 'measurement_saved')).toBe(true);
});

test('identity failures retry promptly and remain unknown without replacing fresh evidence', async () => {
  globalThis.fetch = jest
    .fn()
    .mockRejectedValue(new Error('saturated link')) as any;
  await startTrip('owner', {});
  await jest.advanceTimersByTimeAsync(16000);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect(currentTrip()!.evidence!.asn.state).toBe('unknown');
  expect(
    mockEvents.some(
      (r: any) =>
        r[1] === 'collector_identity' && r[2].reason === 'network_error',
    ),
  ).toBe(true);
});

test('an old identity response is not made fresh when its callback finally arrives', async () => {
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    headers: { get: () => '1' },
    text: async () =>
      JSON.stringify({ asn: 14593, observedAt: (Date.now() - 180000) / 1000 }),
  })) as any;
  await startTrip('owner', {});
  await jest.advanceTimersByTimeAsync(1000);
  expect(currentTrip()!.evidence!.asn.state).toBe('unknown');
  expect(currentTrip()!.evidence!.provider).toBeNull();
});

test('a boundary cancels a long transfer, keeps control evidence and closes before uploading', async () => {
  const timeout = jest
    .spyOn(require('../src/trips/scheduler'), 'transferTimeout')
    .mockReturnValue(700000);
  const { runProbe } = require('../src/measurements/runProbe');
  runProbe.mockImplementation(
    (_: unknown, __: unknown, ___: unknown, signal: AbortSignal) =>
      new Promise(resolve => {
        const done = () => resolve({ success: false, errorType: 'cancelled' });
        if (signal.aborted) done();
        else signal.addEventListener('abort', done, { once: true });
      }),
  );
  await startTrip('researcher', {}, true);
  await jest.advanceTimersByTimeAsync(901000);
  expect(currentTrip()!.segmentCount).toBe(2);
  expect(mockSessions[0].state).toBe('completed');
  expect(uploadTrip).toHaveBeenCalledTimes(1);
  expect(
    mockEvents.filter((r: any) => r[1] === 'flight_detection').length,
  ).toBeGreaterThan(25);
  expect(
    mockEvents.some(
      (r: any) => r[1] === 'segment_health' && r[2].started.download === 1,
    ),
  ).toBe(true);
  expect(currentTrip()!.transferFailures?.download).toBe(0);
  timeout.mockRestore();
});

test('M-Lab completion spaces controlled transfers away from its actual finish', async () => {
  const { runTripMlab } = require('../src/reference/tripMlab');
  const { runProbe } = require('../src/measurements/runProbe');
  jest.spyOn(Math, 'random').mockReturnValue(0.99);
  runTripMlab.mockImplementation(
    () =>
      new Promise(resolve =>
        setTimeout(
          () =>
            resolve([
              { type: 'ndt7_download', success: true },
              { type: 'ndt7_upload', success: true },
            ]),
          120000,
        ),
      ),
  );
  await startTrip('researcher', {}, true);
  await jest.advanceTimersByTimeAsync(330000);
  expect(runTripMlab).toHaveBeenCalledTimes(1);
  expect(runProbe).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(60000);
  expect(runProbe).toHaveBeenCalledTimes(2);
  jest.restoreAllMocks();
});

test('two failures disable each controlled direction without spending later pair reservations', async () => {
  const { runProbe } = require('../src/measurements/runProbe');
  const { runTripMlab } = require('../src/reference/tripMlab');
  runProbe.mockResolvedValue({ success: false, errorType: 'timeout' });
  await startTrip('researcher', { expectedMinutes: 10 }, true, {
    includeMlab: false,
  });
  await jest.advanceTimersByTimeAsync(7500000);
  expect(runTripMlab).not.toHaveBeenCalled();
  expect(runProbe).toHaveBeenCalledTimes(4);
  expect(currentTrip()!.transferFailures).toEqual({ download: 2, upload: 2 });
  expect(currentTrip()!.used.transfers).toBe(12000000);
  expect(
    mockEvents.filter((r: any) => r[1] === 'transfer_disabled'),
  ).toHaveLength(2);
});

test('resume after the safety ceiling cannot start an overdue probe', async () => {
  await startTrip('researcher', {}, true, { includeMlab: false });
  await jest.advanceTimersByTimeAsync(1000);
  const attempts = mockStore.beginAttempt.mock.calls.length;
  jest.setSystemTime(Date.now() + 86400000);
  await jest.advanceTimersByTimeAsync(1000);
  expect(mockStore.beginAttempt).toHaveBeenCalledTimes(attempts);
  expect(currentTrip()).toMatchObject({
    phase: 'finished',
    reason: 'safety_ceiling',
  });
  expect(mockEvents.some((r: any) => r[1] === 'collector_deadline')).toBe(true);
});

test('a gap discards the remaining reserved transfer direction without refunding it', async () => {
  const { runProbe } = require('../src/measurements/runProbe');
  runProbe.mockImplementation(
    (_: unknown, __: unknown, ___: unknown, signal: AbortSignal) =>
      new Promise(resolve => {
        signal.addEventListener(
          'abort',
          () => resolve({ success: false, errorType: 'cancelled' }),
          { once: true },
        );
      }),
  );
  await startTrip('researcher', {}, true, { includeMlab: false });
  await jest.advanceTimersByTimeAsync(301000);
  expect(runProbe).toHaveBeenCalledTimes(1);
  jest.setSystemTime(Date.now() + 35 * 60000);
  await jest.advanceTimersByTimeAsync(30000);
  expect(runProbe).toHaveBeenCalledTimes(1);
  expect(currentTrip()!.pendingTransferPair).toBeUndefined();
  expect(currentTrip()!.used.transfers).toBe(6000000);
  expect(
    mockEvents.some(
      (r: any) =>
        r[1] === 'collector_gap' &&
        r[2].skippedTransferDirections.includes('upload'),
    ),
  ).toBe(true);
});

test('a discontinuous callback clock invalidates the headline value while retaining reported evidence', async () => {
  const { runDiagnostic } = require('../src/measurements/diagnostics');
  runDiagnostic.mockImplementationOnce(
    () =>
      new Promise(resolve =>
        setTimeout(
          () => resolve({ success: true, value: 20, durationMs: 1 }),
          5000,
        ),
      ),
  );
  await startTrip('researcher', {}, true, { includeMlab: false });
  await jest.advanceTimersByTimeAsync(7000);
  expect(mockStore.finishAttempt.mock.calls[0][0]).toMatchObject({
    success: false,
    value: null,
    errorType: 'interrupted',
    scheduling: { timingValid: false, reportedValue: 20 },
  });
});

test.each([5384])(
  'pilot AS%i uses normal admission and uncapped M-Lab without consuming controlled reservations',
  async asn => {
    const { NativeModules } = require('react-native');
    const config = require('../src/config/public.json');
    NativeModules.FlightNetwork.pilotBuild = true;
    config.pilotTestAsnsEnabled = true;
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      headers: { get: () => '1' },
      text: async () => JSON.stringify({ asn }),
    })) as any;
    const { runTripMlab } = require('../src/reference/tripMlab');
    runTripMlab.mockResolvedValue([
      {
        type: 'ndt7_download',
        success: true,
        reference: { clientBytes: 1500000000 },
      },
      {
        type: 'ndt7_upload',
        success: true,
        reference: { clientBytes: 1200000000 },
      },
    ]);
    try {
      await startTrip('owner', {});
      await jest.advanceTimersByTimeAsync(31000);
      expect(currentTrip()).toMatchObject({
        phase: 'collecting',
        shadow: false,
        groundTest: true,
      });
      await jest.advanceTimersByTimeAsync(180000);
      expect(runTripMlab).toHaveBeenCalledTimes(1);
      expect(runTripMlab.mock.calls[0][7]).toBe(true);
      expect(currentTrip()!.used.transfers).toBe(0);
      expect(currentTrip()!.mlabUsage).toEqual({
        downloadClientBytes: 1500000000,
        uploadClientBytes: 1200000000,
      });
      expect(mockSessions[0].config).toMatchObject({
        maxPayloadBytes: null,
        referenceByteThreshold: null,
        mlabPolicy: { reservationBytes: null, byteThresholdPerDirection: null },
      });
    } finally {
      await stopTrip();
      config.pilotTestAsnsEnabled = false;
      NativeModules.FlightNetwork.pilotBuild = false;
    }
  },
);

test.each([
  [429, null, 'http_429'],
  [503, null, 'http_503'],
  [200, 'database_stale', 'database_stale'],
  [200, 'database_not_configured', 'database_not_configured'],
])(
  'ASN lookup %s/%s records unknown evidence, not a negative match',
  async (status, unavailable, reason) => {
    globalThis.fetch = jest.fn(async () => ({
      ok: status === 200,
      status,
      headers: { get: () => '1' },
      text: async () =>
        JSON.stringify({ asn: null, asnUnavailable: unavailable }),
    })) as any;
    await startTrip('owner', {});
    await jest.advanceTimersByTimeAsync(16000);
    expect(currentTrip()!.phase).toBe('watching');
    expect(currentTrip()!.evidence!.asn.state).toBe('unknown');
    expect(
      mockEvents.some(
        (r: any) =>
          r[1] === 'collector_identity' &&
          r[2].reason === (unavailable ? 'received' : reason),
      ),
    ).toBe(true);
    if (unavailable)
      expect(currentTrip()!.evidence!.asn.reason).toBe(unavailable);
  },
);

test('Start takes priority over a cancellable upload while preserving exclusive traffic', async () => {
  const { acquireActivity } = require('../src/services/activityGate');
  let cancelled = false;
  const finishUpload = acquireActivity('sync', () => {
    cancelled = true;
    Promise.resolve().then(finishUpload);
  });
  await startTrip('owner', { flightNumber: 'TEST' });
  expect(cancelled).toBe(true);
  expect(tripRunning()).toBe(true);
  expect(currentActivity()).toBe('measurement');
  expect(isTripArmed()).toBe(true);
});

test.each([
  [8000, true, 902000],
  [20000, false, 910000],
])(
  'light probe taking %s ms gets bounded boundary grace (success=%s)',
  async (duration, successful, closedAfter) => {
    const policy = require('../src/trips/scheduler');
    const reset = jest.spyOn(policy, 'resetProbes').mockImplementation(() => ({
      icmp_burst: 1895000,
      udp_echo: 9000000,
      tcp_connect: 9000000,
      traceroute: 9000000,
    }));
    const { runDiagnostic } = require('../src/measurements/diagnostics');
    runDiagnostic.mockImplementation(
      (attempt: any, _config: any, signal: AbortSignal) =>
        new Promise(resolve => {
          const started = Date.now();
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve({
              ...attempt,
              success: !signal.aborted,
              value: signal.aborted ? null : 20,
              durationMs: Date.now() - started,
              errorType: signal.aborted ? 'cancelled' : null,
            });
          };
          const timer = setTimeout(finish, duration as number);
          signal.addEventListener('abort', finish, { once: true });
        }),
    );
    try {
      await startTrip('researcher', {}, true, { includeMlab: false });
      await jest.advanceTimersByTimeAsync(911000);
      const result = mockStore.finishAttempt.mock.calls
        .map((c: any) => c[0])
        .find((m: any) => m.type === 'icmp_burst');
      expect(result.success).toBe(successful);
      if (!successful)
        expect(result).toMatchObject({
          errorType: 'interrupted',
          interruptionReason: 'segment_boundary',
          value: null,
        });
      const pause = mockEvents.find((r: any) => r[1] === 'upload_pause') as any;
      expect(Date.parse(pause[2].startedAt) - 1000000).toBe(closedAfter);
      expect(currentTrip()!.nextUploadAt - 1000000).toBe(1800000);
      expect((uploadTrip as jest.Mock).mock.calls[0][5]).toMatchObject({
        deadline: 1000000 + (closedAfter as number) + 25000,
      });
    } finally {
      reset.mockRestore();
    }
  },
);
