import { runFileDownload } from '../src/measurements/fileDownload';
import { DEFAULT_PROBE_CONFIG, MIB } from '../src/measurements/config';
const config = { ...DEFAULT_PROBE_CONFIG, downloadBytes: 50 * MIB };
const attempt = {
  id: 'download-test',
  type: 'download',
  sessionId: 'session',
  unit: 'Mbps',
  success: false,
  httpStatus: null,
  requestedBytes: config.downloadBytes,
  transferredBytes: null,
};
const headers = {
  'X-Capstone-Probe': '1',
  'X-Probe-Region': 'test',
  'Content-Length': String(config.downloadBytes),
};
const response = {
  statusCode: 200,
  bytesWritten: config.downloadBytes,
  headers,
};
const clock = () => ({
  now: jest.fn().mockReturnValueOnce(0).mockReturnValue(1000),
  timestamp: () => '2026-09-28T00:00:00Z',
});
function filesystem(promise = Promise.resolve(response)) {
  return {
    CachesDirectoryPath: '/cache',
    downloadFile: jest.fn(() => ({ jobId: 7, promise })),
    stopDownload: jest.fn(),
    unlink: jest.fn().mockResolvedValue(undefined),
  };
}
afterEach(() => jest.useRealTimers());

test('large download streams to a cache file and verifies exact native byte count', async () => {
  const fs = filesystem();
  const result = await runFileDownload(attempt, config, undefined, clock(), fs);
  expect(result).toMatchObject({
    success: true,
    method: 'http_download_to_file',
    transferredBytes: 50 * MIB,
    value: 419.4304,
    probeRegion: 'test',
  });
  expect(fs.downloadFile).toHaveBeenCalledWith(
    expect.objectContaining({
      toFile: '/cache/capstone-probe-download.bin',
      cacheable: false,
      headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' },
    }),
  );
  expect(fs.unlink).toHaveBeenCalledWith('/cache/capstone-probe-download.bin');
});

test.each([
  { ...response, bytesWritten: 1 },
  { ...response, headers: {} },
  { ...response, headers: { ...headers, 'Content-Encoding': 'gzip' } },
])('invalid responses never produce successful throughput', async reply => {
  const result = await runFileDownload(
    attempt,
    config,
    undefined,
    clock(),
    filesystem(Promise.resolve(reply)),
  );
  expect(result).toMatchObject({
    success: false,
    value: null,
    errorType: 'invalid_response',
  });
});

test('pre-cancellation starts no download', async () => {
  const abort = new AbortController();
  abort.abort();
  const fs = filesystem();
  expect(
    await runFileDownload(attempt, config, abort.signal, clock(), fs),
  ).toMatchObject({ errorType: 'cancelled' });
  expect(fs.downloadFile).not.toHaveBeenCalled();
});

test('cancellation waits for native cleanup before deleting its file', async () => {
  let settle;
  const fs = filesystem(
    new Promise(resolve => {
      settle = resolve;
    }),
  );
  const abort = new AbortController();
  const pending = runFileDownload(attempt, config, abort.signal, clock(), fs);
  abort.abort();
  expect(fs.stopDownload).toHaveBeenCalledWith(7);
  expect(fs.unlink).not.toHaveBeenCalled();
  settle(response);
  expect(await pending).toMatchObject({
    success: false,
    errorType: 'cancelled',
  });
  expect(fs.unlink).toHaveBeenCalledTimes(1);
});

test('deadline and unexpected declared size request native cancellation', async () => {
  jest.useFakeTimers();
  let settle;
  const fs = filesystem(
    new Promise(resolve => {
      settle = resolve;
    }),
  );
  const pending = runFileDownload(attempt, config, undefined, clock(), fs);
  await jest.advanceTimersByTimeAsync(config.timeoutMs);
  expect(fs.stopDownload).toHaveBeenCalledWith(7);
  settle(response);
  expect(await pending).toMatchObject({ errorType: 'timeout' });
  const invalid = filesystem();
  const bad = runFileDownload(attempt, config, undefined, clock(), invalid);
  invalid.downloadFile.mock.calls[0][0].begin({
    statusCode: 200,
    headers,
    contentLength: 1,
  });
  expect(await bad).toMatchObject({ errorType: 'invalid_response' });
  expect(invalid.stopDownload).toHaveBeenCalledWith(7);
});
