import {
  DEFAULT_PROBE_CONFIG as config,
  MIB,
} from '../src/measurements/config';
import { runProbe } from '../src/measurements/runProbe';
import type { ProbeDependencies } from '../src/measurements/runProbe';

function response(
  overrides: Partial<Response> = {},
  extraHeaders: Record<string, string> = {},
): Response {
  const headers: Record<string, string> = {
    'x-capstone-probe': '1',
    'x-probe-region': 'test',
    ...extraHeaders,
  };
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => 'pong',
    arrayBuffer: async () => new ArrayBuffer(MIB),
    json: async () => ({ receivedBytes: config.uploadBytes }),
    ...overrides,
  } as Response;
}
function deps(value = response()): ProbeDependencies {
  return {
    fetch: jest.fn().mockResolvedValue(value),
    now: jest.fn().mockReturnValueOnce(100).mockReturnValue(1100),
    timestamp: () => '2026-09-18T00:00:00.000Z',
  };
}
afterEach(() => {
  jest.useRealTimers();
});

test('RTT consumes the response body and reports application-level milliseconds', async () => {
  const read = jest.fn(async () => 'pong');
  const dependencies = deps(response({ text: read }));
  const result = await runProbe(
    'http_rtt',
    config,
    'session',
    undefined,
    dependencies,
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    success: true,
    sessionId: 'session',
    value: 1000,
    unit: 'ms',
    transferredBytes: 4,
    probeRegion: 'test',
  });
  expect(dependencies.fetch).toHaveBeenCalledWith(
    expect.stringContaining('/ping?request='),
    expect.objectContaining({ method: 'GET' }),
  );
});

test('download counts the complete body and converts bytes to decimal Mbps', async () => {
  const result = await runProbe('download', config, 's', undefined, deps());
  expect(result).toMatchObject({
    success: true,
    transferredBytes: MIB,
    requestedBytes: MIB,
    unit: 'Mbps',
  });
  expect(result.value).toBeCloseTo(8.388608);
});

test('upload sends the requested ASCII byte count and verifies acknowledgement', async () => {
  const dependencies = deps();
  const result = await runProbe('upload', config, 's', undefined, dependencies);
  const options = jest.mocked(dependencies.fetch).mock.calls[0][1];
  expect((options?.body as string).length).toBe(config.uploadBytes);
  expect(options?.method).toBe('POST');
  expect(result).toMatchObject({
    success: true,
    transferredBytes: config.uploadBytes,
  });
  expect(result.value).toBeCloseTo(2.097152);
});

test.each([
  ['http', response({ ok: false, status: 503 })],
  ['invalid_response', response({}, { 'x-capstone-probe': '' })],
  ['invalid_response', response({}, { 'content-encoding': 'gzip' })],
  [
    'invalid_response',
    response({ arrayBuffer: async () => new ArrayBuffer(12) }),
  ],
] as const)(
  'download records %s failures without a throughput value',
  async (kind, res) => {
    const result = await runProbe(
      'download',
      config,
      's',
      undefined,
      deps(res),
    );
    expect(result).toMatchObject({
      success: false,
      errorType: kind,
      value: null,
      transferredBytes: null,
    });
  },
);

test('upload rejects a partial or malformed acknowledgement', async () => {
  for (const json of [
    async () => ({ receivedBytes: 5 }),
    async () => {
      throw new Error('bad json');
    },
  ]) {
    const result = await runProbe(
      'upload',
      config,
      's',
      undefined,
      deps(response({ json })),
    );
    expect(result.errorType).toBe('invalid_response');
  }
});

test('network rejection produces a structured failed result', async () => {
  const dependencies = deps();
  jest
    .mocked(dependencies.fetch)
    .mockRejectedValue(new Error('Network request failed'));
  expect(
    await runProbe('http_rtt', config, 's', undefined, dependencies),
  ).toMatchObject({ success: false, errorType: 'network', httpStatus: null });
});

test('timeout includes body reading and aborts the underlying request', async () => {
  jest.useFakeTimers();
  const dependencies = deps(
    response({ arrayBuffer: () => new Promise(() => {}) }),
  );
  const pending = runProbe(
    'download',
    { ...config, timeoutMs: 100 },
    's',
    undefined,
    dependencies,
  );
  await jest.advanceTimersByTimeAsync(100);
  expect((await pending).errorType).toBe('timeout');
  expect(
    jest.mocked(dependencies.fetch).mock.calls[0][1]?.signal?.aborted,
  ).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

test('cancel aborts an in-flight probe and prevents a pre-cancelled request', async () => {
  const controller = new AbortController();
  const dependencies = deps();
  jest
    .mocked(dependencies.fetch)
    .mockImplementation(() => new Promise(() => {}));
  const pending = runProbe(
    'http_rtt',
    config,
    's',
    controller.signal,
    dependencies,
  );
  controller.abort();
  expect((await pending).errorType).toBe('cancelled');
  expect(
    (await runProbe('http_rtt', config, 's', controller.signal, dependencies))
      .errorType,
  ).toBe('cancelled');
  expect(dependencies.fetch).toHaveBeenCalledTimes(1);
});

test.each([
  { serverUrl: 'ftp://host' },
  { timeoutMs: 0 },
  { downloadBytes: 0 },
  { uploadBytes: Infinity },
])(
  'invalid configuration is rejected before using the network',
  async override => {
    const dependencies = deps();
    expect(
      (
        await runProbe(
          'http_rtt',
          { ...config, ...override },
          's',
          undefined,
          dependencies,
        )
      ).errorType,
    ).toBe('invalid_config');
    expect(dependencies.fetch).not.toHaveBeenCalled();
  },
);

test('custom payload sizes reach the request and exact-byte acknowledgement', async () => {
  const custom = { ...config, downloadBytes: 2621441, uploadBytes: 2 * MIB };
  const download = deps(
    response({
      arrayBuffer: async () => new ArrayBuffer(custom.downloadBytes),
    }),
  );
  expect(
    await runProbe('download', custom, 's', undefined, download),
  ).toMatchObject({
    success: true,
    requestedBytes: 2621441,
    transferredBytes: 2621441,
  });
  expect(download.fetch).toHaveBeenCalledWith(
    expect.stringContaining('/download/2621441?'),
    expect.anything(),
  );
  const upload = deps(
    response({ json: async () => ({ receivedBytes: custom.uploadBytes }) }),
  );
  expect(
    await runProbe('upload', custom, 's', undefined, upload),
  ).toMatchObject({
    success: true,
    requestedBytes: 2 * MIB,
    transferredBytes: 2 * MIB,
  });
  expect(
    (jest.mocked(upload.fetch).mock.calls[0][1]?.body as string).length,
  ).toBe(2 * MIB);
});
