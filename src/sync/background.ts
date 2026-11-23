import { AppState } from 'react-native';
import { createRetryScheduler } from './retryScheduler';
import BackgroundFetch from 'react-native-background-fetch';
import NetInfo from '@react-native-community/netinfo';
import { localSession, api, secureStorage, Profile } from '../auth/client';
import { measurementStore } from '../storage/database';
import BackgroundService from 'react-native-background-actions';
import { recoverTrips } from '../trips/runtime';
import { isTripArmed, currentActivity } from '../services/activityGate';
import { uploadTrip, cancelTripUpload } from '../trips/sync';
import { createAccountSync } from './accountSync';

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
  request: (path, body, owner, method = 'POST', signal) =>
    api(path, { method, signal, body: JSON.stringify(body) }, owner),
});
let syncing: Promise<void> | null = null;
let cancellationGeneration = 0;
export const syncAccount = Object.assign(
  () => {
    if (syncing) return syncing;
    const generation = cancellationGeneration;
    const deadline = Date.now() + 25000;
    const timeout = setTimeout(() => {
      cancellationGeneration++;
      syncLegacy.cancel();
      cancelTripUpload();
    }, 25000);
    syncing = (async () => {
      if (isTripArmed()) return;
      const session = await localSession();
      const n = await NetInfo.fetch();
      if (!session || !n.isConnected || n.isInternetReachable === false) return;
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
      const tasks: { id: string; run(): Promise<void> }[] = [
        ...(legacyPending ? [{ id: 'legacy', run: () => syncLegacy() }] : []),
        ...trips.map(trip => ({
          id: trip.id,
          run: () =>
            uploadTrip(trip, false, n.type === 'wifi', async () => {
              trip.revision++;
              await measurementStore.saveTrip(trip);
            }),
        })),
      ];
      const cursorKey = `upload-opportunity-cursor.${owner}`;
      const cursor = await secureStorage.getItem(cursorKey);
      const previous = tasks.findIndex(t => t.id === cursor);
      const start = previous < 0 ? 0 : (previous + 1) % tasks.length;
      const ordered = [...tasks.slice(start), ...tasks.slice(0, start)];
      let firstError: unknown;
      for (const task of ordered) {
        if (
          isTripArmed() ||
          currentActivity() ||
          generation !== cancellationGeneration ||
          Date.now() >= deadline
        )
          break;
        // Advance before work: cancellation, process death or a failing old trip
        // must not monopolize every later 25-second upload opportunity.
        await secureStorage.setItem(cursorKey, task.id);
        if (
          isTripArmed() ||
          currentActivity() ||
          generation !== cancellationGeneration
        )
          break;
        try {
          await task.run();
        } catch (error) {
          if (generation !== cancellationGeneration || Date.now() >= deadline)
            break;
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    })().finally(() => {
      clearTimeout(timeout);
      syncing = null;
    });
    return syncing;
  },
  {
    cancel: () => {
      cancellationGeneration++;
      syncLegacy.cancel();
      cancelTripUpload();
    },
  },
);
export async function backgroundUpload(taskId: string) {
  try {
    if (
      !currentActivity() &&
      !isTripArmed() &&
      !BackgroundService.isRunning()
    ) {
      const session = await localSession();
      if (session) await recoverTrips(session.user.id);
    }
    await syncAccount();
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
      syncAccount.cancel();
      BackgroundFetch.finish(taskId);
    },
  );
}

/** Runs only while the app is visible; headless jobs retain their existing bounds. */
export function startAutomaticUploads() {
  let cooldown = 0;
  const scheduler = createRetryScheduler({
    now: Date.now,
    async nextAttempt() {
      const session = await localSession();
      if (!session) return null;
      const resetAt = await measurementStore.historyResetAt?.();
      if (resetAt) {
        const owner = session.user.id;
        const seen = await secureStorage.getItem(`history-reset-seen.${owner}`);
        if (Number(seen ?? 0) < resetAt) {
          await secureStorage.removeItem(`automatic-upload-retry.${owner}`);
          await secureStorage.removeItem(`upload-opportunity-cursor.${owner}`);
          await secureStorage.setItem(
            `history-reset-seen.${owner}`,
            String(resetAt),
          );
        }
      }
      if (isTripArmed() || currentActivity()) return Date.now() + 30000;
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
      const saved = await secureStorage.getItem(
        `automatic-upload-retry.${session.user.id}`,
      );
      const backoff = saved ? JSON.parse(saved).nextAt : 0;
      return Math.max(next ?? 0, cooldown, backoff);
    },
    async run() {
      const session = await localSession();
      if (!session || isTripArmed() || currentActivity()) return;
      const owner = session.user.id;
      const key = `automatic-upload-retry.${owner}`;
      try {
        await syncAccount();
        await secureStorage.setItem(
          key,
          JSON.stringify({ attempts: 0, nextAt: 0 }),
        );
      } catch {
        const raw = await secureStorage.getItem(key);
        const attempts = (raw ? Number(JSON.parse(raw).attempts) : 0) + 1;
        await secureStorage.setItem(
          key,
          JSON.stringify({
            attempts,
            nextAt:
              Date.now() +
              Math.min(3600000, 15000 * 2 ** Math.min(attempts - 1, 8)),
          }),
        );
      } finally {
        cooldown = Date.now() + 30000;
      }
    },
  });
  scheduler.setActive(AppState.currentState === 'active');
  const app = AppState.addEventListener('change', state =>
    scheduler.setActive(state === 'active'),
  );
  const network = NetInfo.addEventListener(() => scheduler.wake());
  return () => {
    scheduler.setActive(false);
    app.remove();
    network();
  };
}
