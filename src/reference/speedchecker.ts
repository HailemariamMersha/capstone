import { NativeModules, Platform } from 'react-native';
import { acquireActivity } from '../services/activityGate';
import { DEFAULT_SESSION_CONFIG } from '../sessions/config';
import type { Measurement } from '../measurements/types';
import type { MeasurementStore } from '../storage/types';

export const SPEEDCHECKER_VERSION = '4.2.299';
export interface SpeedCheckerResult {
  runId: string;
  reason: string;
  cleanupConfirmed: boolean;
  durationMs: number;
  downloadMbps: number | null;
  uploadMbps: number | null;
  pingMs: number | null;
  jitterMs: number | null;
  downloadMb: number | null;
  uploadMb: number | null;
  server: string | null;
}
export interface SpeedCheckerAdapter {
  start(runId: string, consent: boolean): Promise<SpeedCheckerResult>;
  cancel(runId: string): void;
}
export const speedCheckerAdapter: SpeedCheckerAdapter | undefined =
  Platform.OS === 'android' ? NativeModules.CapstoneSpeedChecker : undefined;

export function validateSpeedCheckerResult(
  value: SpeedCheckerResult,
  id: string,
): void {
  if (
    !value ||
    value.runId !== id ||
    typeof value.cleanupConfirmed !== 'boolean' ||
    ![
      'complete',
      'cancelled',
      'timeout',
      'data_threshold',
      'network',
      'server_unavailable',
      'unsupported',
      'cleanup_unconfirmed',
    ].includes(value.reason) ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    (value.server !== null &&
      (typeof value.server !== 'string' ||
        !/^[a-zA-Z0-9.-]{1,253}$/.test(value.server)))
  ) {
    throw new Error('Invalid SpeedChecker result.');
  }
  for (const key of [
    'downloadMbps',
    'uploadMbps',
    'pingMs',
    'jitterMs',
    'downloadMb',
    'uploadMb',
  ] as const) {
    const number = value[key];
    if (
      number !== null &&
      (typeof number !== 'number' || !Number.isFinite(number) || number < 0)
    ) {
      throw new Error('Invalid SpeedChecker counter.');
    }
  }
}
export async function runSpeedChecker(
  store: MeasurementStore,
  accepted: boolean,
  signal: AbortSignal,
  requestPermission: () => Promise<boolean>,
  adapter = speedCheckerAdapter,
): Promise<string> {
  if (!accepted) {
    throw new Error('Accept SpeedChecker data sharing before starting.');
  }
  if (!adapter) {
    throw new Error('SpeedChecker is unavailable in this build.');
  }
  const release = acquireActivity('reference');
  let id: string | undefined;
  let result: SpeedCheckerResult | undefined;
  let safeToRelease = true;
  let error: string | null = null;
  const attempts: Measurement[] = [];
  const cancel = () => {
    if (id) {
      adapter.cancel(id);
    }
  };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let settleWatchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    id = await store.createSession({
      ...DEFAULT_SESSION_CONFIG,
      mode: 'speedchecker_reference',
      serverUrl: 'https://www.speedchecker.com',
      maxDurationMs: 90000,
      referenceByteThreshold: 100000000,
      maxPayloadBytes: 100000000,
    });
    await store.addEvent(id, 'reference_consent', {
      provider: 'SpeedChecker',
      version: SPEEDCHECKER_VERSION,
      freeMode: true,
      locationAndDeviceNetworkDataShared: true,
      thresholdMb: 100,
      thresholdMayOvershoot: true,
      foregroundOnly: true,
    });
    for (const type of [
      'speedchecker_latency',
      'speedchecker_download',
      'speedchecker_upload',
    ] as const) {
      attempts.push(
        await store.beginAttempt(id, type, new Date().toISOString()),
      );
    }
    if (signal.aborted) {
      throw new Error('cancelled');
    }
    if (!(await requestPermission())) {
      throw new Error('Precise location permission was not granted.');
    }
    if (signal.aborted) {
      throw new Error('cancelled');
    }
    signal.addEventListener('abort', cancel);
    // Native checks consent/permission again. The SDK is never initialized at app launch.
    const pending = adapter.start(id, true);
    safeToRelease = false;
    if (signal.aborted) {
      cancel();
    }
    try {
      const reply = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => {
            cancel();
            settleWatchdog = setTimeout(
              () =>
                reject(
                  new Error(
                    'SpeedChecker cleanup could not be confirmed. Restart the app before further measurements.',
                  ),
                ),
              10000,
            );
          }, 100000);
        }),
      ]);
      validateSpeedCheckerResult(reply, id);
      result = reply;
      safeToRelease = reply.cleanupConfirmed;
    } catch (failure) {
      const code = (failure as { code?: string }).code;
      // Only these native rejections happen before any SDK call.
      if (
        ['consent_required', 'permission', 'cancelled'].includes(code ?? '')
      ) {
        safeToRelease = true;
      }
      throw failure;
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
    }
    if (settleWatchdog !== undefined) {
      clearTimeout(settleWatchdog);
    }
  }
  try {
    if (!id) {
      throw new Error(error ?? 'SpeedChecker session setup failed.');
    }
    const reason = result?.reason ?? (signal.aborted ? 'cancelled' : 'network');
    for (const attempt of attempts) {
      const latency = attempt.type === 'speedchecker_latency';
      const download = attempt.type === 'speedchecker_download';
      const value = latency
        ? result?.pingMs
        : download
        ? result?.downloadMbps
        : result?.uploadMbps;
      const valid =
        value != null &&
        Number.isFinite(value) &&
        (latency ? value >= 0 : value > 0);
      const success = reason === 'complete' && valid && safeToRelease;
      const mb = download ? result?.downloadMb : result?.uploadMb;
      await store.finishAttempt({
        ...attempt,
        durationMs: result?.durationMs ?? 0,
        value: success ? value! : null,
        unit: latency ? 'ms' : 'Mbps',
        success,
        errorType: success
          ? null
          : reason === 'cancelled' || reason === 'data_threshold'
          ? 'cancelled'
          : reason === 'timeout'
          ? 'timeout'
          : 'network',
        errorMessage: success
          ? null
          : error ??
            `SpeedChecker: ${
              reason === 'complete' ? 'missing metric' : reason
            }.`,
        method: 'speedchecker_sdk_reference',
        probeServer: result?.server ?? 'SpeedChecker selected server',
        transferredBytes:
          !latency && mb != null ? Math.round(mb * 1000000) : null,
        speedchecker: {
          sdkVersion: SPEEDCHECKER_VERSION,
          stopReason: reason,
          cleanupConfirmed: safeToRelease,
          thresholdMb: 100,
          downloadMb: result?.downloadMb ?? null,
          uploadMb: result?.uploadMb ?? null,
          downloadMbps: result?.downloadMbps ?? null,
          uploadMbps: result?.uploadMbps ?? null,
          pingMs: result?.pingMs ?? null,
          jitterMs: result?.jitterMs ?? null,
        },
      });
    }
    await store.endSession(
      id,
      'completed',
      `SpeedChecker reference ended: ${reason}`,
    );
    if (!safeToRelease) {
      throw new Error(
        'SDK cleanup is unconfirmed. Restart the app before further measurements or sync.',
      );
    }
    if (error) {
      throw new Error(error);
    }
    return `SpeedChecker ended: ${reason}. Saved three reference results.`;
  } catch (failure) {
    if (id) {
      await store.endSession(
        id,
        'interrupted',
        'SpeedChecker reference ended with an error.',
      );
    }
    throw failure;
  } finally {
    // Keep all measurement/sync traffic excluded if native cleanup is uncertain.
    if (safeToRelease) {
      release();
    }
  }
}
