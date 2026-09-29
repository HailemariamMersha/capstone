import type { NetworkSnapshot } from '../network/types';

export type HttpProbeType = 'http_rtt' | 'download' | 'upload';
export type DiagnosticType =
  | 'icmp_burst'
  | 'tcp_connect'
  | 'udp_echo'
  | 'loaded_download'
  | 'loaded_upload'
  | 'traceroute';
export type ProbeType =
  | HttpProbeType
  | 'icmp_rtt'
  | DiagnosticType
  | 'ndt7_download'
  | 'ndt7_upload'
  | 'speedchecker_latency'
  | 'speedchecker_download'
  | 'speedchecker_upload';
export type ProbeErrorType =
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'http'
  | 'invalid_response'
  | 'invalid_config'
  | 'interrupted';
export interface ProbeConfig {
  serverUrl: string;
  timeoutMs: number;
  downloadBytes: number;
  uploadBytes: number;
}
export interface Measurement {
  id: string;
  sessionId: string;
  timestamp: string;
  type: ProbeType;
  durationMs: number;
  value: number | null;
  unit: 'ms' | 'Mbps' | 'hops';
  success: boolean;
  errorType: ProbeErrorType | null;
  errorMessage: string | null;
  httpStatus: number | null;
  requestedBytes: number;
  transferredBytes: number | null;
  probeServer: string;
  probeRegion: string | null;
  networkSnapshot: NetworkSnapshot | null;
  targetHost?: string;
  ttl?: number | null;
  method?: string;
  raw?: RawProbeOutput;
  packet?: PacketObservation;
  details?: DiagnosticDetails;
  route?: {
    library: 'icmpenguin' | 'capstone-linux-sockets';
    version: string;
    protocol: 'udp';
    maxHops: number;
    probesPerHop: number;
    probeBytes: number;
    timeoutPerProbeMs: number;
    deadlineMs: number;
    reached: boolean;
    reachedHop: number | null;
    complete: boolean;
    stopReason: string;
    samples: TraceSample[];
  };
  reference?: {
    library: '@m-lab/ndt7';
    version: string;
    source: 'client' | 'server' | null;
    stopReason: string;
    byteThreshold: number;
    clientBytes: number | null;
    serverBytes: number | null;
    elapsedSeconds: number | null;
    accounting: 'last_client_sample';
  };
  speedchecker?: {
    sdkVersion: string;
    stopReason: string;
    cleanupConfirmed: boolean;
    thresholdMb: number;
    downloadMb: number | null;
    uploadMb: number | null;
    downloadMbps: number | null;
    uploadMbps: number | null;
    pingMs: number | null;
    jitterMs: number | null;
  };
}

export interface TraceSample {
  packet?: PacketObservation;
  observedAtMs?: number;
  rawResult?: Record<string, unknown>;
  hop: number;
  sequence: number;
  remote: string;
  address: string | null;
  kind:
    | 'reply'
    | 'timeout'
    | 'port_unreachable'
    | 'host_unreachable'
    | 'network_unreachable'
    | 'time_exceeded'
    | 'icmp_error'
    | 'error';
  rttMs: number | null;
  probeBytes: number;
  overheadBytes: number;
  icmpType: number | null;
  icmpCode: number | null;
}

export interface ProbeSample {
  sequence: number;
  timestamp: string;
  rttMs: number | null;
  errorType: ProbeErrorType | null;
  ttl?: number | null;
  durationMs?: number;
  errorMessage?: string | null;
  raw?: RawProbeOutput;
  packet?: PacketObservation;
}

/** Library/application observations, not a PCAP or a claim of wire-level access. */
export interface RawProbeOutput {
  library: string;
  version: string;
  source: string;
  request: Record<string, unknown>;
  callbacks: { observedAt: string; elapsedMs: number; value: unknown }[];
  droppedCallbacks?: number;
  unavailable: string[];
}
export interface LatencySummary {
  replies: number;
  medianMs: number | null;
  p95Ms: number | null;
  /** Mean absolute difference of adjacent successful samples; never bridges a failure. */
  successiveDifferenceMs: number | null;
}
export interface DiagnosticDetails {
  protocolVersion: 1;
  samples: ProbeSample[];
  summary: LatencySummary;
  requestedCount?: number;
  complete?: boolean;
  nonResponsePercent?: number | null;
  sentCount?: number;
  duplicateCount?: number;
  reorderedCount?: number;
  lossPercent?: number | null;
  targetPort?: number;
  baselineSamples?: ProbeSample[];
  baselineSummary?: LatencySummary;
  load?: Measurement;
  loadedOverlapCount?: number;
}

/** Exact native socket observations; unknown fields remain preserved for future analysis. */
export interface PacketObservation extends Record<string, unknown> {
  runId: string;
  outcome: string;
  targetAddress?: string;
  resolvedAddress?: string;
  errorMessage?: string;
  connectDurationUs?: number;
  sentSocketBytes?: number;
  ipVersion?: number;
  tcpInfoAfter?: {
    tcpi_rtt?: number;
    tcpi_total_retrans?: number;
    [key: string]: unknown;
  };
  response?: {
    icmpSequence?: number;
    elapsedUs?: number;
    replyTtl?: number;
    responderAddress?: string;
    icmpType?: number;
    icmpCode?: number;
    extendedError?: { origin?: number; [key: string]: unknown };
    [key: string]: unknown;
  };
}
