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
test('optional diagnostics run serially and loaded tests reserve extra payload', async () => {
  const diagnostic = jest.fn(async attempt => ({ ...attempt, success: true }));
  const loop = startMeasurementLoop(
    's',
    {
      ...config,
      icmpHost: 'example.org',
      icmpBurstEnabled: true,
      tcpEnabled: true,
      udpHost: '192.168.1.1',
      udpPort: 9876,
      loadedLatencyEnabled: true,
    },
    store,
    saved,
    {
      now: () => global.performance.now(),
      wallNow: () => Date.now(),
      probe,
      icmp: jest.fn(),
      diagnostic,
    },
  );
  await flush();
  expect(diagnostic.mock.calls.map(([attempt]) => attempt.type)).toEqual([
    'icmp_burst',
    'tcp_connect',
    'udp_echo',
    'loaded_download',
    'loaded_upload',
  ]);
  expect(store.beginAttempt).toHaveBeenCalledTimes(8);
  expect(saved).toHaveBeenCalledTimes(8);
  await loop.stop();
});

test('the first optional transfer is refused if only the baseline payload fits', async () => {
  const diagnostic = jest.fn();
  const loop = startMeasurementLoop(
    's',
    {
      ...config,
      loadedLatencyEnabled: true,
      maxPayloadBytes: 4 + config.downloadBytes + config.uploadBytes,
    },
    store,
    saved,
    {
      now: () => global.performance.now(),
      wallNow: () => Date.now(),
      probe,
      diagnostic,
    },
  );
  await loop.done;
  expect(diagnostic).not.toHaveBeenCalled();
  expect(store.addEvent).toHaveBeenCalledWith(
    's',
    'session_limit',
    expect.objectContaining({ reason: 'payload_budget' }),
  );
});
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

test('payload limit stops before another request, including after a failed probe', async () => {
  probe.mockResolvedValue({ success: false, errorType: 'network' });
  const loop = startMeasurementLoop(
    's',
    { ...config, maxPayloadBytes: 4 },
    store,
    saved,
    { now: () => global.performance.now(), wallNow: () => Date.now(), probe },
  );
  await loop.done;
  expect(probe).toHaveBeenCalledTimes(1);
  expect(store.addEvent).toHaveBeenCalledWith(
    's',
    'session_limit',
    expect.objectContaining({ reason: 'payload_budget' }),
  );
});
test('duration limit aborts and saves the in-flight attempt', async () => {
  probe.mockImplementationOnce(
    (_type, _config, _session, signal) =>
      new Promise(resolve =>
        signal.addEventListener('abort', () =>
          resolve({ success: false, errorType: 'cancelled' }),
        ),
      ),
  );
  const loop = startMeasurementLoop(
    's',
    { ...config, maxDurationMs: 10000 },
    store,
    saved,
    { now: () => global.performance.now(), wallNow: () => Date.now(), probe },
  );
  await flush();
  await jest.advanceTimersByTimeAsync(10000);
  await loop.done;
  expect(store.finishAttempt).toHaveBeenCalledWith(
    expect.objectContaining({ errorType: 'cancelled' }),
  );
});
test('low battery saves context and ends collection before network probes', async () => {
  store.saveSnapshot = jest.fn(async (_id, s) => s);
  const loop = startMeasurementLoop('s', config, store, saved, {
    now: () => 0,
    wallNow: () => 0,
    probe,
    sample: async () => ({
      changed: true,
      snapshot: {
        id: 'snap',
        batteryPercent: 10,
        isCharging: false,
        type: 'wifi',
      },
    }),
  });
  await loop.done;
  expect(probe).not.toHaveBeenCalled();
  expect(store.addEvent).toHaveBeenCalledWith(
    's',
    'session_limit',
    expect.objectContaining({ reason: 'battery' }),
  );
});

test('a network change wakes idle sampling without inserting extra probes', async () => {
  let changed;
  const sample = jest.fn(async () => ({
    changed: true,
    snapshot: { id: 's', batteryPercent: 80, isCharging: false, type: 'wifi' },
  }));
  store.saveSnapshot = jest.fn(async (_id, s) => s);
  const unsubscribe = jest.fn();
  const loop = startMeasurementLoop('s', config, store, saved, {
    now: () => global.performance.now(),
    wallNow: () => Date.now(),
    probe,
    sample,
    onContextChange: fn => {
      changed = fn;
      return unsubscribe;
    },
  });
  await flush();
  expect(sample).toHaveBeenCalledTimes(1);
  changed();
  await flush();
  expect(sample).toHaveBeenCalledTimes(2);
  expect(probe).toHaveBeenCalledTimes(3);
  await loop.stop();
  expect(unsubscribe).toHaveBeenCalled();
});

test('packet-only session schedules no HTTP transactions', async () => {
  const diagnostic = jest.fn(async attempt => ({ ...attempt, success: true }));
  const loop = startMeasurementLoop(
    'packet-session',
    {
      ...config,
      httpEnabled: false,
      icmpHost: '192.0.2.1',
      icmpBurstEnabled: true,
      tracerouteHost: '192.0.2.1',
    },
    store,
    saved,
    {
      now: () => global.performance.now(),
      wallNow: () => Date.now(),
      probe,
      icmp: jest.fn(),
      diagnostic,
    },
  );
  await flush();
  expect(probe).not.toHaveBeenCalled();
  expect(diagnostic.mock.calls.map(([attempt]) => attempt.type)).toEqual([
    'icmp_burst',
    'traceroute',
  ]);
  await loop.stop();
});
