import type { MeasurementStore, SyncRecord } from '../storage/types';
import {
  acquireActivity,
  currentActivity,
  isTripArmed,
} from '../services/activityGate';
import { fingerprint, uploadKey, syncVersion } from './transport';

export interface SyncRunOptions {
  deadline?: number;
  signal?: AbortSignal;
  onProgress?: (records: number, segments: number) => void;
}
export interface SyncResult {
  acknowledged: number;
  completed: number;
  pending: boolean;
  outcome: 'complete' | 'pending' | 'deferred' | 'cancelled' | 'failed';
  retryAt?: number;
  status?: number;
  error?: unknown;
}
export const emptySyncResult = (): SyncResult => ({
  acknowledged: 0,
  completed: 0,
  pending: false,
  outcome: 'complete',
});
export interface SyncDependencies {
  tripWindow?: boolean;
  sessionFilter?: (
    session: import('../sessions/types').SessionRecord,
  ) => boolean;
  beforeSessions?: (signal: AbortSignal) => Promise<void>;
  afterSessions?: (signal: AbortSignal) => Promise<void>;
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
  let running: Promise<SyncResult> | null = null;
  let cancellation: AbortController | null = null;
  async function run(options: SyncRunOptions = {}): Promise<SyncResult> {
    const result = emptySyncResult();
    if (currentActivity() || (isTripArmed() && !deps.tripWindow))
      return { ...result, pending: true, outcome: 'deferred' };
    const controller = new AbortController();
    const release = acquireActivity('sync', () => controller.abort());
    cancellation = controller;
    const signal = controller.signal;
    const cancel = () => controller.abort();
    if (options.signal?.aborted) cancel();
    options.signal?.addEventListener('abort', cancel);
    const deadline = options.deadline ?? deps.now() + 25000;
    const timeout = setTimeout(cancel, Math.max(0, deadline - deps.now()));
    const available = () => !signal.aborted && deps.now() < deadline;
    try {
      await deps.store.initialize(false);
      if (!available() || (await deps.store.hasActiveSession()))
        return { ...result, pending: true, outcome: 'deferred' };
      const identity = await deps.identity();
      if (!identity || !available()) return { ...result, outcome: 'deferred' };
      const { owner, mobileUploads } = identity;
      const sessions = (await deps.store.accountSessions(owner))
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
        .filter(
          s =>
            s.state !== 'active' &&
            s.uploadStatus !== 'Uploaded' &&
            s.uploadStatus !== 'Removed from study' &&
            (deps.sessionFilter?.(s) ?? true),
        );
      result.pending = sessions.length > 0;
      if (!available()) return result;
      const network = await deps.network();
      if (!network.connected || (!network.wifi && !mobileUploads)) {
        for (const s of sessions)
          await deps.store.setUploadStatus(
            owner,
            s.id,
            'Waiting for connection',
          );
        return { ...result, outcome: 'deferred' };
      }
      await deps.beforeSessions?.(signal);
      for (const s of sessions) {
        if (!available()) break;
        if (!(await deps.store.uploadReady(owner, s.id))) continue;
        let attempted: SyncRecord[] = [];
        let stage: 'manifest' | 'records' | 'complete' = 'manifest';
        const manifestKey = uploadKey('session-manifest', s.id);
        let cachedManifest = false;
        try {
          const records = await deps.store.sessionManifest(owner, s.id);
          if (!available()) break;
          const manifest = {
            session: publicSession({ ...s }),
            expected: records.map(({ type, id, version }) => ({
              type,
              id,
              version,
            })),
            collectorVersion:
              s.config.collectorVersion ?? 'skymeasure-libraries-1',
            schemaVersion: 3,
          };
          const hash = fingerprint(manifest);
          const receipt = (await deps.store.getUploadState?.(
            owner,
            manifestKey,
          )) as { hash: string } | null;
          if (receipt && receipt.hash !== hash)
            throw Object.assign(
              new Error(
                'Accepted recording manifest changed; review local evidence.',
              ),
              { code: 'MANIFEST_CONFLICT', status: 409 },
            );
          cachedManifest = receipt?.hash === hash;
          if (!cachedManifest) {
            await deps.request(
              `/sessions/${s.id}/manifest`,
              manifest,
              owner,
              'PUT',
              signal,
            );
            await deps.store.saveUploadState?.(owner, manifestKey, { hash });
          }
          if (!available()) break;
          await deps.store.setUploadStatus(owner, s.id, 'Uploading');
          // Until a server advertises v2 the old 50-record contract remains valid.
          const batchLimit = Math.min(
            await deps.store.uploadBatchLimit(owner, s.id),
            (await syncVersion(deps.store, owner)) >= 2 ? 200 : 50,
          );
          stage = 'records';
          while (available()) {
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
            if (!attempted.length || !available()) break;
            const response = await deps.request<{
              acknowledged: { type: string; id: string; version: number }[];
            }>(
              `/sessions/${s.id}/records`,
              { records: attempted },
              owner,
              'POST',
              signal,
            );
            const accepted = attempted.filter(r =>
              response.acknowledged?.some(
                a =>
                  a.id === r.id && a.type === r.type && a.version === r.version,
              ),
            );
            // Even a response arriving after cancellation must be durably applied
            // before releasing the activity lease to a new collector.
            if (accepted.length) {
              await deps.store.acknowledgeSync(accepted);
              result.acknowledged += accepted.length;
              options.onProgress?.(accepted.length, 0);
            }
            if (accepted.length !== attempted.length)
              throw new Error('Incomplete upload acknowledgement');
            attempted = [];
          }
          stage = 'complete';
          if (available()) {
            const receipt = await deps.request<{
              complete: boolean;
              missing?: { type: string; id: string; version: number }[];
            }>(`/sessions/${s.id}/complete`, {}, owner, 'POST', signal);
            if (!receipt.complete)
              await deps.store.requeueSync(
                records.filter(r =>
                  receipt.missing?.some(
                    m =>
                      m.id === r.id &&
                      m.type === r.type &&
                      m.version === r.version,
                  ),
                ),
              );
            else {
              await deps.store.deferUpload(owner, s.id, true);
              result.completed++;
              options.onProgress?.(0, 1);
            }
            await deps.store.setUploadStatus(
              owner,
              s.id,
              receipt.complete ? 'Uploaded' : 'Saved locally',
            );
          } else await deps.store.setUploadStatus(owner, s.id, 'Saved locally');
        } catch (error) {
          if (signal.aborted) {
            await deps.store.setUploadStatus(owner, s.id, 'Saved locally');
            break;
          }
          const failure = (error ?? {}) as {
            code?: string;
            status?: number;
            retryAt?: number;
          };
          if (failure.status === 410 && failure.code === 'DATA_REMOVED') {
            await deps.store.retireSessionData(owner, s.id);
            result.completed++;
            continue;
          }
          // A lost server-side registration invalidates the local hint, not the
          // saved evidence. Re-registration occurs once on the next opportunity.
          if (cachedManifest && failure.status === 404)
            await deps.store.clearUploadState?.(owner, manifestKey);
          const timeout = failure.code === 'REQUEST_TIMEOUT';
          if (
            stage === 'records' &&
            attempted.length &&
            (timeout || failure.status === 413)
          )
            await deps.store.reduceUploadBatchLimit(
              owner,
              s.id,
              attempted.length,
            );
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
            failure.status === 401 ||
              failure.status === 403 ||
              failure.code === 'MANIFEST_CONFLICT' ||
              String(error).includes('Action needed') ||
              String(error).includes('Sign in')
              ? 'Action needed'
              : 'Saved locally',
          );
          result.outcome = 'failed';
          result.error = error;
          result.status = failure.status;
          result.retryAt = failure.retryAt;
          break;
        }
      }
      result.pending = result.completed < sessions.length;
      if (available() && result.outcome !== 'failed')
        await deps.afterSessions?.(signal);
      if (signal.aborted) result.outcome = 'cancelled';
      else if (result.outcome !== 'failed')
        result.outcome = result.pending ? 'pending' : 'complete';
      return result;
    } catch (error) {
      if (!signal.aborted) throw error;
      return { ...result, outcome: 'cancelled', pending: true };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', cancel);
      cancellation = null;
      release();
    }
  }
  const trigger = (options?: SyncRunOptions) => {
    if (!running)
      running = run(options).finally(() => {
        running = null;
      });
    return running;
  };
  trigger.cancel = () => cancellation?.abort();
  return trigger;
}
