import { NativeModules, Platform } from 'react-native';
import { Buffer } from 'buffer';
import type {
  Measurement,
  PacketObservation,
  ProbeErrorType,
  ProbeSample,
  TraceSample,
} from './types';
import type { MeasurementConfig } from '../sessions/types';
import { latencySummary, pause } from './statistics';

export const PACKET_ENGINE_VERSION = '1.0.0';
export interface PacketAdapter {
  probe(
    id: string,
    host: string,
    protocol: string,
    port: number,
    ttl: number,
    sequence: number,
    payloadHex: string,
    timeoutMs: number,
  ): Promise<string>;
  cancel(id: string): void;
}
const nativeAdapter = (): PacketAdapter | undefined =>
  Platform.OS === 'android' ? NativeModules.CapstonePacketProbe : undefined;
export function packetPayload(
  id: string,
  sequence: number,
  size: number,
): string {
  // A fresh durable attempt ID plus sequence correlates our own probes; no user traffic.
  return Buffer.from(
    `CPSPKT1:${id}:${sequence}:`.padEnd(size, '.').slice(0, size),
    'ascii',
  ).toString('hex');
}
export async function collectPacket(
  id: string,
  host: string,
  protocol: 'icmp' | 'udp' | 'tcp',
  port: number,
  ttl: number,
  sequence: number,
  payloadHex: string,
  timeoutMs: number,
  signal: AbortSignal,
  adapter = nativeAdapter(),
): Promise<PacketObservation> {
  if (signal.aborted) return { runId: id, outcome: 'cancelled' };
  if (!adapter)
    return {
      runId: id,
      outcome: 'unsupported',
      errorMessage:
        'Native packet probes require the Android packet-engine build.',
    };
  const cancel = () => adapter.cancel(id);
  let nativeText: string | undefined;
  try {
    const pending = adapter.probe(
      id,
      host,
      protocol,
      port,
      ttl,
      sequence,
      payloadHex,
      Math.max(1, Math.min(10000, timeoutMs)),
    );
    signal.addEventListener('abort', cancel);
    if (signal.aborted) cancel();
    const text = await pending; // Native cancellation/timeout settles after socket cleanup.
    nativeText = text;
    const packet = JSON.parse(text) as PacketObservation;
    if (
      !packet ||
      packet.runId !== id ||
      ![
        'reply',
        'connected',
        'icmp_error',
        'local_error',
        'socket_error',
        'timeout',
        'cancelled',
      ].includes(packet.outcome)
    ) {
      return { runId: id, outcome: 'invalid_response', rawNativeOutput: text };
    }
    if (signal.aborted) return { ...packet, outcome: 'cancelled' };
    return packet;
  } catch (error) {
    return {
      runId: id,
      outcome: signal.aborted
        ? 'cancelled'
        : nativeText !== undefined
        ? 'invalid_response'
        : 'socket_error',
      ...(nativeText !== undefined ? { rawNativeOutput: nativeText } : {}),
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
export function packetError(packet: PacketObservation): ProbeErrorType | null {
  if (packet.outcome === 'reply' || packet.outcome === 'connected') return null;
  if (
    packet.outcome === 'timeout' ||
    packet.outcome === 'cancelled' ||
    packet.outcome === 'invalid_response'
  )
    return packet.outcome;
  return 'network';
}
function packetRtt(packet: PacketObservation): number | null {
  const us = packet.response?.elapsedUs;
  return typeof us === 'number' && Number.isFinite(us) && us >= 0
    ? us / 1000
    : null;
}
function metadata(host: string, protocol: string) {
  return {
    library: 'capstone-linux-sockets',
    version: PACKET_ENGINE_VERSION,
    source: 'native_socket_observation',
    request: { host, protocol },
    callbacks: [],
    unavailable: ['completeIpPacketCapture', 'hardwareTransmitTimestamp'],
  };
}
export async function runPacketIcmp(
  attempt: Measurement,
  host: string,
  timeoutMs: number,
  signal: AbortSignal,
  adapter = nativeAdapter(),
): Promise<Measurement> {
  const started = performance.now();
  const packet = await collectPacket(
    attempt.id,
    host,
    'icmp',
    0,
    64,
    0,
    packetPayload(attempt.id, 0, 64),
    Math.min(timeoutMs, 2000),
    signal,
    adapter,
  );
  const rtt = packetRtt(packet),
    success = packet.outcome === 'reply' && rtt !== null;
  return {
    ...attempt,
    timestamp: new Date(
      Date.now() - (performance.now() - started),
    ).toISOString(),
    method: 'native_icmp_datagram',
    targetHost: host,
    packet,
    raw: metadata(host, 'icmp'),
    durationMs: performance.now() - started,
    success,
    value: success ? rtt : null,
    ttl: packet.response?.replyTtl ?? null,
    errorType: success ? null : packetError(packet) ?? 'invalid_response',
    errorMessage: success
      ? null
      : packet.errorMessage ?? `Packet outcome: ${packet.outcome}`,
    transferredBytes: success ? 64 : null,
  };
}
export async function runPacketTcp(
  attempt: Measurement,
  serverUrl: string,
  timeoutMs: number,
  signal: AbortSignal,
  adapter = nativeAdapter(),
): Promise<Measurement> {
  const url = new URL(serverUrl),
    host = url.hostname.replace(/^\[|\]$/g, ''),
    port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const started = performance.now(),
    timestamp = new Date().toISOString();
  const packet = await collectPacket(
    attempt.id,
    host,
    'tcp',
    port,
    64,
    0,
    '',
    timeoutMs,
    signal,
    adapter,
  );
  const success = packet.outcome === 'connected',
    value =
      success && typeof packet.connectDurationUs === 'number'
        ? packet.connectDurationUs / 1000
        : null;
  return {
    ...attempt,
    timestamp,
    method: 'native_tcp_connect_and_info',
    targetHost: host,
    packet,
    raw: metadata(host, 'tcp'),
    success,
    value,
    durationMs: performance.now() - started,
    errorType: packetError(packet),
    errorMessage: success ? null : packet.errorMessage ?? packet.outcome,
    transferredBytes: 0,
    details: {
      protocolVersion: 1,
      samples: [
        {
          sequence: 0,
          timestamp,
          rttMs: value,
          errorType: packetError(packet),
        },
      ],
      summary: latencySummary([
        {
          sequence: 0,
          timestamp,
          rttMs: value,
          errorType: packetError(packet),
        },
      ]),
      targetPort: port,
    },
  };
}
export async function runPacketUdp(
  attempt: Measurement,
  host: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
  adapter = nativeAdapter(),
): Promise<Measurement> {
  const started = performance.now(),
    samples: ProbeSample[] = [];
  let sentCount = 0;
  for (let sequence = 0; sequence < 20 && !signal.aborted; sequence++) {
    const timestamp = new Date().toISOString();
    // Retain the controlled echo protocol accepted by backend/udp_echo.py.
    const nonce = attempt.id
      .replace(/[^a-f0-9]/g, '')
      .slice(-32)
      .padStart(32, '0');
    const payloadHex = Buffer.from(
      `CPSUDP1:${nonce}:${String(sequence).padStart(4, '0')}:`.padEnd(128, '.'),
      'ascii',
    ).toString('hex');
    const packet = await collectPacket(
      `${attempt.id}-${sequence}`,
      host,
      'udp',
      port,
      64,
      sequence,
      payloadHex,
      Math.min(timeoutMs, 2000),
      signal,
      adapter,
    );
    if (packet.sentSocketBytes === 128) sentCount++;
    samples.push({
      sequence,
      timestamp,
      rttMs: packet.outcome === 'reply' ? packetRtt(packet) : null,
      errorType: packetError(packet),
      packet,
    });
    if (
      ['unsupported', 'socket_error', 'cancelled', 'local_error'].includes(
        packet.outcome,
      )
    )
      break;
    if (sequence < 19) await pause(250, signal);
  }
  const summary = latencySummary(samples),
    complete = samples.length === 20 && !signal.aborted;
  const success = complete && summary.replies > 0;
  return {
    ...attempt,
    method: 'native_udp_echo_datagrams',
    targetHost: host,
    raw: metadata(host, 'udp'),
    durationMs: performance.now() - started,
    success,
    value: success ? summary.medianMs : null,
    errorType: signal.aborted
      ? 'cancelled'
      : success
      ? null
      : samples.find(s => s.errorType)?.errorType ?? 'timeout',
    errorMessage: success
      ? null
      : 'UDP observations include timeout, ICMP or local socket failures; inspect individual packets.',
    transferredBytes: null,
    details: {
      protocolVersion: 1,
      samples,
      summary,
      requestedCount: 20,
      sentCount,
      complete,
      targetPort: port,
      lossPercent:
        complete &&
        sentCount === 20 &&
        samples.every(s => s.errorType === null || s.errorType === 'timeout')
          ? (100 * (20 - summary.replies)) / 20
          : null,
    },
  };
}
export function traceKind(packet: PacketObservation): TraceSample['kind'] {
  const response = packet.response,
    error = response?.extendedError;
  if (packet.outcome === 'reply') return 'reply';
  if (packet.outcome === 'timeout') return 'timeout';
  // Decode actual ICMP fields, never errno-derived labels. Local errors have no ICMP type/code.
  if (
    (error?.origin === 2 && response?.icmpType === 11) ||
    (error?.origin === 3 && response?.icmpType === 3)
  )
    return 'time_exceeded';
  if (
    (error?.origin === 2 &&
      response?.icmpType === 3 &&
      response?.icmpCode === 3) ||
    (error?.origin === 3 &&
      response?.icmpType === 1 &&
      response?.icmpCode === 4)
  )
    return 'port_unreachable';
  return response?.icmpType != null ? 'icmp_error' : 'error';
}
export async function runPacketTrace(
  attempt: Measurement,
  config: MeasurementConfig,
  signal: AbortSignal,
  adapter = nativeAdapter(),
): Promise<Measurement> {
  const host = config.tracerouteHost!,
    started = performance.now(),
    samples: TraceSample[] = [];
  const maxHops = config.tracerouteMaxHops ?? 20;
  let resolvedHost = host;
  let reachedHop: number | null = null,
    stopReason = 'hop_limit',
    stopped = false;
  for (let hop = 1; hop <= maxHops && !stopped; hop++) {
    for (let probeIndex = 0; probeIndex < 3; probeIndex++) {
      if (signal.aborted) {
        stopReason = 'cancelled';
        stopped = true;
        break;
      }
      const remaining = 45000 - (performance.now() - started);
      if (remaining <= 0) {
        stopReason = 'timeout';
        stopped = true;
        break;
      }
      const sequence = (hop - 1) * 3 + probeIndex;
      const packet = await collectPacket(
        `${attempt.id}-${sequence}`,
        resolvedHost,
        'udp',
        33434 + sequence,
        hop,
        sequence,
        packetPayload(attempt.id, sequence, 32),
        Math.min(1000, Math.floor(remaining)),
        signal,
        adapter,
      );
      if (packet.targetAddress) resolvedHost = packet.targetAddress;
      const kind = traceKind(packet),
        response = packet.response;
      const address = response?.responderAddress || null;
      samples.push({
        hop,
        sequence,
        remote: packet.targetAddress ?? packet.resolvedAddress ?? host,
        address,
        kind,
        rttMs: packetRtt(packet),
        probeBytes: 32,
        overheadBytes: packet.ipVersion === 6 ? 48 : 28,
        icmpType: response?.icmpType ?? null,
        icmpCode: response?.icmpCode ?? null,
        packet,
      });
      if (
        (kind === 'port_unreachable' || kind === 'reply') &&
        address === packet.targetAddress
      )
        reachedHop = hop;
      if (
        ['unsupported', 'socket_error', 'cancelled', 'local_error'].includes(
          packet.outcome,
        )
      ) {
        stopReason = packet.outcome;
        stopped = true;
        break;
      }
    }
    if (stopped) break;
    if (reachedHop !== null) {
      stopReason = 'destination_reached';
      break;
    }
  }
  const success = reachedHop !== null && !signal.aborted;
  return {
    ...attempt,
    method: 'native_udp_traceroute_error_queue',
    targetHost: host,
    probeServer: host,
    raw: metadata(host, 'udp'),
    durationMs: performance.now() - started,
    success,
    value: success ? reachedHop : null,
    unit: 'hops',
    transferredBytes: null,
    errorType: signal.aborted
      ? 'cancelled'
      : success
      ? null
      : stopReason === 'hop_limit' || stopReason === 'timeout'
      ? 'timeout'
      : 'network',
    errorMessage: success
      ? null
      : `Traceroute stopped: ${stopReason}. Partial packet observations retained.`,
    route: {
      library: 'capstone-linux-sockets',
      version: PACKET_ENGINE_VERSION,
      protocol: 'udp',
      maxHops,
      probesPerHop: 3,
      probeBytes: 32,
      timeoutPerProbeMs: 1000,
      deadlineMs: 45000,
      reached: reachedHop !== null,
      reachedHop,
      complete:
        stopReason === 'destination_reached' || stopReason === 'hop_limit',
      stopReason,
      samples,
    },
  };
}
