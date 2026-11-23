import { AppState } from 'react-native';
import { createRetryScheduler } from './retryScheduler';
import BackgroundFetch from 'react-native-background-fetch';
import NetInfo from '@react-native-community/netinfo';
import { localSession, secureStorage, type Profile } from '../auth/client';
import { measurementStore } from '../storage/database';
import BackgroundService from 'react-native-background-actions';
import { recoverTrips } from '../trips/runtime';
import { isTripArmed, currentActivity } from '../services/activityGate';
import { uploadTrip, cancelTripUpload } from '../trips/sync';
import {
  createAccountSync,
  emptySyncResult,
  type SyncResult,
} from './accountSync';
import { createUploadRequest } from './request';
import { uploadKey } from './transport';
import { foregroundService } from '../background/serviceCoordinator';

export type UploadMode = 'foreground' | 'background' | 'service';
export interface AccountUploadOptions {
  mode?: UploadMode;
  budgetMs?: number;
  signal?: AbortSignal;
  onProgress?: (records: number, segments: number) => void;
}
const syncLegacy = createAccountSync({
  sessionFilter: s => !s.config.tripId,
  store: measurementStore,
  now: Date.now,
  async identity() {
    const session = await localSession();
    if (!session) return null;
    const raw = await secureStorage.getItem(`profile.${session.user.id}`);
    if (!raw) return null;
    const profile: Profile = JSON.parse(raw);
    if (!profile.consentVersion) return null;
    return { owner: session.user.id, mobileUploads: profile.mobileUploads };
  },
  async network() {
    const n = await NetInfo.fetch();
    return {
      connected: n.isConnected === true && n.isInternetReachable !== false,
      wifi: n.type === 'wifi',
    };
  },
  request: createUploadRequest(measurementStore),
});
let syncing: Promise<SyncResult> | null = null;
let activeController: AbortController | null = null;
let activeMode: UploadMode | null = null;
const cancel = () => {
  activeController?.abort();
  syncLegacy.cancel();
  cancelTripUpload();
};
export const syncAccount = Object.assign(
  (options: AccountUploadOptions = {}): Promise<SyncResult> => {
    if (syncing) return syncing;
    const mode = options.mode ?? 'foreground';
    const budget = Math.min(
      options.budgetMs ?? (mode === 'background' ? 25000 : 180000),
      mode === 'background' ? 25000 : 180000,
    );
    const deadline = Date.now() + Math.max(0, budget);
    const controller = new AbortController();
    activeController = controller;
    activeMode = mode;
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener('abort', abort);
    const timeout = setTimeout(abort, Math.max(0, budget));
    syncing = (async () => {
      const result = emptySyncResult();
      if (isTripArmed() || currentActivity())
        return { ...result, pending: true, outcome: 'deferred' as const };
      const session = await localSession();
      const network = await NetInfo.fetch();
      if (!session) return { ...result, outcome: 'deferred' as const };
      const owner = session.user.id;
      const trips = (await measurementStore.accountTrips(owner))
        .filter(
          t =>
            !t.removedFromStudy &&
            t.state !== 'active' &&
            t.uploadedRevision !== t.revision,
        )
        .sort((a, b) => a.startedAt - b.startedAt);
      const legacyPending = (
        await measurementStore.accountSessions(owner)
      ).some(
        s =>
          !s.config.tripId &&
          s.state !== 'active' &&
          s.uploadStatus !== 'Uploaded' &&
          s.uploadStatus !== 'Removed from study',
      );
      result.pending = trips.length > 0 || legacyPending;
      if (!network.isConnected || network.isInternetReachable === false)
        return { ...result, outcome: 'deferred' as const };
      const limitedUntil = Number(
        (await measurementStore.getUploadState?.(
          owner,
          uploadKey('retry-at'),
        )) ?? 0,
      );
      if (limitedUntil > Date.now())
        return {
          ...result,
          retryAt: limitedUntil,
          outcome: 'deferred' as const,
        };
      const runOptions = {
        deadline,
        signal: controller.signal,
        onProgress: options.onProgress,
      };
      const tasks: { id: string; run(): Promise<SyncResult | undefined> }[] = [
        ...(legacyPending
          ? [{ id: 'legacy', run: () => syncLegacy(runOptions) }]
          : []),
        ...trips.map(trip => ({
          id: trip.id,
          run: () =>
            uploadTrip(
              trip,
              false,
              network.type === 'wifi',
              async () => {
                trip.revision++;
                await measurementStore.saveTrip(trip);
              },
              undefined,
              runOptions,
            ),
        })),
      ];
      const cursorKey = `upload-opportunity-cursor.${owner}`;
      const cursor = await secureStorage.getItem(cursorKey);
      const previous = tasks.findIndex(t => t.id === cursor);
      const start = previous < 0 ? 0 : (previous + 1) % tasks.length;
      const ordered = [...tasks.slice(start), ...tasks.slice(0, start)];
      for (const task of ordered) {
        if (
          controller.signal.aborted ||
          isTripArmed() ||
          currentActivity() ||
          Date.now() >= deadline
        )
          break;
        await secureStorage.setItem(cursorKey, task.id);
        if (controller.signal.aborted || isTripArmed() || currentActivity())
          break;
        try {
          const done = await task.run();
          if (done) {
            result.acknowledged += done.acknowledged;
            result.completed += done.completed;
            if (done.outcome === 'failed') {
              Object.assign(result, {
                outcome: 'failed',
                status: done.status,
                retryAt: done.retryAt,
                error: done.error,
              });
              if (
                done.status === 429 ||
                done.status === 401 ||
                done.status === 403 ||
                done.retryAt
              )
                break;
            }
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          const failure = error as { status?: number; retryAt?: number };
          Object.assign(result, {
            outcome: 'failed',
            status: failure.status,
            retryAt: failure.retryAt,
            error,
          });
          if (
            failure.status === 429 ||
            failure.status === 401 ||
            failure.status === 403 ||
            failure.retryAt
          )
            break;
        }
      }
      // Local queue/status checks do not require another network round trip.
      const remaining = await measurementStore.accountTrips(owner);
      const sessions = await measurementStore.accountSessions(owner);
      result.pending =
        remaining.some(
          t =>
            !t.removedFromStudy &&
            t.state !== 'active' &&
            t.uploadedRevision !== t.revision,
        ) ||
        sessions.some(
          s =>
            !s.config.tripId &&
            s.state !== 'active' &&
            !['Uploaded', 'Removed from study'].includes(s.uploadStatus ?? ''),
        );
      if (controller.signal.aborted) result.outcome = 'cancelled';
      else if (result.outcome !== 'failed')
        result.outcome = result.pending ? 'pending' : 'complete';
      return result;
    })().finally(() => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      activeController = null;
      activeMode = null;
      syncing = null;
    });
    return syncing;
  },
  {
    cancel,
    cancelBackground: () => {
      if (activeMode === 'background') cancel();
    },
    cancelForeground: () => {
      if (activeMode === 'foreground') cancel();
    },
  },
);

