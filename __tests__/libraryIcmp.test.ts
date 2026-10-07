import { Buffer } from 'buffer';
import { runLibraryIcmp } from '../src/measurements/libraryIcmp';
import type { LibraryIcmpAdapter } from '../src/measurements/libraryIcmp';
import type { Measurement } from '../src/measurements/types';
const attempt = {
  id: 'a'.repeat(32),
  success: false,
  value: null,
} as Measurement;
function adapter(
  change: (bytes: Buffer) => void = () => {},
): LibraryIcmpAdapter {
  return {
    cancel: jest.fn(),
    ping: jest.fn(async (id, host, _timeout, payload) => {
      const bytes = Buffer.alloc(72);
      bytes.writeUInt16BE(4321, 4);
      bytes.writeUInt16BE(1, 6);
      Buffer.from(payload).copy(bytes, 8);
      change(bytes);
      return {
        runId: id,
        reason: 'complete' as const,
        error: null,
        result: {
          hop: 64,
          sequence: 1,
          remote: host,
          address: host,
          kind: 'reply' as const,
          rttMs: 12.5,
          probeBytes: 72,
          overheadBytes: 20,
          icmpType: null,
          icmpCode: null,
          rawResult: {
            variant: 'Success',
            sequence: 1,
            elapsedUsec: 12500,
            ttl: 52,
            dataBase64: bytes.toString('base64'),
          },
        },
      };
    }),
  };
}
test('decodes actual reply bytes from the library and retains the complete callback', async () => {
  const result = await runLibraryIcmp(
    attempt,
    '127.0.0.1',
    2000,
    new AbortController().signal,
    adapter(),
  );
  expect(result).toMatchObject({
    success: true,
    value: 12.5,
    ttl: 52,
    raw: { library: 'icmpenguin' },
    packet: {
      engine: 'icmpenguin',
      response: {
        icmpType: 0,
        icmpCode: 0,
        icmpIdentifier: 4321,
        icmpSequence: 1,
        receivedSocketBytes: 72,
        matched: true,
      },
    },
  });
  expect(result.raw!.callbacks).toHaveLength(1);
  expect(result.packet!.response!.kernelReceiveRealtimeNs).toBeUndefined();
  expect(result.packet!.response!.responderAddress).toBeUndefined();
});
test('wrong payload fails correlation without discarding returned bytes', async () => {
  const result = await runLibraryIcmp(
    attempt,
    '127.0.0.1',
    2000,
    new AbortController().signal,
    adapter(bytes => {
      bytes[10] = 0;
    }),
  );
  expect(result).toMatchObject({
    success: false,
    errorType: 'invalid_response',
    packet: { response: { matched: false } },
  });
  expect(result.packet!.response!.receivedHex).toHaveLength(144);
});
test('IPv6 echo header is decoded from the returned bytes', async () => {
  const result = await runLibraryIcmp(
    attempt,
    '::1',
    2000,
    new AbortController().signal,
    adapter(bytes => {
      bytes[0] = 129;
    }),
  );
  expect(result).toMatchObject({
    success: true,
    packet: { ipVersion: 6, response: { icmpType: 129 } },
  });
});
test('cancellation reaches the library and cannot turn a late reply into success', async () => {
  const a = adapter();
  const abort = new AbortController();
  const pending = runLibraryIcmp(attempt, '127.0.0.1', 2000, abort.signal, a);
  abort.abort();
  expect(await pending).toMatchObject({
    success: false,
    errorType: 'cancelled',
  });
  expect(a.cancel).toHaveBeenCalledWith(attempt.id);
});
test('a specialized error retains its classification without invented ICMP codes', async () => {
  const a: LibraryIcmpAdapter = {
    cancel: jest.fn(),
    ping: jest.fn(async id => ({
      runId: id,
      reason: 'complete' as const,
      error: null,
      result: {
        hop: 64,
        sequence: 1,
        remote: '127.0.0.1',
        address: '127.0.0.1',
        kind: 'host_unreachable' as const,
        rttMs: 10,
        probeBytes: 72,
        overheadBytes: 20,
        icmpType: null,
        icmpCode: null,
        rawResult: {
          variant: 'HostUnreachable',
          offender: '127.0.0.1',
          elapsedUsec: 10000,
        },
      },
    })),
  };
  const result = await runLibraryIcmp(
    attempt,
    '127.0.0.1',
    2000,
    new AbortController().signal,
    a,
  );
  expect(result).toMatchObject({
    success: false,
    errorType: 'network',
    packet: { libraryResult: { variant: 'HostUnreachable' } },
  });
  expect(result.packet!.response).toBeUndefined();
});
