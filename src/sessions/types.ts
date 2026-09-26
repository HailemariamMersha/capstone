import type { ProbeConfig } from '../measurements/types';

export interface MeasurementConfig extends ProbeConfig {
  maxDurationMs?: number;
  maxPayloadBytes?: number;
  minimumBatteryPercent?: number;
  icmpHost?: string;
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
  id: string;
  startedAt: string;
  endedAt: string | null;
  lastObservedAt: string;
  state: 'active' | 'completed' | 'interrupted';
  config: MeasurementConfig;
  resumedFromId: string | null;
  measurementCount: number;
}
