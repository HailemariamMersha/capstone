jest.mock('../src/auth/client', () => ({
  secureStorage: { getItem: jest.fn() },
}));
import { NativeModules } from 'react-native';
import { secureStorage } from '../src/auth/client';
import {
  requireMlabConsent,
  runTripMlab,
  MLAB_CONSENT,
} from '../src/reference/tripMlab';
const native = { run: jest.fn(), cancel: jest.fn() };
const snapshot = { id: 'wifi-snapshot' } as any;
const result = (direction: string, extra = {}) => ({
  direction,
  host: 'test.measurement-lab.org',
  reason: 'complete',
  opened: true,
  cleanClose: true,
  clientBytes: 2000000,
  clientSeconds: 2,
  serverBytes: 1000000,
  serverSeconds: 2,
  ...extra,
});
const reply = (results = [result('download'), result('upload')]) =>
  JSON.stringify({
    version: 1,
    runId: 'ndt7_download',
    type: 'finished',
    reason: 'complete',
    results,
  });
const store = {
  addEvent: jest.fn(),
  beginAttempt: jest.fn(async (sessionId, type) => ({
    id: type,
    type,
    sessionId,
  })),
  finishAttempt: jest.fn(),
} as any;
beforeEach(() => {
  jest.clearAllMocks();
  NativeModules.CapstoneNdt7 = native;
  native.run.mockResolvedValue(reply());
});
test('previous consent and missing consent cannot arm automatic publication', async () => {
  (secureStorage.getItem as jest.Mock).mockResolvedValue(
    JSON.stringify({ consentVersion: 'skymeasure-flight-2026-11-01' }),
  );
  await expect(requireMlabConsent('a')).rejects.toThrow('updated');
  (secureStorage.getItem as jest.Mock).mockResolvedValue(null);
  await expect(requireMlabConsent('a')).rejects.toThrow('updated');
  (secureStorage.getItem as jest.Mock).mockResolvedValue(
    JSON.stringify({ consentVersion: MLAB_CONSENT }),
  );
  await requireMlabConsent('a');
  expect(secureStorage.getItem).toHaveBeenLastCalledWith('profile.a');
  await expect(
    runTripMlab(
      store,
      'segment',
      'old',
      'wifi',
      snapshot,
      new AbortController().signal,
    ),
  ).rejects.toThrow('consent');
  expect(native.run).not.toHaveBeenCalled();
});
test('single trip run stores both directions in its segment using receiver-side Mbps', async () => {
  const rows = await runTripMlab(
    store,
    'segment',
    MLAB_CONSENT,
    'wifi',
    snapshot,
    new AbortController().signal,
  );
  expect(native.run).toHaveBeenCalledWith(
    'ndt7_download',
    MLAB_CONSENT,
    'wifi',
  );
  expect(rows[0]).toMatchObject({
    sessionId: 'segment',
    value: 8,
    success: true,
    networkSnapshot: snapshot,
    method: 'ndt7_android_library',
  });
  expect(rows[1]).toMatchObject({
    sessionId: 'segment',
    value: 4,
    success: true,
    reference: { source: 'server', library: 'ndt7-client-android' },
  });
  expect(store.beginAttempt.mock.invocationCallOrder[1]).toBeLessThan(
    native.run.mock.invocationCallOrder[0],
  );
  expect(store.finishAttempt).toHaveBeenCalledTimes(2);
});
test('byte-capped downloads and missing receiver telemetry never become zero or successful speeds', async () => {
  native.run.mockResolvedValue(
    reply([
      result('download', { reason: 'data_threshold', cleanClose: false }),
      result('upload', { serverBytes: null }),
    ]),
  );
  const rows = await runTripMlab(
    store,
    'segment',
    MLAB_CONSENT,
    'wifi',
    snapshot,
    new AbortController().signal,
  );
  expect(rows.every(r => !r.success && r.value === null)).toBe(true);
  expect(rows[0].reference?.stopReason).toBe('data_threshold');
  expect(rows[1].reference?.stopReason).toBe('invalid_response');
});
test('Stop cancels the active library before final records are committed', async () => {
  const abort = new AbortController();
  native.run.mockImplementation(async () => {
    abort.abort();
    expect(native.cancel).toHaveBeenCalledWith('ndt7_download');
    return reply([
      result('download', { reason: 'cancelled', cleanClose: false }),
    ]);
  });
  const rows = await runTripMlab(
    store,
    'segment',
    MLAB_CONSENT,
    'wifi',
    snapshot,
    abort.signal,
  );
  expect(rows.every(r => !r.success)).toBe(true);
});
test('pre-cancelled runs never contact discovery, quota failures retain evidence without signed URLs', async () => {
  const abort = new AbortController();
  abort.abort();
  await runTripMlab(
    store,
    'segment',
    MLAB_CONSENT,
    'wifi',
    snapshot,
    abort.signal,
  );
  expect(native.run).not.toHaveBeenCalled();
  native.run.mockRejectedValue({
    code: 'QUOTA',
    message: 'do not export this signed URL',
  });
  const rows = await runTripMlab(
    store,
    'segment',
    MLAB_CONSENT,
    'wifi',
    snapshot,
    new AbortController().signal,
  );
  expect(rows.every(r => r.value === null)).toBe(true);
  expect(store.addEvent).toHaveBeenCalledWith(
    'segment',
    'reference_unavailable',
    { reason: 'QUOTA' },
  );
  expect(JSON.stringify(rows)).not.toContain('signed URL');
});
