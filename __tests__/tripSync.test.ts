import { Buffer } from 'buffer';
import type { Trip } from '../src/trips/model';
import { TRIP_POLICY, DETECTOR_POLICY } from '../src/trips/model';
import { tripManifest, uploadTrip } from '../src/trips/sync';
import { api, localSession } from '../src/auth/client';
import { measurementStore } from '../src/storage/database';
import { currentActivity } from '../src/services/activityGate';

jest.mock('../src/auth/client', () => ({
  api: jest.fn(),
  localSession: jest.fn(),
  secureStorage: {
    getItem: jest.fn(async () => JSON.stringify({ mobileUploads: false })),
  },
}));
jest.mock('../src/storage/database', () => ({
  measurementStore: {
    initialize: jest.fn(),
    hasActiveSession: jest.fn(async () => false),
    accountSessions: jest.fn(async () => []),
    saveTrip: jest.fn(),
  },
}));
function trip(): Trip {
  return {
    id: 'a'.repeat(32),
    ownerId: 'owner',
    revision: 1,
    startedAt: 1,
    endedAt: null,
    phase: 'watching',
    state: 'active',
    reason: null,
    flight: { flightNumber: '航班' },
    policy: TRIP_POLICY,
    segmentCount: 0,
    firstQualifiedAt: null,
    candidateAt: null,
    candidateKey: null,
    qualifiedKey: null,
    disconnectedAt: null,
    lowSpeedAt: null,
    airborneSeen: false,
    evidence: null,
    used: { transfers: 0, diagnostics: 0, uploads: 0 },
    transferPairs: 0,
    nextTransferAt: null,
    nextUploadAt: 900001,
    due: {},
    shadow: false,
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  (localSession as jest.Mock).mockResolvedValue({ user: { id: 'owner' } });
  (api as jest.Mock).mockResolvedValue({ uploadComplete: false });
});
test('only new trips include an explicit detector policy in their manifest', () => {
  const t = trip();
  expect(tripManifest(t)).not.toHaveProperty('detectorPolicyVersion');
  t.detectorPolicy = DETECTOR_POLICY;
  expect(tripManifest(t)).toHaveProperty(
    'detectorPolicyVersion',
    'asn-only-v1',
  );
});
test('failed live requests and retries reserve UTF-8 payload before sending without resetting counters', async () => {
  const t = trip();
  const expected =
    Buffer.byteLength(JSON.stringify(tripManifest(t)), 'utf8') + 65536;
  const persist = jest.fn(async () => {
    t.revision++;
  });
  (api as jest.Mock).mockRejectedValue(new Error('offline'));
  await expect(uploadTrip(t, true, true, persist)).rejects.toThrow('offline');
  expect(t.used.uploads).toBe(expected);
  expect(persist.mock.invocationCallOrder[0]).toBeLessThan(
    (api as jest.Mock).mock.invocationCallOrder[0],
  );
  const retryBytes =
    Buffer.byteLength(JSON.stringify(tripManifest(t)), 'utf8') + 65536;
  await expect(uploadTrip(t, true, true, persist)).rejects.toThrow('offline');
  expect(t.used.uploads).toBe(expected + retryBytes);
  expect(t.used.transfers).toBe(0);
  expect(currentActivity()).toBeNull();
});
test('exhausted live allowance prevents requests; post-trip reconciliation uses no live allowance', async () => {
  const t = trip();
  t.used.uploads = TRIP_POLICY.liveUploadBytes;
  const persist = jest.fn();
  await expect(uploadTrip(t, true, true, persist)).rejects.toThrow(
    'allowance exhausted',
  );
  expect(api).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
  t.state = 'completed';
  t.phase = 'finished';
  t.endedAt = 2;
  (api as jest.Mock).mockResolvedValue({ uploadComplete: true });
  await uploadTrip(t, false, true, persist);
  expect(t.used.uploads).toBe(TRIP_POLICY.liveUploadBytes);
  expect(t.uploadedRevision).toBe(t.revision);
  expect(measurementStore.saveTrip).toHaveBeenCalledWith(t);
});
test('foreign identities and mobile connections without preference cannot upload a trip', async () => {
  const t = trip();
  (localSession as jest.Mock).mockResolvedValueOnce({
    user: { id: 'different-owner' },
  });
  await uploadTrip(t, true, true, jest.fn());
  await uploadTrip(t, true, false, jest.fn());
  expect(api).not.toHaveBeenCalled();
  expect(measurementStore.initialize).not.toHaveBeenCalled();
  expect(t.used.uploads).toBe(0);
});
