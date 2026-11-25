import { Buffer } from 'buffer';
import { gunzipSync } from 'fflate';
import { fingerprint, jsonBody } from '../src/sync/transport';
import { createUploadRequest } from '../src/sync/request';
import { PILOT_TRIP_POLICY, PAPER_TRIP_POLICY } from '../src/trips/model';
import { api } from '../src/auth/client';
jest.mock('../src/auth/client', () => ({ api: jest.fn() }));
const meta = {
  status: 200,
  responseBytes: 43,
  syncVersion: 2,
  requestId: 'request',
  serverTiming: 'auth;dur=1',
  retryAfterMs: null,
};
function fixture(
  policy:
    | typeof PILOT_TRIP_POLICY
    | typeof PAPER_TRIP_POLICY = PILOT_TRIP_POLICY,
) {
  const trip: any = {
    policy,
    used: { transfers: 0, diagnostics: 0, uploads: 0 },
  };
  const journal: unknown[] = [];
  const store: any = {
    getUploadState: async () => 2,
    saveUploadState: jest.fn(),
    appendUploadDiagnostic: async (_owner: string, entry: unknown) => {
      journal.push(entry);
    },
  };
  const persist = jest.fn(async () => {});
  return {
    trip,
    store,
    persist,
    journal,
    request: createUploadRequest(store, { trip, live: true, persist }),
  };
}
beforeEach(() => jest.clearAllMocks());
test('gzip is lossless for zeros, null, Unicode and large decimal timestamp strings', () => {
  const value = {
    zero: 0,
    missing: null,
    timeNs: '9999999999999999999',
    text: '航班'.repeat(1000),
  };
  const result = jsonBody(value, true);
  expect(result.encoding).toBe('gzip');
  expect(
    JSON.parse(
      Buffer.from(
        gunzipSync(new Uint8Array(result.body as ArrayBuffer)),
      ).toString('utf8'),
    ),
  ).toEqual(value);
  expect(result.bytes).toBeLessThan(result.decodedBytes);
  expect(fingerprint({ b: 2, a: [1, 2] })).toBe(
    fingerprint({ a: [1, 2], b: 2 }),
  );
  expect(fingerprint({ a: [1, 2] })).not.toBe(fingerprint({ a: [2, 1] }));
});
test.each([PILOT_TRIP_POLICY, PAPER_TRIP_POLICY])(
  'known responses settle actual body bytes under $version while counters remain monotonic',
  async policy => {
    const f = fixture(policy);
    const body = { text: 'abc'.repeat(1000) };
    const expected = jsonBody(body, true).bytes + 43;
    (api as jest.Mock).mockImplementation(
      async (_path, _options, _owner, observe) => {
        expect(_options.headers).toMatchObject({
          'Content-Encoding': 'gzip',
          'X-SkyMeasure-Content-Encoding': 'gzip',
        });
        expect(Object.values(f.trip.uploadReservations)[0]).toBeGreaterThan(
          65536,
        );
        expect(f.trip.used.uploads).toBe(0);
        observe.dispatched();
        observe.response(meta);
        return { acknowledged: [] };
      },
    );
    await f.request('/sessions/s/records', body, 'owner');
    expect(f.trip.used.uploads).toBe(expected);
    expect(f.trip.uploadReservations).toEqual({});
    expect(f.journal).toEqual([
      expect.objectContaining({
        encoding: 'gzip',
        responseBytes: 43,
        requestId: 'request',
      }),
    ]);
  },
);
test('uncertain dispatched failure is fully charged; proven pre-dispatch failure is not', async () => {
  const f = fixture();
  const body = { records: [] };
  const held = jsonBody(body, true).bytes + 65536;
  (api as jest.Mock).mockImplementation(async (_p, _o, _u, observe) => {
    observe.dispatched();
    throw new Error('timeout');
  });
  await expect(f.request('/sessions/s/records', body, 'owner')).rejects.toThrow(
    'timeout',
  );
  expect(f.trip.used.uploads).toBe(held);
  (api as jest.Mock).mockRejectedValue(new Error('credentials unavailable'));
  await expect(f.request('/sessions/s/records', body, 'owner')).rejects.toThrow(
    'credentials',
  );
  expect(f.trip.used.uploads).toBe(held);
  expect(f.trip.uploadReservations).toEqual({});
});
test('allowance exhaustion defers before sending and response rate limits are durable', async () => {
  const f = fixture();
  f.trip.used.uploads = PILOT_TRIP_POLICY.liveUploadBytes;
  await expect(
    f.request('/sessions/s/records', {}, 'owner'),
  ).rejects.toMatchObject({ code: 'UPLOAD_ALLOWANCE' });
  expect(api).not.toHaveBeenCalled();
  f.trip.used.uploads = 0;
  (api as jest.Mock).mockImplementation(async (_p, _o, _u, observe) => {
    observe.dispatched();
    observe.response({ ...meta, status: 429, retryAfterMs: 60000 });
    throw Object.assign(new Error('limited'), { status: 429 });
  });
  await expect(f.request('/sessions/s/records', {}, 'owner')).rejects.toThrow(
    'limited',
  );
  expect(f.store.saveUploadState).toHaveBeenCalledWith(
    'owner',
    expect.stringContaining('retry-at'),
    expect.any(Number),
  );
  expect(f.trip.used.uploads).toBe(jsonBody({}, true).bytes + 43);
});
