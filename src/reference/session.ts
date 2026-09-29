import type { Measurement, ProbeErrorType } from '../measurements/types';
import { DEFAULT_SESSION_CONFIG } from '../sessions/config';
import { acquireActivity } from '../services/activityGate';
import type { MeasurementStore } from '../storage/types';
import type { ReferenceResult } from './protocol';
import { NDT7_VERSION, REFERENCE_BYTE_THRESHOLD } from './html';

export async function createReferenceSession(
  store: MeasurementStore,
  accepted: boolean,
) {
  if (!accepted) {
    throw new Error('Accept M-Lab data publication before starting.');
  }
  const release = acquireActivity('reference');
  let id: string | undefined;
  const attempts: Measurement[] = [];
  try {
    id = await store.createSession({
      ...DEFAULT_SESSION_CONFIG,
      mode: 'ndt7_reference',
      serverUrl: 'https://locate.measurementlab.net',
      referenceByteThreshold: REFERENCE_BYTE_THRESHOLD,
      maxPayloadBytes: 2 * REFERENCE_BYTE_THRESHOLD,
      maxDurationMs: 45000,
    });
    await store.addEvent(id, 'reference_consent', {
      policyUrl: 'https://www.measurementlab.net/privacy/',
      library: '@m-lab/ndt7',
      version: NDT7_VERSION,
      publicIpAndResultsPublished: true,
      byteThresholdPerDirection: REFERENCE_BYTE_THRESHOLD,
      thresholdMayOvershoot: true,
      foregroundOnly: true,
    });
    for (const type of ['ndt7_download', 'ndt7_upload'] as const) {
      attempts.push(
        await store.beginAttempt(id, type, new Date().toISOString()),
      );
    }
  } catch (error) {
    try {
      if (id) {
        await store.endSession(id, 'interrupted', 'Reference setup failed.');
      }
    } finally {
      release();
    }
    throw error;
  }
  const sessionId = id;
  let finishing: Promise<void> | undefined;
  return {
    id: sessionId,
    finish(results: ReferenceResult[], stopReason: string): Promise<void> {
      if (finishing) {
        return finishing;
      }
      finishing = (async () => {
        try {
          for (const attempt of attempts) {
            const direction =
              attempt.type === 'ndt7_download' ? 'download' : 'upload';
            const result = results.find(item => item.direction === direction);
            let reason =
              result && result.reason !== 'running'
                ? result.reason
                : stopReason === 'complete'
                ? 'invalid_response'
                : stopReason;
            const bytes =
              direction === 'download'
                ? result?.clientBytes
                : result?.serverBytes;
            const seconds =
              direction === 'download'
                ? result?.clientSeconds
                : result?.serverSeconds;
            const success =
              reason === 'complete' &&
              result?.opened === true &&
              result?.cleanClose === true &&
              bytes != null &&
              bytes > 0 &&
              seconds != null &&
              seconds > 0;
            if (!success && reason === 'complete') {
              reason = 'invalid_response';
            }
            const failure: ProbeErrorType =
              reason === 'cancelled' || reason === 'data_threshold'
                ? 'cancelled'
                : reason === 'timeout'
                ? 'timeout'
                : reason === 'network'
                ? 'network'
                : reason === 'interrupted'
                ? 'interrupted'
                : 'invalid_response';
            await store.finishAttempt({
              ...attempt,
              success,
              errorType: success ? null : failure,
              errorMessage: success
                ? null
                : `NDT7 reference: ${reason}. Partial samples are retained.`,
              durationMs:
                (result?.clientSeconds ?? result?.serverSeconds ?? 0) * 1000,
              value: success ? (bytes! * 8) / seconds! / 1000000 : null,
              unit: 'Mbps',
              transferredBytes: result?.clientBytes ?? null,
              probeServer: result
                ? `wss://${result.host}/ndt/v7/${direction}`
                : attempt.probeServer,
              targetHost: result?.host,
              method: 'ndt7_webview_reference',
              raw: {
                library: '@m-lab/ndt7',
                version: NDT7_VERSION,
                source: 'web_worker_messages',
                request: { direction, host: result?.host },
                callbacks: result?.callbacks ?? [],
                droppedCallbacks: result?.droppedCallbacks ?? 0,
                unavailable: [
                  'clientIpPacketCapture',
                  'hardwareTransmitTimestamp',
                ],
              },
              reference: {
                library: '@m-lab/ndt7',
                version: NDT7_VERSION,
                source: result
                  ? direction === 'download'
                    ? 'client'
                    : 'server'
                  : null,
                stopReason: success ? 'complete' : reason,
                byteThreshold: REFERENCE_BYTE_THRESHOLD,
                clientBytes: result?.clientBytes ?? null,
                serverBytes: result?.serverBytes ?? null,
                elapsedSeconds: seconds ?? null,
                accounting: 'last_client_sample',
              },
            });
          }
          await store.endSession(
            sessionId,
            'completed',
            `NDT7 reference ended: ${stopReason}`,
          );
        } catch (error) {
          await store.endSession(
            sessionId,
            'interrupted',
            'Reference result persistence failed.',
          );
          throw error;
        } finally {
          release();
        }
      })();
      return finishing;
    },
  };
}
export type ReferenceSession = Awaited<
  ReturnType<typeof createReferenceSession>
>;
