import { Buffer } from 'buffer';
import { api, localSession, secureStorage, type Profile } from '../auth/client';
import { measurementStore as store } from '../storage/database';
import { createAccountSync } from '../sync/accountSync';
import type { Trip } from './model';
import { reserve } from './model';
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
) {
  const session = await localSession();
  if (session?.user.id !== t.ownerId) return;
  const profileRaw = await secureStorage.getItem(`profile.${t.ownerId}`);
  if (!profileRaw) return;
  const profile: Profile = JSON.parse(profileRaw);
  if (!wifi && !profile.mobileUploads) return;
  // The response allowance is reserved before sending. Unused allowance is not
  // refunded; failed requests/retries are conservatively charged as well.
  const request = async <T>(
    path: string,
    body: unknown,
    owner: string,
    method = 'POST',
    signal?: AbortSignal,
  ): Promise<T> => {
    const text = JSON.stringify(body);
    const reservation = Buffer.byteLength(text, 'utf8') + 65536;
    if (live && !reserve(t, 'uploads', reservation))
      throw new Error(
        'Live upload allowance exhausted; saved for post-trip Wi-Fi.',
      );
    if (live) await persist();
    return api<T>(path, { method, body: text, signal }, owner);
  };
  const upload = createAccountSync({
    store,
    tripWindow: true,
    now: Date.now,
    identity: async () => ({
      owner: t.ownerId,
      mobileUploads: profile.mobileUploads,
    }),
    network: async () => ({ connected: true, wifi }),
    request,
    sessionFilter: s => s.config.tripId === t.id,
    beforeSessions: async signal => {
      const result = await request<{ uploadComplete: boolean }>(
        `/trips/${t.id}`,
        tripManifest(t),
        t.ownerId,
        'PUT',
        signal,
      );
      if (!live && result.uploadComplete) {
        t.uploadedRevision = t.revision;
        await store.saveTrip(t);
      }
    },
  });
  cancelCurrent = upload.cancel;
  try {
    await upload();
  } finally {
    cancelCurrent = null;
  }
}
