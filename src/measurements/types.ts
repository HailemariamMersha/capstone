import type { NetworkSnapshot } from '../network/types';

export type ProbeType = 'http_rtt' | 'download' | 'upload' | 'icmp_rtt';
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
}
