import type { MeasurementStore, SyncRecord } from '../storage/types';
import { acquireActivity, currentActivity } from '../services/activityGate';

export interface SyncDependencies {
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
    if (currentActivity()) return;
    const release = acquireActivity('sync');
    cancellation = new AbortController();
    const signal = cancellation.signal;
    const timeout = setTimeout(() => cancellation?.abort(), 25000);
    try {
      // Headless startup must not recover/close an active collection.
      await deps.store.initialize(false);
      if (await deps.store.hasActiveSession()) return;
      const identity = await deps.identity();
      if (!identity) return;
      const { owner, mobileUploads } = identity;
      const sessions = (await deps.store.accountSessions(owner)).filter(
        s => s.state !== 'active' && s.uploadStatus !== 'Uploaded',
      );
      const network = await deps.network();
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
      for (const s of sessions) {
        if (deps.now() >= deadline || signal.aborted) break;
        if (!(await deps.store.uploadReady(owner, s.id))) continue;
        let attempted: SyncRecord[] = [];
        try {
          const records = await deps.store.sessionManifest(owner, s.id);
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
          await deps.store.setUploadStatus(owner, s.id, 'Uploading');
          while (deps.now() < deadline && !signal.aborted) {
            const batch = await deps.store.getSyncBatch(50, owner, s.id);
            attempted = batch.records.map(r =>
              r.type === 'session'
                ? { ...r, payload: publicSession(r.payload) }
                : r,
            );
            if (!attempted.length) break;
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
          }
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
          await deps.store.failSync(
            attempted,
            'Upload incomplete; retry pending',
          );
          await deps.store.deferUpload(owner, s.id);
          await deps.store.setUploadStatus(
            owner,
            s.id,
            String(error).includes('Action needed') ||
              String(error).includes('Sign in')
              ? 'Action needed'
              : 'Saved locally',
          );
          break;
        }
      }
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
