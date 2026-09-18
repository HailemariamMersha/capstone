import { runSuite } from '../src/measurements/runSuite';
import { runProbe } from '../src/measurements/runProbe';
import { DEFAULT_PROBE_CONFIG as config } from '../src/measurements/config';
import type { Measurement } from '../src/measurements/types';
jest.mock('../src/measurements/runProbe', () => ({ runProbe: jest.fn() }));
const probe = jest.mocked(runProbe);
beforeEach(() => {
  jest.clearAllMocks();
  probe.mockImplementation(
    async type => ({ type, success: true } as Measurement),
  );
});
test('repeated rounds run probes sequentially and deliver each result', async () => {
  const result = jest.fn();
  await runSuite(config, 's', 2, new AbortController().signal, result);
  expect(probe.mock.calls.map(call => call[0])).toEqual([
    'http_rtt',
    'download',
    'upload',
    'http_rtt',
    'download',
    'upload',
  ]);
  expect(result).toHaveBeenCalledTimes(6);
});
test('failed results do not prevent the remaining probes', async () => {
  probe.mockResolvedValueOnce({
    success: false,
    errorType: 'network',
  } as Measurement);
  const result = jest.fn();
  await runSuite(config, 's', 1, new AbortController().signal, result);
  expect(result.mock.calls[0][0].errorType).toBe('network');
  expect(result).toHaveBeenCalledTimes(3);
});
test('cancellation records the current result and does not launch further requests', async () => {
  const abort = new AbortController();
  const result = jest.fn(() => abort.abort());
  await runSuite(config, 's', 10, abort.signal, result);
  expect(probe).toHaveBeenCalledTimes(1);
});
