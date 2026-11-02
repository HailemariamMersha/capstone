jest.mock('../src/reference/tripMlab', () => ({
  requireMlabConsent: jest.fn(async () => {}),
  runTripMlab: jest.fn(async () => [
    { type: 'ndt7_download', success: true },
    { type: 'ndt7_upload', success: true },
  ]),
  MLAB_CONSENT: 'skymeasure-flight-mlab-2026-11-02',
  MLAB_RESERVATION: 200 * 1048576,
}));
const mockEvents: unknown[] = [];
const mockTrips: any[] = [];
const mockSessions: any[] = [];
const mockStore = {
  initialize: jest.fn(),
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
  startTrip,
  stopTrip,
  currentTrip,
  tripRunning,
} from '../src/trips/runtime';
import { uploadTrip } from '../src/trips/sync';
import { currentActivity, isTripArmed } from '../src/services/activityGate';
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1000000);
  mockEvents.length = 0;
  mockTrips.length = 0;
  mockSessions.length = 0;
  jest.clearAllMocks();
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
