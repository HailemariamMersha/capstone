import { NativeModules, Platform } from 'react-native';
import type {
  Measurement,
  ProbeErrorType,
  TraceSample,
  RawProbeOutput,
} from './types';
import type { MeasurementConfig } from '../sessions/types';

export const TRACE_VERSION = '1.0.0-rc.3';
export const TRACE_MAX_HOPS = 20;
export const TRACE_PROBES_PER_HOP = 3;
export interface TraceResponse {
  runId: string;
  reason: 'complete' | 'timeout' | 'cancelled' | 'network' | 'unsupported';
  error: string | null;
  samples: TraceSample[];
}
export interface TraceAdapter {
  trace(
    id: string,
    host: string,
    maxHops: number,
    probesPerHop: number,
  ): Promise<TraceResponse>;
  cancel(id: string): void;
}
const kinds = new Set([
  'reply',
  'timeout',
  'port_unreachable',
  'host_unreachable',
  'network_unreachable',
  'icmp_error',
  'error',
]);
const ip = (value: unknown) =>
  typeof value === 'string' &&
  value.length <= 64 &&
  /^[0-9a-fA-F:.]+$/.test(value);
export function validateTraceResponse(
  value: TraceResponse,
  id: string,
  maxHops: number,
): void {
  if (
    !value ||
    value.runId !== id ||
    !['complete', 'timeout', 'cancelled', 'network', 'unsupported'].includes(
      value.reason,
    ) ||
    !Array.isArray(value.samples) ||
    value.samples.length > maxHops * TRACE_PROBES_PER_HOP
  ) {
    throw new Error('Invalid native traceroute response.');
  }
  const sequences = new Set<number>();
  for (const sample of value.samples) {
    if (
      !Number.isInteger(sample.hop) ||
      sample.hop < 1 ||
      sample.hop > maxHops ||
      !Number.isInteger(sample.sequence) ||
      sample.sequence < 0 ||
      sample.sequence >= maxHops * TRACE_PROBES_PER_HOP ||
      sequences.has(sample.sequence) ||
      !kinds.has(sample.kind) ||
      !ip(sample.remote) ||
      (sample.address !== null && !ip(sample.address)) ||
      (sample.rttMs !== null &&
        (!Number.isFinite(sample.rttMs) || sample.rttMs < 0)) ||
      !Number.isInteger(sample.probeBytes) ||
      sample.probeBytes < 0 ||
      sample.probeBytes > 32 ||
      !Number.isInteger(sample.overheadBytes) ||
      sample.overheadBytes < 0 ||
      sample.overheadBytes > 256
    ) {
      throw new Error('Invalid native traceroute sample.');
    }
    sequences.add(sample.sequence);
  }
}
export async function runTraceroute(
  attempt: Measurement,
  config: MeasurementConfig,
  signal: AbortSignal,
  adapter: TraceAdapter | undefined = Platform.OS === 'android'
    ? NativeModules.CapstoneTraceroute
    : undefined,
): Promise<Measurement> {
  const started = performance.now();
  const host = config.tracerouteHost!;
  const maxHops = config.tracerouteMaxHops ?? TRACE_MAX_HOPS;
  const raw: RawProbeOutput = {
    library: 'icmpenguin',
    version: TRACE_VERSION,
    source: 'android_native_bridge',
    request: {
      host,
      maxHops,
      probesPerHop: TRACE_PROBES_PER_HOP,
      protocol: 'udp',
      portStart: 33434,
      portStrategy: 'sequential',
      probeBytes: 32,
      timeoutPerProbeMs: 1000,
      deadlineMs: 45000,
    },
    callbacks: [],
    unavailable: [
      'packetCapture',
      'icmpTypeCodeForSpecializedErrorVariants',
      'kernelSendReceiveTimestamps',
    ],
  };
  let response: TraceResponse | undefined;
  let errorType: ProbeErrorType | null = null;
  let errorMessage: string | null = null;
  const cancel = () => adapter?.cancel(attempt.id);
  try {
    if (signal.aborted) {
      throw new Error('cancelled');
    }
    if (!adapter) {
      throw new Error('Traceroute is not available on this platform build.');
    }
    // Start synchronously before registering cancellation so the native run ID exists first.
    const pending = adapter.trace(
      attempt.id,
      host,
      maxHops,
      TRACE_PROBES_PER_HOP,
    );
    signal.addEventListener('abort', cancel);
    if (signal.aborted) {
      cancel();
    }
    response = await pending; // Native deadline includes DNS/probing; cleanup precedes resolution.
    // Preserve the bridge response even when validation rejects its normalized fields.
    raw.callbacks.push({
      observedAt: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      value: response,
    });
    validateTraceResponse(response, attempt.id, maxHops);
    if (response.reason !== 'complete') {
      errorType =
        response.reason === 'timeout' || response.reason === 'cancelled'
          ? response.reason
          : 'network';
      errorMessage = `Traceroute ended: ${response.reason}.`;
    }
  } catch (error) {
    errorType = signal.aborted ? 'cancelled' : 'invalid_response';
    errorMessage = error instanceof Error ? error.message : String(error);
    response = undefined;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  const samples = response?.samples ?? [];
  // Only a destination reply/port-unreachable proves arrival. Router errors do not.
  const terminal = samples.filter(
    sample =>
      sample.kind === 'reply' ||
      (sample.kind === 'port_unreachable' && sample.address === sample.remote),
  );
  const reachedHop = terminal.length
    ? Math.min(...terminal.map(sample => sample.hop))
    : null;
  const reached = reachedHop !== null;
  if (!errorType && !reached) {
    errorType = 'timeout';
    errorMessage =
      'Destination not reached within the hop limit. Partial hops are retained; missing replies can reflect filtering.';
  }
  return {
    ...attempt,
    timestamp: new Date(
      Date.now() - (performance.now() - started),
    ).toISOString(),
    durationMs: performance.now() - started,
    success: !errorType && reached,
    errorType,
    errorMessage,
    value: !errorType ? reachedHop : null,
    unit: 'hops',
    transferredBytes: null,
    method: 'udp_traceroute_icmpenguin',
    raw,
    targetHost: host,
    probeServer: host,
    route: {
      library: 'icmpenguin',
      version: TRACE_VERSION,
      protocol: 'udp',
      maxHops,
      probesPerHop: TRACE_PROBES_PER_HOP,
      probeBytes: 32,
      timeoutPerProbeMs: 1000,
      deadlineMs: 45000,
      reached,
      reachedHop,
      complete: response?.reason === 'complete',
      stopReason:
        response?.reason ?? (signal.aborted ? 'cancelled' : 'adapter_error'),
      samples: [...samples].sort(
        (a, b) => a.hop - b.hop || a.sequence - b.sequence,
      ),
    },
  };
}