export async function backgroundUpload(taskId: string) {
  try {
    // This job neither joins an extended drain nor cancels it on OS expiration.
    if (foregroundService.uploading()) return;
    if (
      !currentActivity() &&
      !isTripArmed() &&
      !BackgroundService.isRunning()
    ) {
      const session = await localSession();
      if (session) await recoverTrips(session.user.id);
    }
    await syncAccount({ mode: 'background' });
  } finally {
    await BackgroundFetch.finish(taskId);
  }
}
export async function configureUploads() {
  await BackgroundFetch.configure(
    {
      minimumFetchInterval: 15,
      stopOnTerminate: false,
      startOnBoot: true,
      enableHeadless: true,
      requiredNetworkType: BackgroundFetch.NETWORK_TYPE_ANY,
    },
    backgroundUpload,
    taskId => {
      syncAccount.cancelBackground();
      BackgroundFetch.finish(taskId);
    },
  );
}
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish);
  });
async function retryTime(owner: string) {
  const raw = await secureStorage.getItem(`automatic-upload-retry.${owner}`);
  const queue = await measurementStore.nextUploadAttempt(owner);
  const limit = Number(
    (await measurementStore.getUploadState?.(owner, uploadKey('retry-at'))) ??
      0,
  );
  return Math.max(queue ?? 0, raw ? JSON.parse(raw).nextAt : 0, limit);
}
async function recordRetry(owner: string, result: SyncResult) {
  const key = `automatic-upload-retry.${owner}`;
  if (result.outcome === 'cancelled') return;
  if (result.outcome !== 'failed') {
    await secureStorage.setItem(
      key,
      JSON.stringify({ attempts: 0, nextAt: 0 }),
    );
    return;
  }
  const raw = await secureStorage.getItem(key);
  const attempts = (raw ? JSON.parse(raw).attempts : 0) + 1;
  await secureStorage.setItem(
    key,
    JSON.stringify({
      attempts,
      nextAt: Math.max(
        result.retryAt ?? 0,
        Date.now() + Math.min(3600000, 15000 * 2 ** Math.min(attempts - 1, 8)),
      ),
    }),
  );
}

