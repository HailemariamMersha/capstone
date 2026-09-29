import {
  collectPacket,
  runPacketIcmp,
  runPacketTcp,
  runPacketTrace,
  runPacketUdp,
  traceKind,
} from '../src/measurements/packet';
import type { PacketAdapter } from '../src/measurements/packet';
import type { Measurement, PacketObservation } from '../src/measurements/types';
import { DEFAULT_SESSION_CONFIG } from '../src/sessions/config';
const attempt = {
  id: 'a'.repeat(32),
  sessionId: 's',
  success: false,
  value: null,
  unit: 'ms',
} as Measurement;
const adapter = (result: Partial<PacketObservation>): PacketAdapter => ({
  probe: jest.fn(async id => JSON.stringify({ runId: id, ...result })),
  cancel: jest.fn(),
});
const signal = () => new AbortController().signal;
test('ICMP stores real header fields and exact byte/timestamp strings', async () => {
  const packet = {
    outcome: 'reply',
    response: {
      elapsedUs: 12500,
      icmpType: 0,
      icmpCode: 0,
      icmpIdentifier: 4096,
      icmpSequence: 0,
      replyTtl: 52,
      receivedHex: '0000abcd10000000',
      kernelReceiveRealtimeNs: '1790700000000000123',
    },
  };
  const result = await runPacketIcmp(
    attempt,
    '192.0.2.1',
    2000,
    signal(),
    adapter(packet),
  );
  expect(result).toMatchObject({
    success: true,
    value: 12.5,
    ttl: 52,
    method: 'native_icmp_datagram',
    packet,
  });
  expect(result.raw!.unavailable).toContain('completeIpPacketCapture');
});
test('preserves original extended errors and distinguishes expiry from unreachable', () => {
  const expired: PacketObservation = {
    runId: 'trace',
    outcome: 'icmp_error',
    response: {
      icmpType: 11,
      icmpCode: 0,
      extendedError: { origin: 2, errno: 113 },
    },
  };
  expect(traceKind(expired)).toBe('time_exceeded');
  expect(
    traceKind({
      ...expired,
      response: { ...expired.response, icmpType: 3, icmpCode: 1 },
    }),
  ).toBe('icmp_error');
  expect(
    traceKind({
      ...expired,
      response: { ...expired.response, icmpType: 3, icmpCode: 3 },
    }),
  ).toBe('port_unreachable');
  expect(
    traceKind({
      ...expired,
      outcome: 'local_error',
      response: { extendedError: { origin: 1, errno: 113 } },
    }),
  ).toBe('error');
});
test('traceroute retains expiry and only accepts destination refusal as arrival', async () => {
  const native: PacketAdapter = {
    cancel: jest.fn(),
    probe: jest.fn(async (id, host, _p, _port, ttl) =>
      JSON.stringify({
        runId: id,
        outcome: 'icmp_error',
        targetAddress: host,
        ipVersion: 4,
        response: {
          elapsedUs: 1000,
          responderAddress: ttl === 2 ? host : '192.0.2.254',
          icmpType: ttl === 2 ? 3 : 11,
          icmpCode: ttl === 2 ? 3 : 0,
          extendedError: { origin: 2 },
        },
      }),
    ),
  };
  const result = await runPacketTrace(
    attempt,
    { ...DEFAULT_SESSION_CONFIG, tracerouteHost: '192.0.2.1' },
    signal(),
    native,
  );
  expect(result).toMatchObject({
    success: true,
    value: 2,
    route: { reachedHop: 2, library: 'capstone-linux-sockets' },
  });
  expect(result.route!.samples).toHaveLength(6);
  expect(result.route!.samples[0]).toMatchObject({
    kind: 'time_exceeded',
    icmpType: 11,
    icmpCode: 0,
  });
});
test('intermediate refusal cannot be mistaken for reaching the target', async () => {
  const result = await runPacketTrace(
    attempt,
    {
      ...DEFAULT_SESSION_CONFIG,
      tracerouteHost: '192.0.2.1',
      tracerouteMaxHops: 1,
    },
    signal(),
    adapter({
      outcome: 'icmp_error',
      targetAddress: '192.0.2.1',
      response: {
        elapsedUs: 2000,
        responderAddress: '192.0.2.254',
        icmpType: 3,
        icmpCode: 3,
        extendedError: { origin: 2 },
      },
    }),
  );
  expect(result.success).toBe(false);
  expect(result.route!.samples).toHaveLength(3);
});
test('abort waits for native settlement and keeps any returned raw observation', async () => {
  let resolve!: (value: string) => void;
  const native = {
    probe: jest.fn(
      () =>
        new Promise<string>(done => {
          resolve = done;
        }),
    ),
    cancel: jest.fn(),
  };
  const abort = new AbortController();
  const pending = collectPacket(
    'id',
    '192.0.2.1',
    'icmp',
    0,
    64,
    0,
    '00',
    1000,
    abort.signal,
    native,
  );
  abort.abort();
  expect(native.cancel).toHaveBeenCalledWith('id');
  resolve(
    JSON.stringify({ runId: 'id', outcome: 'cancelled', sentSocketBytes: 9 }),
  );
  expect(await pending).toMatchObject({
    outcome: 'cancelled',
    sentSocketBytes: 9,
  });
});
test('invalid response identity is preserved without a successful metric', async () => {
  const native = adapter({ runId: 'wrong', outcome: 'reply' });
  const packet = await collectPacket(
    'id',
    '192.0.2.1',
    'icmp',
    0,
    64,
    0,
    '00',
    1000,
    signal(),
    native,
  );
  expect(packet.outcome).toBe('invalid_response');
  expect(packet.rawNativeOutput).toContain('wrong');
});
test('TCP_INFO kernel RTT stays distinct from native connect duration', async () => {
  const native = adapter({
    outcome: 'connected',
    connectDurationUs: 5000,
    tcpInfoAfter: { tcpi_rtt: 400, tcpi_total_retrans: 1 },
  });
  const result = await runPacketTcp(
    attempt,
    'http://192.0.2.1:8000',
    1000,
    signal(),
    native,
  );
  expect(result.value).toBe(5);
  expect(result.packet!.tcpInfoAfter).toEqual({
    tcpi_rtt: 400,
    tcpi_total_retrans: 1,
  });
});
test('UDP ICMP error observations do not become round-trip packet-loss estimates', async () => {
  jest.useFakeTimers();
  try {
    const pending = runPacketUdp(
      attempt,
      '192.0.2.1',
      9876,
      1000,
      signal(),
      adapter({
        outcome: 'icmp_error',
        sentSocketBytes: 128,
        response: { icmpType: 3, icmpCode: 3, extendedError: { origin: 2 } },
      }),
    );
    await jest.runAllTimersAsync();
    const result = await pending;
    expect(result.details!.samples).toHaveLength(20);
    expect(result.details!.lossPercent).toBeNull();
    expect(result.details!.samples[0].packet!.response!.icmpCode).toBe(3);
  } finally {
    jest.useRealTimers();
  }
});

test('malformed native JSON is retained verbatim as a failed observation', async () => {
  const packet = await collectPacket(
    'id',
    '127.0.0.1',
    'icmp',
    0,
    64,
    0,
    '00',
    1000,
    signal(),
    {
      probe: jest.fn(async () => '{broken-output'),
      cancel: jest.fn(),
    },
  );
  expect(packet).toMatchObject({
    outcome: 'invalid_response',
    rawNativeOutput: '{broken-output',
  });
});
