import {
  runTraceroute,
  validateTraceResponse,
} from '../src/measurements/traceroute';
import type {
  TraceAdapter,
  TraceResponse,
} from '../src/measurements/traceroute';
import type { Measurement, TraceSample } from '../src/measurements/types';
import { DEFAULT_SESSION_CONFIG } from '../src/sessions/config';
const attempt = {
  id: 'trace',
  type: 'traceroute',
  sessionId: 'session',
  requestedBytes: 3840,
} as Measurement;
const config = { ...DEFAULT_SESSION_CONFIG, tracerouteHost: '192.0.2.10' };
const sample = (overrides: Partial<TraceSample> = {}): TraceSample => ({
  hop: 1,
  sequence: 0,
  remote: '192.0.2.10',
  address: '192.0.2.1',
  kind: 'icmp_error',
  rttMs: null,
  probeBytes: 32,
  overheadBytes: 28,
  icmpType: 11,
  icmpCode: 0,
  ...overrides,
});
const response = (
  samples: TraceSample[],
  reason: TraceResponse['reason'] = 'complete',
): TraceResponse => ({ runId: 'trace', samples, reason, error: null });
const adapter = (value: TraceResponse): TraceAdapter => ({
  trace: jest.fn().mockResolvedValue(value),
  cancel: jest.fn(),
});
test('retains intermediate router errors and confirms only destination port-unreachable', async () => {
  const native = adapter(
    response([
      sample(),
      sample({
        hop: 2,
        sequence: 3,
        address: '192.0.2.10',
        kind: 'port_unreachable',
        rttMs: 4.2,
      }),
    ]),
  );
  const result = await runTraceroute(
    attempt,
    config,
    new AbortController().signal,
    native,
  );
  expect(result).toMatchObject({
    success: true,
    value: 2,
    unit: 'hops',
    route: { reached: true, complete: true },
  });
  expect(result.route!.samples[0].rttMs).toBeNull();
  expect(native.trace).toHaveBeenCalledWith(
    'trace',
    config.tracerouteHost,
    20,
    3,
  );
});
test('an intermediate refusal does not prove destination arrival', async () => {
  const result = await runTraceroute(
    attempt,
    config,
    new AbortController().signal,
    adapter(response([sample({ kind: 'port_unreachable', rttMs: 8 })])),
  );
  expect(result.success).toBe(false);
  expect(result.route!.reached).toBe(false);
  expect(result.route!.samples).toHaveLength(1);
});
test('deadline and cancellation retain partial routes without successful metrics', async () => {
  let resolve!: (value: TraceResponse) => void;
  const native = {
    trace: jest.fn(
      () =>
        new Promise<TraceResponse>(done => {
          resolve = done;
        }),
    ),
    cancel: jest.fn(),
  };
  const abort = new AbortController();
  const pending = runTraceroute(attempt, config, abort.signal, native);
  abort.abort();
  expect(native.cancel).toHaveBeenCalledWith('trace');
  resolve(response([sample()], 'cancelled'));
  const result = await pending;
  expect(result).toMatchObject({
    success: false,
    errorType: 'cancelled',
    route: { complete: false, samples: [sample()] },
  });
});
test('pre-cancellation starts no native traffic', async () => {
  const native = adapter(response([]));
  const abort = new AbortController();
  abort.abort();
  expect(
    (await runTraceroute(attempt, config, abort.signal, native)).errorType,
  ).toBe('cancelled');
  expect(native.trace).not.toHaveBeenCalled();
});
test('rejects duplicate sequences, invalid hops and mismatched run IDs', () => {
  expect(() =>
    validateTraceResponse(response([sample(), sample()]), 'trace', 20),
  ).toThrow();
  expect(() =>
    validateTraceResponse(response([sample({ hop: 21 })]), 'trace', 20),
  ).toThrow();
  expect(() =>
    validateTraceResponse(response([sample()]), 'other', 20),
  ).toThrow();
});