/** The service's Headless JS task stays alive while this serialized drain runs. */
export async function drainPostTrip(
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  const removeNetwork = NetInfo.addEventListener(network => {
    const request = activeMode === 'service' ? activeController : null;
    if (!request) return;
    if (!network.isConnected || network.isInternetReachable === false) {
      request.abort();
    } else if (network.type !== 'wifi') {
      localSession()
        .then(async identity => {
          const raw = identity
            ? await secureStorage.getItem(`profile.${identity.user.id}`)
            : null;
          if (!raw || !JSON.parse(raw).mobileUploads) request.abort();
        })
        .catch(() => request.abort());
    }
  });
  try {
    let lastProgress = Date.now();
    const stalledMs = 10 * 60000;
    let sent = 0;
    while (
      !signal.aborted &&
      !isTripArmed() &&
      Date.now() - lastProgress < stalledMs
    ) {
      const identity = await localSession();
      if (!identity) return;
      const raw = await secureStorage.getItem(`profile.${identity.user.id}`);
      const profile: Profile | null = raw ? JSON.parse(raw) : null;
      if (!profile?.consentVersion) return;
      const next = await retryTime(identity.user.id);
      const network = await NetInfo.fetch();
      if (
        !network.isConnected ||
        network.isInternetReachable === false ||
        (network.type !== 'wifi' && !profile.mobileUploads) ||
        next > Date.now()
      ) {
        progress(
          network.type !== 'wifi' && !profile.mobileUploads
            ? 'Saved on this phone. Waiting for Wi-Fi.'
            : 'Saved on this phone. Waiting to retry.',
        );
        await wait(
          Math.min(10000, Math.max(1, stalledMs - (Date.now() - lastProgress))),
          signal,
        );
        continue;
      }
      let result: SyncResult;
      let progressObserved = false;
      try {
        result = await syncAccount({
          mode: 'service',
          budgetMs: Math.min(
            180000,
            Math.max(0, stalledMs - (Date.now() - lastProgress)),
          ),
          signal,
          onProgress: (records, segments) => {
            if (records || segments) {
              progressObserved = true;
              lastProgress = Date.now();
              sent += records;
              progress(`Sending saved results. ${sent} records acknowledged.`);
            }
          },
        });
      } catch (error) {
        result = {
          ...emptySyncResult(),
          pending: true,
          outcome: 'failed',
          error,
        };
      }
      // A service can join a visible pass already in progress. Its callback
      // belongs to that caller; returned new ACKs still establish progress.
      if (!progressObserved && (result.acknowledged || result.completed)) {
        lastProgress = Date.now();
        sent += result.acknowledged;
        progress(`Sending saved results. ${sent} records acknowledged.`);
      }
      await recordRetry(identity.user.id, result);
      if (
        !result.pending ||
        result.status === 401 ||
        result.status === 403 ||
        result.status === 409
      )
        return;
      await wait(
        Math.min(
          result.acknowledged || result.completed ? 1000 : 15000,
          Math.max(0, stalledMs - (Date.now() - lastProgress)),
        ),
        signal,
      );
    }
    if (
      !signal.aborted &&
      !isTripArmed() &&
      Date.now() - lastProgress >= stalledMs
    ) {
      const identity = await localSession();
      if (identity) {
        const key = `automatic-upload-retry.${identity.user.id}`;
        const raw = await secureStorage.getItem(key);
        const previous = raw ? JSON.parse(raw) : { attempts: 0, nextAt: 0 };
        // Ending the service must not let the visible-app scheduler immediately
        // create another ten-minute stalled service. Keep the queue for later.
        await secureStorage.setItem(
          key,
          JSON.stringify({
            ...previous,
            nextAt: Math.max(previous.nextAt ?? 0, Date.now() + 15 * 60000),
          }),
        );
      }
    }
  } finally {
    removeNetwork();
  }
}

