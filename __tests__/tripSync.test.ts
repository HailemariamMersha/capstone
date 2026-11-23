import { Buffer } from 'buffer';
import type { Trip } from '../src/trips/model';
import {
  TRIP_POLICY,
  DETECTOR_POLICY,
  PILOT_TRIP_POLICY,
} from '../src/trips/model';
import { uploadKey } from '../src/sync/transport';
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
    retireTripData: jest.fn(),
    tripPayment: jest.fn(async () => null),
    acknowledgeTripPayment: jest.fn(),
    getUploadState: jest.fn(),
    saveUploadState: jest.fn(),
    clearUploadState: jest.fn(),
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
  const states = new Map();
  (measurementStore.getUploadState as jest.Mock).mockImplementation(
    async (_owner, key) => states.get(key) ?? null,
  );
  (measurementStore.saveUploadState as jest.Mock).mockImplementation(
    async (_owner, key, value) => {
      states.set(key, value);
    },
  );
  (measurementStore.clearUploadState as jest.Mock).mockImplementation(
    async (_owner, key) => {
      states.delete(key);
    },
  );
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

test('payment metadata is uploaded once through its separate owner endpoint, never the manifest', async () => {
  const t = trip();
  (measurementStore.tripPayment as jest.Mock).mockResolvedValueOnce({
    netId: 'abc123',
    uploaded: false,
  });
  await uploadTrip(t, false, true, jest.fn());
  expect(api).toHaveBeenCalledWith(
    `/trips/${t.id}/payment`,
    expect.objectContaining({ method: 'PUT', body: '{"netId":"abc123"}' }),
    'owner',
    expect.any(Object),
  );
  expect(measurementStore.acknowledgeTripPayment).toHaveBeenCalledWith(
    'owner',
    t.id,
  );
  expect(JSON.stringify(tripManifest(t))).not.toContain('abc123');
});

test('a history reset retires the old trip without replacing its identity', async () => {
  const t = trip();
  (api as jest.Mock).mockRejectedValue(
    Object.assign(new Error('removed'), { status: 410, code: 'DATA_REMOVED' }),
  );
  await uploadTrip(t, false, true, async () => {});
  expect(t.removedFromStudy).toBe(true);
  expect(t.state).toBe('interrupted');
  expect(measurementStore.retireTripData).toHaveBeenCalledWith('owner', t.id);
  expect(currentActivity()).toBeNull();
});

test('a saved trip acknowledgement survives a failed receipt and avoids repeating the PUT', async () => {
  const t = {
    ...trip(),
    state: 'completed',
    phase: 'finished',
    endedAt: 2,
  } as Trip;
  await measurementStore.saveUploadState!('owner', uploadKey('capability'), 2);
  let receipts = 0;
  (api as jest.Mock).mockImplementation(async (path: string) => {
    if (path.endsWith('/receipt')) {
      if (++receipts === 1)
        throw Object.assign(new Error('timeout'), { code: 'REQUEST_TIMEOUT' });
      return { acceptedRevision: 1, uploadComplete: true };
    }
    return { acceptedRevision: 1, uploadComplete: false };
  });
  await expect(uploadTrip(t, false, true, jest.fn())).rejects.toThrow(
    'timeout',
  );
  await uploadTrip(t, false, true, jest.fn());
  expect(
    (api as jest.Mock).mock.calls.filter(([p]) => p.includes('?view=receipt')),
  ).toHaveLength(1);
  expect(receipts).toBe(2);
  expect(t.uploadedRevision).toBe(1);
});

test('a lost compact receipt invalidates its registration hint without deleting evidence', async () => {
  const t = {
    ...trip(),
    state: 'completed',
    phase: 'finished',
    endedAt: 2,
  } as Trip;
  await measurementStore.saveUploadState!('owner', uploadKey('capability'), 2);
  (api as jest.Mock).mockImplementation(async (path: string) => {
    if (path.endsWith('/receipt'))
      throw Object.assign(new Error('missing'), { status: 404 });
    return { acceptedRevision: 1, uploadComplete: false };
  });
  await expect(uploadTrip(t, false, true, jest.fn())).rejects.toThrow(
    'missing',
  );
  expect(measurementStore.clearUploadState).toHaveBeenCalledWith(
    'owner',
    uploadKey('trip-manifest', t.id),
  );
  await expect(uploadTrip(t, false, true, jest.fn())).rejects.toThrow(
    'missing',
  );
  expect(
    (api as jest.Mock).mock.calls.filter(([p]) => p.includes('?view=receipt')),
  ).toHaveLength(2);
  expect(measurementStore.retireTripData).not.toHaveBeenCalled();
});

test('crash-surviving live reservations are charged once without leaking local reservation IDs', async () => {
  const t = trip();
  t.policy = PILOT_TRIP_POLICY;
  t.used.uploads = 100;
  t.uploadReservations = { uncertain: 500 };
  const persist = jest.fn();
  await uploadTrip(t, false, true, persist);
  await uploadTrip(t, false, true, persist);
  expect(t.used.uploads).toBe(600);
  expect(t.uploadReservations).toEqual({});
  expect(persist).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(tripManifest(t))).not.toContain('uncertain');
});
