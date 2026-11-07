import { NativeModules } from 'react-native';
import { secureStorage } from '../auth/client';
import type { MeasurementStore } from '../storage/types';
import type { NetworkSnapshot } from '../network/types';
import { parseReferenceMessage, type ReferenceMessage } from './protocol';
import { referenceMeasurement } from './session';

export const MLAB_CONSENT = 'skymeasure-flight-mlab-2026-11-02';
export const MLAB_RESERVATION = 200 * 1048576;
export async function requireMlabConsent(owner: string) {
  const raw = await secureStorage.getItem(`profile.${owner}`);
  const profile = raw ? JSON.parse(raw) : null;
  if (!owner || profile?.consentVersion !== MLAB_CONSENT)
    throw new Error(
      'Review the updated research and M-Lab publication information before starting.',
    );
}

/** Executes in the existing measurement activity/segment; never overlaps uploads. */
export async function runTripMlab(
  store: MeasurementStore,
  sessionId: string,
  consent: string,
  wifiHandle: string,
  snapshot: NetworkSnapshot,
  signal: AbortSignal,
  scheduledAt?: number,
) {
  if (consent !== MLAB_CONSENT)
    throw new Error('M-Lab publication consent required.');
  const native = NativeModules.CapstoneNdt7 as
    | {
        run(
          id: string,
          consentVersion: string,
          handle: string,
        ): Promise<string>;
        cancel(id: string): void;
      }
    | undefined;
  const attempts = [];
  for (const type of ['ndt7_download', 'ndt7_upload'] as const)
    attempts.push(
      await store.beginAttempt(
        sessionId,
        type,
        new Date(scheduledAt ?? Date.now()).toISOString(),
      ),
    );
  const id = attempts[0].id;
  await store.addEvent(sessionId, 'reference_consent', {
    consentVersion: consent,
    policyUrl: 'https://www.measurementlab.net/privacy/',
    publicIpAndResultsPublished: true,
    library: 'ndt7-client-android',
    version: '0.2.1-skymeasure.1',
    reservationBytes: MLAB_RESERVATION,
    byteThresholdPerDirection: 90 * 1048576,
    thresholdMayOvershoot: true,
    automatic: true,
    foregroundService: true,
  });
  let response: ReferenceMessage = {
    version: 1,
    runId: id,
    type: 'finished',
    reason: 'unsupported',
    results: [],
  };
  const cancel = () => native?.cancel(id);
  signal.addEventListener('abort', cancel);
  try {
    if (signal.aborted) response.reason = 'cancelled';
    else if (native)
      response = parseReferenceMessage(
        await native.run(id, consent, wifiHandle),
        id,
      );
  } catch (error) {
    response.reason = signal.aborted ? 'cancelled' : 'network';
    // Native errors expose stable codes, never signed Locate URLs or credentials.
    const code = (error as { code?: string })?.code;
    await store.addEvent(sessionId, 'reference_unavailable', {
      reason: ['QUOTA', 'ROUTE', 'CONSENT', 'STORAGE', 'BUSY'].includes(
        code ?? '',
      )
        ? code
        : 'native_or_response_error',
    });
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  const results = attempts.map(attempt => ({
    ...referenceMeasurement(
      attempt,
      response.results.find(
        r =>
          r.direction ===
          (attempt.type === 'ndt7_download' ? 'download' : 'upload'),
      ),
      response.reason ?? 'invalid_response',
      {
        library: 'ndt7-client-android',
        version: '0.2.1-skymeasure.1',
        method: 'ndt7_android_library',
        source: 'android_library_callbacks',
        byteThreshold: 90 * 1048576,
      },
    ),
    requestedBytes: 90 * 1048576,
    networkSnapshot: snapshot,
  }));
  for (const result of results) await store.finishAttempt(result);
  return results;
}
