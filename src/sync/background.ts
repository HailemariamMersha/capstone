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
      await syncLegacy();
      if (isTripArmed()) return;
      const session = await localSession();
      const n = await NetInfo.fetch();
      if (!session || !n.isConnected || n.isInternetReachable === false) return;
      for (const trip of await measurementStore.accountTrips(session.user.id)) {
        if (
          isTripArmed() ||
          generation !== cancellationGeneration ||
          Date.now() >= deadline
        )
          return;
        if (trip.state === 'active' || trip.uploadedRevision === trip.revision)
          continue;
        await uploadTrip(trip, false, n.type === 'wifi', async () => {
          trip.revision++;
          await measurementStore.saveTrip(trip);
        });
      }
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
