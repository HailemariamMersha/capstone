import { NativeModules } from 'react-native';
import { Buffer } from 'buffer';
import type {
  Measurement,
  PacketObservation,
  ProbeErrorType,
  RawProbeOutput,
  TraceSample,
} from './types';

export interface LibraryIcmpResponse {
  runId: string;
  reason: 'complete' | 'timeout' | 'cancelled' | 'network' | 'unsupported';
  error: string | null;
  result: TraceSample | null;
}
export interface LibraryIcmpAdapter {
  ping(
    id: string,
    host: string,
    timeout: number,
    payload: string,
  ): Promise<LibraryIcmpResponse>;
  cancel(id: string): void;
}

/** Decodes the library's returned ICMP message; never opens or implements a socket. */
export async function runLibraryIcmp(
  attempt: Measurement,
  host: string,
  timeoutMs: number,
  signal: AbortSignal,
  adapter: LibraryIcmpAdapter | undefined = NativeModules.CapstoneLibraryIcmp,
): Promise<Measurement> {
  const started = performance.now();
  const payload = `CPSPKT1:${attempt.id}:`.padEnd(64, '.').slice(0, 64);
  const raw: RawProbeOutput = {
    library: 'icmpenguin',
    version: '1.0.0-rc.3',
    source: 'library_probe_result',
    request: {
      host,
      ttl: 64,
      packetSize: 64,
      libraryProbeSize: 72,
      timeoutMs: Math.min(timeoutMs, 10000),
      requestedPayloadHex: Buffer.from(payload).toString('hex'),
    },
    callbacks: [],
    unavailable: [
      'completeIpPacketCapture',
      'kernelSendReceiveTimestamps',
      'kernelAssignedRequestIdentifier',
      'icmpTypeForAllErrorVariants',
      'observedReplySourceAddress',
    ],
  };
  let errorType: ProbeErrorType | null = null;
  let errorMessage: string | null = null;
  let value: number | null = null;
  let ttl: number | null = null;
  let packet: PacketObservation | undefined;
  const cancel = () => adapter?.cancel(attempt.id);
  try {
    if (signal.aborted) throw new Error('ICMP cancelled.');
    if (!adapter) throw new Error('ICMP library adapter is unavailable.');
    const pending = adapter.ping(
      attempt.id,
      host,
      Math.min(timeoutMs, 10000),
      payload,
    );
    signal.addEventListener('abort', cancel);
    if (signal.aborted) cancel();
    const response = await pending;
    raw.callbacks.push({
      observedAt: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      value: response,
    });
    if (response.runId !== attempt.id)
      throw new Error('Mismatched ICMP run ID.');
    if (signal.aborted || response.reason === 'cancelled') {
      errorType = 'cancelled';
    } else if (response.reason !== 'complete') {
      errorType = response.reason === 'timeout' ? 'timeout' : 'network';
      errorMessage = response.error ?? `ICMP library ended: ${response.reason}`;
    } else {
      const row = response.result;
      const native = row?.rawResult;
      if (!row || !native) throw new Error('Missing ICMP library result.');
      packet = {
        runId: attempt.id,
        engine: 'icmpenguin',
        engineVersion: '1.0.0-rc.3',
        outcome: row.kind,
        protocol: 'icmp',
        packetCapture: false,
        targetHost: host,
        resolvedAddress: row.remote,
        probeTtl: 64,
        libraryResult: native,
      };
      if (native.variant === 'Success') {
        if (typeof native.dataBase64 !== 'string')
          throw new Error('Missing reply bytes.');
        const bytes = Buffer.from(native.dataBase64, 'base64');
        const ipVersion = row.remote.includes(':') ? 6 : 4;
        // The pinned library passes recvmsg's complete ICMP message in Success.data.
        const echo =
          bytes.length === 72 &&
          bytes[0] === (ipVersion === 6 ? 129 : 0) &&
          bytes[1] === 0;
        const matches =
          echo &&
          bytes.readUInt16BE(6) === row.sequence &&
          Buffer.from(bytes.subarray(8)).equals(Buffer.from(payload));
        packet.ipVersion = ipVersion;
        packet.response = {
          receivedHex: bytes.toString('hex'),
          receivedScope: 'icmp_message_from_library',
          receivedSocketBytes: bytes.length,
          replyTtl: typeof native.ttl === 'number' ? native.ttl : undefined,
          matched: matches,
          correlation: 'sequence_payload_not_request_identifier',
          ...(bytes.length >= 8
            ? {
                icmpType: bytes[0],
                icmpCode: bytes[1],
                icmpChecksum: bytes.readUInt16BE(2),
                icmpIdentifier: bytes.readUInt16BE(4),
                icmpSequence: bytes.readUInt16BE(6),
              }
            : {}),
        };
        if (
          !matches ||
          row.rttMs == null ||
          !Number.isFinite(row.rttMs) ||
          row.rttMs < 0
        )
          throw new Error(
            'Invalid or uncorrelated ICMP reply. Raw bytes retained.',
          );
        packet.outcome = 'reply';
        value = row.rttMs;
        ttl =
          typeof native.ttl === 'number' && native.ttl >= 0 ? native.ttl : null;
      } else {
        errorType = native.variant === 'Timeout' ? 'timeout' : 'network';
        errorMessage = `ICMP library result: ${String(native.variant)}`;
      }
    }
  } catch (error) {
    errorType = signal.aborted ? 'cancelled' : 'invalid_response';
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  return {
    ...attempt,
    method: 'icmp_echo_icmpenguin',
    targetHost: host,
    raw,
    packet,
    ttl,
    durationMs: performance.now() - started,
    success: !errorType && value !== null,
    value: errorType ? null : value,
    errorType,
    errorMessage,
    transferredBytes: null,
  };
}