// Process-owned registration outlives the activity. Screen teardown must not
// prevent a running collector's automatic ending from handing off its service.
foregroundService.registerDrain(drainPostTrip);

/** Visible wake-ups plus an explicit service handoff at trip completion. */
export function startAutomaticUploads() {
  let cooldown = 0;
  const scheduler = createRetryScheduler({
    now: Date.now,
    async nextAttempt() {
      const session = await localSession();
      if (!session) return null;
      const resetAt = await measurementStore.historyResetAt?.();
      if (resetAt) {
        const seen = await secureStorage.getItem(
          `history-reset-seen.${session.user.id}`,
        );
        if (Number(seen ?? 0) < resetAt) {
          await secureStorage.removeItem(
            `automatic-upload-retry.${session.user.id}`,
          );
          await secureStorage.removeItem(
            `upload-opportunity-cursor.${session.user.id}`,
          );
          await secureStorage.setItem(
            `history-reset-seen.${session.user.id}`,
            String(resetAt),
          );
        }
      }
      if (isTripArmed() || currentActivity() || foregroundService.uploading())
        return Date.now() + 30000;
      const n = await NetInfo.fetch();
      if (!n.isConnected || n.isInternetReachable === false) return null;
      const raw = await secureStorage.getItem(`profile.${session.user.id}`);
      const profile: Profile | null = raw ? JSON.parse(raw) : null;
      if (
        !profile?.consentVersion ||
        (n.type !== 'wifi' && !profile.mobileUploads)
      )
        return null;
      const next = await measurementStore.nextUploadAttempt(session.user.id);
      const trips = await measurementStore.accountTrips(session.user.id);
      if (
        next == null &&
        !trips.some(
          t =>
            !t.removedFromStudy &&
            t.state !== 'active' &&
            t.uploadedRevision !== t.revision,
        )
      )
        return null;
      return Math.max(next ?? 0, cooldown, await retryTime(session.user.id));
    },
    async run() {
      const session = await localSession();
      if (
        !session ||
        isTripArmed() ||
        currentActivity() ||
        foregroundService.uploading()
      )
        return;
      // Starting a service here is permitted only while the activity is visible.
      if (
        AppState.currentState === 'active' &&
        (await foregroundService.startUploads())
      )
        return;
      try {
        const result = await syncAccount({ mode: 'foreground' });
        await recordRetry(session.user.id, result);
        cooldown =
          Date.now() +
          (result.pending && (result.acknowledged || result.completed)
            ? 1000
            : 30000);
      } catch {
        await recordRetry(session.user.id, {
          ...emptySyncResult(),
          outcome: 'failed',
          pending: true,
        });
        cooldown = Date.now() + 30000;
      }
    },
  });
  scheduler.setActive(AppState.currentState === 'active');
  const app = AppState.addEventListener('change', state => {
    scheduler.setActive(state === 'active');
    if (state !== 'active') syncAccount.cancelForeground();
  });
  const network = NetInfo.addEventListener(n => {
    scheduler.wake();
    if (!n.isConnected || n.isInternetReachable === false) syncAccount.cancel();
    else if (n.type !== 'wifi')
      void localSession().then(async session => {
        if (!session) return;
        const raw = await secureStorage.getItem(`profile.${session.user.id}`);
        if (!raw || !(JSON.parse(raw) as Profile).mobileUploads)
          syncAccount.cancel();
      });
  });
  return () => {
    scheduler.setActive(false);
    app.remove();
    network();
    syncAccount.cancelForeground();
  };
}
