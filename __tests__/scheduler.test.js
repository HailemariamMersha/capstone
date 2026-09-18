import { startMeasurementLoop } from '../src/measurements/scheduler';
import { DEFAULT_SESSION_CONFIG } from '../src/sessions/config';
const config = {
  ...DEFAULT_SESSION_CONFIG,
  rttIntervalMs: 10000,
  downloadIntervalMs: 20000,
  uploadIntervalMs: 30000,
};
let store, probe, saved;
beforeEach(() => {
  jest.useFakeTimers();
  let id = 0;
  store = {
    beginAttempt: jest.fn(async (_session, type) => ({
      id: `durable-${++id}`,
      type,
    })),
    finishAttempt: jest.fn(async () => {}),
    addEvent: jest.fn(async () => {}),
  };
  probe = jest.fn(async type => ({ id: 'temporary', type, success: true }));
  saved = jest.fn();
});
afterEach(() => jest.useRealTimers());
const start = () =>
  startMeasurementLoop('session', config, store, saved, {
    now: () => global.performance.now(),
    wallNow: () => Date.now(),
    probe,
  });
const flush = async () => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};
test('runs independent intervals and persists durable IDs before further probes', async () => {
  const loop = start();
  await flush();
  expect(probe.mock.calls.map(call => call[0])).toEqual([
    'http_rtt',
    'download',
    'upload',
  ]);
  expect(store.beginAttempt.mock.invocationCallOrder[0]).toBeLessThan(
    probe.mock.invocationCallOrder[0],
  );
  expect(store.finishAttempt.mock.calls[0][0].id).toBe('durable-1');
  await jest.advanceTimersByTimeAsync(10000);
  expect(probe.mock.calls.map(call => call[0])).toEqual([
    'http_rtt',
    'download',
    'upload',
    'http_rtt',
  ]);
  await loop.stop();
  await jest.advanceTimersByTimeAsync(60000);
  expect(probe).toHaveBeenCalledTimes(4);
});
test('stop aborts in-flight work, saves cancellation and never overlaps probes', async () => {
  probe.mockImplementationOnce(
    (_type, _config, _session, signal) =>
      new Promise(resolve =>
        signal.addEventListener('abort', () =>
          resolve({ type: 'http_rtt', success: false, errorType: 'cancelled' }),
        ),
      ),
  );
  const loop = start();
  await flush();
  expect(probe).toHaveBeenCalledTimes(1);
  await loop.stop();
  expect(store.finishAttempt).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'durable-1', errorType: 'cancelled' }),
  );
  expect(probe).toHaveBeenCalledTimes(1);
});
test('missed intervals are logged without a catch-up burst', async () => {
  let clock = 0;
  const loop = startMeasurementLoop('s', config, store, saved, {
    now: () => clock,
    wallNow: () => 0,
    probe,
  });
  await flush();
  clock = 65000;
  await jest.advanceTimersByTimeAsync(10000);
  expect(probe).toHaveBeenCalledTimes(6);
  expect(store.addEvent).toHaveBeenCalledWith(
    's',
    'schedule_gap',
    expect.objectContaining({ type: 'http_rtt', skipped: 5 }),
  );
  await loop.stop();
});
test('a failed durable write halts the loop before any network traffic', async () => {
  store.beginAttempt.mockRejectedValueOnce(new Error('disk full'));
  const loop = start();
  await expect(loop.done).rejects.toThrow('disk full');
  expect(probe).not.toHaveBeenCalled();
});
