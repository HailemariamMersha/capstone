import type { MeasurementStore, SyncRecord } from '../storage/types';
import {
  acquireActivity,
  currentActivity,
  isTripArmed,
} from '../services/activityGate';

export interface SyncDependencies {
  tripWindow?: boolean;
  sessionFilter?: (
    session: import('../sessions/types').SessionRecord,
  ) => boolean;
  beforeSessions?: (signal: AbortSignal) => Promise<void>;
  store: MeasurementStore;
  identity(): Promise<{ owner: string; mobileUploads: boolean } | null>;
  network(): Promise<{ connected: boolean; wifi: boolean }>;
  request<T>(
    path: string,
    body: unknown,
    owner: string,
    method?: string,
    signal?: AbortSignal,
  ): Promise<T>;
  now(): number;
}
const publicSession = (session: Record<string, unknown>) => {
  const result = { ...session };
  delete result.ownerId;
  delete result.uploadStatus;
  return result;
};
export function createAccountSync(deps: SyncDependencies) {
  let running: Promise<void> | null = null;
  let cancellation: AbortController | null = null;
  async function run() {
    if (currentActivity() || (isTripArmed() && !deps.tripWindow)) return;
    const controller = new AbortController();
    const release = acquireActivity('sync', () => controller.abort());
    cancellation = controller;
    const signal = controller.signal;
    const timeout = setTimeout(() => cancellation?.abort(), 25000);
    try {
      // Headless startup must not recover/close an active collection.
      await deps.store.initialize(false);
      if (signal.aborted || (await deps.store.hasActiveSession())) return;
      const identity = await deps.identity();
      if (!identity || signal.aborted) return;
      const { owner, mobileUploads } = identity;
      const sessions = (await deps.store.accountSessions(owner))
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
        .filter(
          s =>
            s.state !== 'active' &&
            s.uploadStatus !== 'Uploaded' &&
            (deps.sessionFilter?.(s) ?? true),
        );
      if (signal.aborted) return;
      const network = await deps.network();
      if (signal.aborted) return;
      if (!network.connected || (!network.wifi && !mobileUploads)) {
        for (const s of sessions)
          await deps.store.setUploadStatus(
            owner,
            s.id,
            'Waiting for connection',
          );
        return;
      }
      const deadline = deps.now() + 20000;
      await deps.beforeSessions?.(signal);
      for (const s of sessions) {
        if (deps.now() >= deadline || signal.aborted) break;
        if (!(await deps.store.uploadReady(owner, s.id))) continue;
        let attempted: SyncRecord[] = [];
        let stage: 'manifest' | 'records' | 'complete' = 'manifest';
        try {
          const records = await deps.store.sessionManifest(owner, s.id);
          if (signal.aborted) break;
          const expected = records.map(({ type, id, version }) => ({
            type,
            id,
            version,
          }));
          const session = publicSession({ ...s });
          await deps.request(
            `/sessions/${s.id}/manifest`,
            {
              session,
              expected,
              collectorVersion:
                s.config.collectorVersion ?? 'skymeasure-libraries-1',
              schemaVersion: 3,
            },
            owner,
            'PUT',
            signal,
          );
          if (signal.aborted) break;
          await deps.store.setUploadStatus(owner, s.id, 'Uploading');
          const batchLimit = await deps.store.uploadBatchLimit(owner, s.id);
          stage = 'records';
          while (deps.now() < deadline && !signal.aborted) {
            const batch = await deps.store.getSyncBatch(
              batchLimit,
              owner,
              s.id,
            );
            attempted = batch.records.map(r =>
              r.type === 'session'
                ? { ...r, payload: publicSession(r.payload) }
                : r,
            );
            if (!attempted.length || signal.aborted) break;
            const result = await deps.request<{
              acknowledged: { type: string; id: string; version: number }[];
            }>(
              `/sessions/${s.id}/records`,
              { records: attempted },
              owner,
              'POST',
              signal,
            );
            const accepted = attempted.filter(r =>
              result.acknowledged.some(
                a =>
                  a.id === r.id && a.type === r.type && a.version === r.version,
              ),
            );
            if (accepted.length !== attempted.length)
              throw new Error('Incomplete upload acknowledgement');
            await deps.store.acknowledgeSync(accepted);
            attempted = [];
          }
          stage = 'complete';
          if (deps.now() < deadline && !signal.aborted) {
            const result = await deps.request<{
              complete: boolean;
              missing?: { type: string; id: string; version: number }[];
            }>(`/sessions/${s.id}/complete`, {}, owner, 'POST', signal);
            if (!result.complete)
              await deps.store.requeueSync(
                records.filter(r =>
                  result.missing?.some(
                    m =>
                      m.id === r.id &&
                      m.type === r.type &&
                      m.version === r.version,
                  ),
                ),
              );
            else await deps.store.deferUpload(owner, s.id, true);
            await deps.store.setUploadStatus(
              owner,
              s.id,
              result.complete ? 'Uploaded' : 'Saved locally',
            );
          } else await deps.store.setUploadStatus(owner, s.id, 'Saved locally');
        } catch (error) {
          if (signal.aborted) {
            await deps.store.setUploadStatus(owner, s.id, 'Saved locally');
            break;
          }
          const failure = (error ?? {}) as { code?: string; status?: number };
          const timeout = failure.code === 'REQUEST_TIMEOUT';
          if (
            stage === 'records' &&
            attempted.length &&
            (timeout || failure.status === 413)
          )
            await deps.store.reduceUploadBatchLimit(owner, s.id);
          await deps.store.failSync(
            attempted,
            timeout
              ? `Upload ${stage} timed out; retry pending`
              : `Upload ${stage} incomplete; retry pending`,
          );
          await deps.store.deferUpload(owner, s.id, false, {
            stage,
            code: timeout ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED',
            status: failure.status ?? null,
          });
          await deps.store.setUploadStatus(
            owner,
            s.id,
            (error as { status?: number } | null)?.status === 401 ||
              (error as { status?: number } | null)?.status === 403 ||
              String(error).includes('Action needed') ||
              String(error).includes('Sign in')
              ? 'Action needed'
              : 'Saved locally',
          );
          break;
        }
      }
    } catch (error) {
      // Cancellation hands control back to Start; it is not an upload failure.
      if (!signal.aborted) throw error;
    } finally {
      clearTimeout(timeout);
      cancellation = null;
      release();
    }
  }
  const trigger = () => {
    if (!running)
      running = run().finally(() => {
        running = null;
      });
    return running;
  };
  trigger.cancel = () => cancellation?.abort();
  return trigger;
}
