import BackgroundFetch from 'react-native-background-fetch';
import NetInfo from '@react-native-community/netinfo';
import { localSession, api, secureStorage, Profile } from '../auth/client';
import { measurementStore } from '../storage/database';
import { createAccountSync } from './accountSync';

export const syncAccount = createAccountSync({
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
export async function backgroundUpload(taskId: string) {
  try {
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
