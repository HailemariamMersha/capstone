import { runLoadedLatency } from '../src/measurements/loadedLatency';
import { DEFAULT_PROBE_CONFIG } from '../src/measurements/config';

const attempt = {
  id: 'loaded',
  sessionId: 's',
  type: 'loaded_download',
  value: null,
  success: false,
};
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
function probeWithTransferDuration(duration) {
  return jest.fn(
    (type, _config, _session, signal) =>
      new Promise(resolve => {
        let timer;
        const timestamp = new Date().toISOString();
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve({
            type,
            timestamp,
            success: !signal.aborted,
            value: signal.aborted ? null : type === 'http_rtt' ? 20 : 5,
            errorType: signal.aborted ? 'cancelled' : null,
          });
        };
        timer = setTimeout(finish, type === 'http_rtt' ? 20 : duration);
        signal.addEventListener('abort', finish);
        if (signal.aborted) {
          finish();
        }
      }),
  );
}
test('only latency exchanges fully inside a successful load are aggregated', async () => {
  const probe = probeWithTransferDuration(600);
  const pending = runLoadedLatency(
    attempt,
    DEFAULT_PROBE_CONFIG,
    new AbortController().signal,
    probe,
  );
  await jest.runAllTimersAsync();
  expect(await pending).toMatchObject({
    success: true,
    value: 20,
    details: {
      baselineSummary: { replies: 3 },
      loadedOverlapCount: 3,
      load: { success: true },
    },
  });
});
test('a transfer that ends before the first reply reports insufficient overlap', async () => {
  const pending = runLoadedLatency(
    attempt,
    DEFAULT_PROBE_CONFIG,
    new AbortController().signal,
    probeWithTransferDuration(5),
  );
  await jest.runAllTimersAsync();
  expect(await pending).toMatchObject({
    success: false,
    value: null,
    errorType: 'invalid_response',
    details: { loadedOverlapCount: 0 },
  });
});
test('cancellation aborts both concurrent tasks and preserves the load failure', async () => {
  const abort = new AbortController();
  const pending = runLoadedLatency(
    attempt,
    DEFAULT_PROBE_CONFIG,
    abort.signal,
    probeWithTransferDuration(10000),
  );
  await jest.advanceTimersByTimeAsync(100);
  abort.abort();
  expect(await pending).toMatchObject({
    success: false,
    errorType: 'cancelled',
    details: { complete: false, load: { errorType: 'cancelled' } },
  });
  expect(jest.getTimerCount()).toBe(0);
});
