import {
  runSpeedChecker,
  validateSpeedCheckerResult,
} from '../src/reference/speedchecker';
import { currentActivity } from '../src/services/activityGate';
let store, native, permission;
const result = (overrides = {}) => ({
  runId: 'speed',
  reason: 'complete',
  cleanupConfirmed: true,
  durationMs: 15000,
  downloadMbps: 25,
  uploadMbps: 10,
  pingMs: 22,
  jitterMs: 3,
  downloadMb: 20,
  uploadMb: 10,
  server: 'probe.example.org',
  ...overrides,
});
beforeEach(() => {
  store = {
    createSession: jest.fn().mockResolvedValue('speed'),
    addEvent: jest.fn().mockResolvedValue(),
    beginAttempt: jest
      .fn()
      .mockImplementation(async (sessionId, type) => ({
        id: type,
        sessionId,
        type,
      })),
    finishAttempt: jest.fn().mockResolvedValue(),
    endSession: jest.fn().mockResolvedValue(),
  };
  native = { start: jest.fn().mockResolvedValue(result()), cancel: jest.fn() };
  permission = jest.fn().mockResolvedValue(true);
});
test('requires explicit consent before permissions, storage or native initialization', async () => {
  await expect(
    runSpeedChecker(
      store,
      false,
      new AbortController().signal,
      permission,
      native,
    ),
  ).rejects.toThrow('Accept');
  expect(native.start).not.toHaveBeenCalled();
  expect(permission).not.toHaveBeenCalled();
});
test('commits three attempts before starting SDK and saves receiver SDK metrics separately', async () => {
  native.start.mockImplementation(async () => {
    expect(store.beginAttempt).toHaveBeenCalledTimes(3);
    expect(currentActivity()).toBe('reference');
    return result();
  });
  await runSpeedChecker(
    store,
    true,
    new AbortController().signal,
    permission,
    native,
  );
  expect(store.finishAttempt.mock.calls.map(([r]) => r.value)).toEqual([
    22, 25, 10,
  ]);
  expect(store.finishAttempt.mock.calls[1][0]).toMatchObject({
    unit: 'Mbps',
    transferredBytes: 20000000,
    speedchecker: { sdkVersion: '4.2.299', downloadMb: 20 },
  });
  expect(currentActivity()).toBeNull();
});
test('permission denial never starts SDK and preserves failed attempts', async () => {
  permission.mockResolvedValue(false);
  await expect(
    runSpeedChecker(
      store,
      true,
      new AbortController().signal,
      permission,
      native,
    ),
  ).rejects.toThrow('permission');
  expect(native.start).not.toHaveBeenCalled();
  expect(store.finishAttempt).toHaveBeenCalledTimes(3);
  expect(currentActivity()).toBeNull();
});
test('cancellation waits for native cleanup and saves partial counters as failures', async () => {
  let resolve;
  native.start.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const abort = new AbortController();
  const pending = runSpeedChecker(
    store,
    true,
    abort.signal,
    permission,
    native,
  );
  while (!resolve) {
    await Promise.resolve();
  }
  abort.abort();
  expect(native.cancel).toHaveBeenCalledWith('speed');
  expect(currentActivity()).toBe('reference');
  resolve(result({ reason: 'cancelled' }));
  await pending;
  expect(
    store.finishAttempt.mock.calls.every(
      ([r]) => r.success === false && r.value === null,
    ),
  ).toBe(true);
  expect(currentActivity()).toBeNull();
});
test('missing SDK speeds never become successful zeros', async () => {
  native.start.mockResolvedValue(result({ downloadMbps: null, uploadMbps: 0 }));
  await runSpeedChecker(
    store,
    true,
    new AbortController().signal,
    permission,
    native,
  );
  expect(store.finishAttempt.mock.calls.map(([r]) => r.success)).toEqual([
    true,
    false,
    false,
  ]);
});
test('database setup failure releases gate before any SDK call', async () => {
  store.beginAttempt.mockRejectedValue(new Error('disk full'));
  await expect(
    runSpeedChecker(
      store,
      true,
      new AbortController().signal,
      permission,
      native,
    ),
  ).rejects.toThrow('disk full');
  expect(native.start).not.toHaveBeenCalled();
  expect(currentActivity()).toBeNull();
});
test('invalid native telemetry is rejected', () => {
  expect(() =>
    validateSpeedCheckerResult(result({ uploadMb: -1 }), 'speed'),
  ).toThrow();
  expect(() => validateSpeedCheckerResult(result(), 'different')).toThrow();
});
test('unconfirmed native cleanup quarantines the shared activity gate', async () => {
  // Isolate module state so the intentionally held gate cannot affect other tests.
  jest.resetModules();
  const isolated = require('../src/reference/speedchecker');
  const gate = require('../src/services/activityGate');
  native.start.mockResolvedValue(
    result({ reason: 'cancelled', cleanupConfirmed: false }),
  );
  await expect(
    isolated.runSpeedChecker(
      store,
      true,
      new AbortController().signal,
      permission,
      native,
    ),
  ).rejects.toThrow('Restart');
  expect(gate.currentActivity()).toBe('reference');
  expect(() => gate.acquireActivity('measurement')).toThrow('Wait');
  jest.resetModules();
});
