import { localSession, secureStorage, type Profile } from '../auth/client';
import { measurementStore as store } from '../storage/database';
import {
  createAccountSync,
  type SyncResult,
  type SyncRunOptions,
} from '../sync/accountSync';
import { createUploadRequest } from '../sync/request';
import { fingerprint, uploadKey, syncVersion } from '../sync/transport';
import type { Trip } from './model';
export function tripManifest(t: Trip) {
  return {
    revision: t.revision,
    state: t.state,
    phase: t.phase,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    firstQualifiedAt: t.firstQualifiedAt,
    segmentCount: t.segmentCount,
    flight: t.flight,
    used: t.used,
    confidence: t.evidence?.confidence ?? 'unconfirmed',
    provider: t.evidence?.provider ?? null,
    reason: t.reason,
    policyVersion: t.policy.version,
    shadow: t.shadow,
    ...(t.transferSchedule ? { transferSchedule: t.transferSchedule } : {}),
    ...(t.measurementSuiteVersion
      ? { measurementSuiteVersion: t.measurementSuiteVersion }
      : {}),
    ...(t.groundTest != null ? { groundTest: t.groundTest } : {}),
    ...(t.mlabUsage ? { mlabUsage: t.mlabUsage } : {}),
    ...(t.detectorPolicy
      ? { detectorPolicyVersion: t.detectorPolicy.version }
      : {}),
  };
}

let cancelCurrent: (() => void) | null = null;
export const cancelTripUpload = () => cancelCurrent?.();
/** Runs only inside a foreground upload window or after collection. */
export async function uploadTrip(
  t: Trip,
  live: boolean,
  wifi: boolean,
  persist: () => Promise<void>,
  observe?: (details: Record<string, unknown>) => Promise<void>,
  options: SyncRunOptions = {},
): Promise<SyncResult | undefined> {
  const session = await localSession();
  if (session?.user.id !== t.ownerId) return;
  const profileRaw = await secureStorage.getItem(`profile.${t.ownerId}`);
  if (!profileRaw) return;
  const profile: Profile = JSON.parse(profileRaw);
  if (!wifi && !profile.mobileUploads) return;
  // A reservation surviving a previous run/process has an unknown wire outcome.
  const orphaned = Object.values(t.uploadReservations ?? {}).reduce(
    (a, b) => a + b,
    0,
  );
  if (orphaned) {
    t.used.uploads += orphaned;
    t.uploadReservations = {};
    await persist();
  }
  const request = createUploadRequest(store, {
    trip: t,
    live,
    persist,
    observe,
  });
  const key = uploadKey('trip-manifest', t.id);
  const upload = createAccountSync({
    store,
    tripWindow: live,
    now: Date.now,
    identity: async () => ({
      owner: t.ownerId,
      mobileUploads: profile.mobileUploads,
    }),
    network: async () => ({ connected: true, wifi }),
    request,
    sessionFilter: s => s.config.tripId === t.id,
    beforeSessions: async signal => {
      // Copy before accounting/persistence advances the in-memory revision.
      const body = JSON.parse(JSON.stringify(tripManifest(t)));
      const hash = fingerprint(body);
      const accepted = (await store.getUploadState?.(t.ownerId, key)) as {
        hash: string;
        revision: number;
      } | null;
      if (accepted?.hash !== hash) {
        const compact = (await syncVersion(store, t.ownerId)) >= 2;
        const receipt = await request<{
          uploadComplete: boolean;
          acceptedRevision?: number;
          revision?: number;
        }>(
          `/trips/${t.id}${compact ? '?view=receipt' : ''}`,
          body,
          t.ownerId,
          'PUT',
          signal,
        );
        await store.saveUploadState?.(t.ownerId, key, {
          hash,
          revision: body.revision,
        });
        if (
          !live &&
          receipt.uploadComplete &&
          (receipt.acceptedRevision ?? receipt.revision ?? body.revision) ===
            t.revision
        ) {
          t.uploadedRevision = body.revision;
          await store.saveTrip(t);
        }
      }
      const payment = await store.tripPayment(t.ownerId, t.id);
      if (payment && !payment.uploaded) {
        await request(
          `/trips/${t.id}/payment`,
          { netId: payment.netId },
          t.ownerId,
          'PUT',
          signal,
        );
        await store.acknowledgeTripPayment(t.ownerId, t.id);
      }
    },
    afterSessions: async signal => {
      if (live || t.uploadedRevision === t.revision) return;
      if ((await syncVersion(store, t.ownerId)) >= 2) {
        const receipt = await request<{
          acceptedRevision: number;
          uploadComplete: boolean;
        }>(`/trips/${t.id}/receipt`, undefined, t.ownerId, 'GET', signal);
        if (receipt.uploadComplete && receipt.acceptedRevision === t.revision) {
          t.uploadedRevision = receipt.acceptedRevision;
          await store.saveTrip(t);
          options.onProgress?.(0, 1);
        }
      } else {
        // A legacy server has no compact receipt. Its idempotent PUT remains safe.
        const body = tripManifest(t);
        const receipt = await request<{ uploadComplete: boolean }>(
          `/trips/${t.id}`,
          body,
          t.ownerId,
          'PUT',
          signal,
        );
        if (receipt.uploadComplete) {
          t.uploadedRevision = body.revision;
          await store.saveTrip(t);
        }
      }
    },
  });
  cancelCurrent = upload.cancel;
  try {
    return await upload(options);
  } catch (error) {
    if ((error as { status?: number })?.status === 404)
      await store.clearUploadState?.(t.ownerId, key);
    if ((error as { code?: string })?.code !== 'DATA_REMOVED') throw error;
    t.removedFromStudy = true;
    if (t.state === 'active') {
      t.state = 'interrupted';
      t.phase = 'finished';
      t.endedAt = Date.now();
      t.reason = 'study_history_reset';
      await store.saveTrip(t);
    }
    await store.clearUploadState?.(t.ownerId, key);
    await store.retireTripData(t.ownerId, t.id);
  } finally {
    cancelCurrent = null;
  }
}
