jest.mock('react-native', () => ({ NativeModules: {} }));
jest.mock('../src/measurements/traceroute', () => ({
  runTraceroute: jest.fn(async (a, c) => ({
    ...a,
    success: true,
    value: 3,
    unit: 'hops',
    durationMs: 4,
    raw: { request: { host: c.tracerouteHost } },
  })),
}));
import {
  runPaperProbe,
  paperCharge,
  type PaperAdapter,
} from '../src/measurements/paperProbes';
import { paperJobs, PAPER_CDN_LIMIT } from '../src/measurements/paperSuite';
import type { Measurement } from '../src/measurements/types';
const attempt = {
  id: 'a',
  sessionId: 's',
  timestamp: '2026-11-25T00:00:00Z',
  durationMs: 0,
  value: null,
  unit: 'ms',
  success: false,
  errorType: null,
  errorMessage: null,
  httpStatus: null,
  requestedBytes: null,
  transferredBytes: null,
  probeServer: 'test',
  probeRegion: null,
  networkSnapshot: null,
} as Measurement;
const cfg = {} as any;
beforeEach(() =>
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: (a: Uint8Array) => a.fill(1) },
  }),
);
function adapter(value: Record<string, unknown>): PaperAdapter {
  return {
    run: jest.fn(async () =>
      JSON.stringify({ runId: 'a', reason: 'complete', ...value }),
    ),
    resolve: jest.fn(async () =>
      JSON.stringify({
        runId: 'a',
        reason: 'complete',
        address: '192.0.2.1',
        resolutionMs: 2,
      }),
    ),
    cancel: jest.fn(),
  };
}
test('hostname trace resolves once and passes the observed IP to the library', async () => {
  const a = adapter({}),
    job = paperJobs(0, 0).find(j => j.targetId === 'google_domain')!;
  const r = await runPaperProbe(
    attempt,
    cfg,
    job,
    'handle',
    new AbortController().signal,
    a,
  );
  expect(a.resolve).toHaveBeenCalledWith('a', 'google.com', 'handle');
  expect(r).toMatchObject({
    targetHost: 'google.com',
    resolvedAddress: '192.0.2.1',
    resolutionMs: 2,
    targetId: 'google_domain',
  });
  expect(r.raw?.request.host).toBe('192.0.2.1');
});
test('literal trace never performs DNS or silently substitutes a hostname', async () => {
  const a = adapter({}),
    job = paperJobs(0, 0).find(j => j.targetId === 'fixed_ip_control')!;
  const r = await runPaperProbe(
    attempt,
    cfg,
    job,
    'handle',
    new AbortController().signal,
    a,
  );
  expect(a.resolve).not.toHaveBeenCalled();
  expect(r.resolvedAddress).toBe('142.250.190.238');
  expect(r.resolutionMs).toBeNull();
});
test('zero counters remain zero and resolver discovery is not represented as DNS RTT', async () => {
  const job = paperJobs(0, 0)[0],
    a = adapter({
      totalMs: 12,
      bodyBytesKnown: true,
      bodyBytes: 0,
      resolverStatus: 'unconfigured',
      observedResolverIp: '192.0.2.53',
    });
  const r = await runPaperProbe(
    attempt,
    cfg,
    job,
    'handle',
    new AbortController().signal,
    a,
  );
  expect(r.value).toBeNull();
  expect(r.transferredBytes).toBe(0);
  expect(r.paper?.resolverStatus).toBe('unconfigured');
  expect(r.paper?.tcpConnectMs).toBeNull();
  expect(paperCharge(r, PAPER_CDN_LIMIT)).toBe(0);
});
test('failed CDN retains partial bytes and nanosecond strings without a successful value', async () => {
  const job = paperJobs(0, 0).find(j => j.type === 'cdn_fetch')!,
    a = adapter({
      reason: 'timeout',
      bodyBytesKnown: true,
      bodyBytes: 45,
      totalMs: 90000,
      callbacks: [
        { event: 'test', elapsedNs: '9007199254740993', elapsedMs: 1 },
      ],
    });
  const r = await runPaperProbe(
    attempt,
    cfg,
    job,
    'handle',
    new AbortController().signal,
    a,
  );
  expect(r).toMatchObject({
    value: null,
    errorType: 'timeout',
    transferredBytes: 45,
  });
  expect(paperCharge(r, PAPER_CDN_LIMIT)).toBe(45);
  expect((r.raw?.callbacks[0].value as any).elapsedNs).toBe('9007199254740993');
});
test('unknown dispatched result holds its ceiling, proven unsent request costs zero', async () => {
  const job = paperJobs(0, 0).find(j => j.type === 'cdn_fetch')!;
  expect(
    paperCharge(
      await runPaperProbe(
        attempt,
        cfg,
        job,
        'h',
        new AbortController().signal,
        adapter({ reason: 'network', requestSent: true }),
      ),
      PAPER_CDN_LIMIT,
    ),
  ).toBe(PAPER_CDN_LIMIT);
  const c = new AbortController();
  c.abort();
  const a = adapter({});
  expect(
    paperCharge(
      await runPaperProbe(attempt, cfg, job, 'h', c.signal, a),
      PAPER_CDN_LIMIT,
    ),
  ).toBe(0);
  expect(a.run).not.toHaveBeenCalled();
});
