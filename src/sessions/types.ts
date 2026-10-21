import type { ProbeConfig } from '../measurements/types';

export interface MeasurementConfig extends ProbeConfig {
  notes?: string;
  collectorVersion?: string;
  probeRegion?: string;
  /** Absent on historical sessions: retain their HTTP schedule. New UI defaults to false. */
  httpEnabled?: boolean;
  mode?: 'ndt7_reference' | 'speedchecker_reference';
  referenceByteThreshold?: number;
  maxDurationMs?: number;
  maxPayloadBytes?: number;
  minimumBatteryPercent?: number;
  icmpHost?: string;
  icmpBurstEnabled?: boolean;
  tcpEnabled?: boolean;
  /** Separate TCP endpoint; historical sessions fall back to serverUrl. */
  tcpServerUrl?: string;
  udpHost?: string;
  udpPort?: number;
  loadedLatencyEnabled?: boolean;
  diagnosticsIntervalMs?: number;
  tracerouteHost?: string;
  tracerouteMaxHops?: number;
  rttIntervalMs: number;
  downloadIntervalMs: number;
  uploadIntervalMs: number;
}
export type ServiceStatus = {
  state: 'stopped' | 'starting' | 'running' | 'stopping';
  sessionId: string | null;
  startedAt: number | null;
  elapsedMs: number;
  heartbeatCount: number;
  lastHeartbeatAt: number | null;
  measurementCount: number;
  error: string | null;
};
export interface BackgroundExecutor {
  start(
    onHeartbeat: () => void,
    onError: (error: Error) => void,
  ): Promise<void>;
  stop(): Promise<void>;
}
export interface SessionRecord {
  ownerId?: string | null;
  uploadStatus?: string;
  id: string;
  startedAt: string;
  endedAt: string | null;
  lastObservedAt: string;
  state: 'active' | 'completed' | 'interrupted';
  config: MeasurementConfig;
  resumedFromId: string | null;
  measurementCount: number;
}
