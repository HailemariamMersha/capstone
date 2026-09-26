import type { NetworkSnapshot } from '../network/types';

export type HttpProbeType = 'http_rtt' | 'download' | 'upload';
export type DiagnosticType =
  | 'icmp_burst'
  | 'tcp_connect'
  | 'udp_echo'
  | 'loaded_download'
  | 'loaded_upload';
export type ProbeType = HttpProbeType | 'icmp_rtt' | DiagnosticType;
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
  unit: 'ms' | 'Mbps';
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
  details?: DiagnosticDetails;
}

export interface ProbeSample {
  sequence: number;
  timestamp: string;
  rttMs: number | null;
  errorType: ProbeErrorType | null;
  ttl?: number | null;
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
