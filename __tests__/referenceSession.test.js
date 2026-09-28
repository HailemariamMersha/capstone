import { createReferenceSession } from '../src/reference/session';
import { parseReferenceMessage } from '../src/reference/protocol';
import { acquireActivity, currentActivity } from '../src/services/activityGate';
import {
  validateSessionConfig,
  DEFAULT_SESSION_CONFIG,
} from '../src/sessions/config';
const complete = direction => ({
  direction,
  host: 'ndt-test.measurement-lab.org',
  reason: 'complete',
  opened: true,
  cleanClose: true,
  clientBytes: 2000,
  serverBytes: 1000,
  clientSeconds: 2,
  serverSeconds: 1,
});
let store;
beforeEach(() => {
  store = {
    createSession: jest.fn().mockResolvedValue('reference'),
    addEvent: jest.fn().mockResolvedValue(),
    beginAttempt: jest
      .fn()
      .mockImplementation(async (id, type) => ({
        id: type,
        sessionId: id,
        type,
      })),
    finishAttempt: jest.fn().mockResolvedValue(),
    endSession: jest.fn().mockResolvedValue(),
  };
});
test('consent and activity gate precede any persistence or network work', async () => {
  await expect(createReferenceSession(store, false)).rejects.toThrow('Accept');
  const release = acquireActivity('measurement');
  await expect(createReferenceSession(store, true)).rejects.toThrow('Wait');
  release();
  expect(store.createSession).not.toHaveBeenCalled();
});
test('durably begins both attempts and computes upload using server-received bytes', async () => {
  const run = await createReferenceSession(store, true);
  expect(store.beginAttempt).toHaveBeenCalledTimes(2);
  expect(currentActivity()).toBe('reference');
  const results = [
    complete('download'),
    { ...complete('upload'), serverBytes: 500 },
  ];
  const first = run.finish(results, 'complete');
  expect(run.finish(results, 'complete')).toBe(first);
  await first;
  expect(store.finishAttempt.mock.calls[0][0]).toMatchObject({
    success: true,
    value: 0.008,
    reference: { source: 'client' },
  });
  expect(store.finishAttempt.mock.calls[1][0]).toMatchObject({
    success: true,
    value: 0.004,
    reference: { source: 'server' },
  });
  expect(currentActivity()).toBeNull();
});
test('partial and missing directions stay failures after a threshold stop', async () => {
  const run = await createReferenceSession(store, true);
  await run.finish(
    [{ ...complete('download'), reason: 'data_threshold' }],
    'data_threshold',
  );
  expect(
    store.finishAttempt.mock.calls.every(
      ([result]) => !result.success && result.value === null,
    ),
  ).toBe(true);
  expect(store.finishAttempt.mock.calls[0][0].transferredBytes).toBe(2000);
});
test('persistence failure interrupts the session and releases activity', async () => {
  const run = await createReferenceSession(store, true);
  store.finishAttempt.mockRejectedValue(new Error('disk full'));
  await expect(run.finish([], 'cancelled')).rejects.toThrow('disk full');
  expect(store.endSession).toHaveBeenCalledWith(
    'reference',
    'interrupted',
    expect.any(String),
  );
  expect(currentActivity()).toBeNull();
});
test('setup failure ends the partially created session before releasing activity', async () => {
  store.beginAttempt.mockRejectedValue(new Error('disk full'));
  await expect(createReferenceSession(store, true)).rejects.toThrow(
    'disk full',
  );
  expect(store.endSession).toHaveBeenCalled();
  expect(currentActivity()).toBeNull();
});
test('reference sessions cannot be resumed through the scheduled measurement engine', () => {
  expect(() =>
    validateSessionConfig({
      ...DEFAULT_SESSION_CONFIG,
      mode: 'ndt7_reference',
    }),
  ).toThrow('reference test panel');
});
test('bridge rejects wrong run IDs, duplicate directions, and invalid counters', () => {
  const value = {
    version: 1,
    runId: 'run',
    type: 'finished',
    reason: 'complete',
    results: [complete('download')],
  };
  expect(
    parseReferenceMessage(JSON.stringify(value), 'run').results,
  ).toHaveLength(1);
  expect(() =>
    parseReferenceMessage(JSON.stringify(value), 'different'),
  ).toThrow();
  expect(() =>
    parseReferenceMessage(
      JSON.stringify({
        ...value,
        results: [complete('download'), complete('download')],
      }),
      'run',
    ),
  ).toThrow();
  expect(() =>
    parseReferenceMessage(
      JSON.stringify({
        ...value,
        results: [{ ...complete('upload'), serverBytes: -1 }],
      }),
      'run',
    ),
  ).toThrow();
});
