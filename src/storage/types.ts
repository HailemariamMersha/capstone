import type { NetworkSnapshot } from '../network/types';
import type { Measurement, ProbeType } from '../measurements/types';
import type { MeasurementConfig, SessionRecord } from '../sessions/types';
export type SqlValue = string | number | null;
export interface SqlDatabase {
  execute(
    sql: string,
    params?: SqlValue[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface StoredMeasurement {
  measurement: Measurement;
  scheduledAt: string;
  state: 'pending' | 'complete';
}
export interface SessionEvent {
  id: string;
  timestamp: string;
  kind: string;
  details: Record<string, unknown>;
}
export interface MeasurementStore {
  saveSnapshot(
    sessionId: string,
    snapshot: NetworkSnapshot,
  ): Promise<NetworkSnapshot>;
  exportSession(sessionId: string): Promise<Record<string, unknown>>;
  getSyncBatch(limit?: number): Promise<SyncBatch>;
  acknowledgeSync(records: SyncRecord[]): Promise<void>;
  failSync(records: SyncRecord[], error: string): Promise<void>;
  initialize(): Promise<void>;
  createSession(
    config: MeasurementConfig,
    resumedFromId?: string,
  ): Promise<string>;
  endSession(
    id: string,
    state: 'completed' | 'interrupted',
    reason: string,
  ): Promise<void>;
  touchSession(id: string): Promise<void>;
  beginAttempt(
    sessionId: string,
    type: ProbeType,
    scheduledAt: string,
  ): Promise<Measurement>;
  finishAttempt(measurement: Measurement): Promise<void>;
  addEvent(
    sessionId: string,
    kind: string,
    details: Record<string, unknown>,
  ): Promise<void>;
  listSessions(limit?: number, offset?: number): Promise<SessionRecord[]>;
  getSession(id: string): Promise<SessionRecord | null>;
  listMeasurements(
    sessionId: string,
    limit?: number,
    offset?: number,
  ): Promise<StoredMeasurement[]>;
  listEvents(sessionId: string): Promise<SessionEvent[]>;
  pendingCount(): Promise<number>;
}

export interface SyncRecord {
  type: string;
  id: string;
  version: number;
  payload: Record<string, unknown>;
}
export interface SyncBatch {
  installationId: string;
  records: SyncRecord[];
}
