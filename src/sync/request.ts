import { api } from '../auth/client';
import type { MeasurementStore } from '../storage/types';
import { PILOT_POLICY_VERSION, reserve, type Trip } from '../trips/model';
import {
  jsonBody,
  syncVersion,
  uploadKey,
  type ApiResponseObservation,
} from './transport';

let sequence = 0;
export function createUploadRequest(
  store: MeasurementStore,
  options: {
    trip?: Trip;
    live?: boolean;
    persist?: () => Promise<void>;
    observe?: (details: Record<string, unknown>) => Promise<void>;
  } = {},
) {
  return async <T>(
    path: string,
    body: unknown,
    owner: string,
    method = 'POST',
    signal?: AbortSignal,
  ): Promise<T> => {
    const preparing = performance.now();
    const version = await syncVersion(store, owner);
    const encoded =
      body === undefined
        ? { body: undefined, bytes: 0, decodedBytes: 0, encoding: 'identity' }
        : jsonBody(body, version >= 2);
    const reservation = encoded.bytes + 65536;
    const { trip, live, persist } = options;
    const settleActual = trip?.policy.version === PILOT_POLICY_VERSION;
    const reservationId = `${Date.now()}:${++sequence}`;
    if (live && trip) {
      const held = Object.values(trip.uploadReservations ?? {}).reduce(
        (a, b) => a + b,
        0,
      );
      if (settleActual) {
        if (
          trip.used.uploads + held + reservation >
          trip.policy.liveUploadBytes
        )
          throw Object.assign(
            new Error(
              'Live upload allowance exhausted; saved for post-trip Wi-Fi.',
            ),
            { code: 'UPLOAD_ALLOWANCE' },
          );
        (trip.uploadReservations ??= {})[reservationId] = reservation;
      } else if (!reserve(trip, 'uploads', reservation))
        throw Object.assign(
          new Error(
            'Live upload allowance exhausted; saved for post-trip Wi-Fi.',
          ),
          { code: 'UPLOAD_ALLOWANCE' },
        );
      await persist?.();
    }
    const stage = path.endsWith('/payment')
      ? 'payment'
      : path.includes('/trips/')
      ? method === 'GET'
        ? 'trip_receipt'
        : 'trip_manifest'
      : path.split('/').pop();
    const started = Date.now();
    const apiStarted = performance.now();
    let apiFinished = apiStarted;
    let dispatched = false;
    let response: ApiResponseObservation | undefined;
    let failure: { code?: string; status?: number } | undefined;
    try {
      const value = await api<T>(
        path,
        {
          method,
          body: encoded.body,
          headers:
            encoded.encoding === 'gzip'
              ? {
                  'Content-Encoding': 'gzip',
                  // RN Android strips Content-Encoding from binary bodies in
                  // NetworkingModule.extractHeaders. Preserve the label through
                  // a bounded, explicitly negotiated v2 transport header.
                  'X-SkyMeasure-Content-Encoding': 'gzip',
                }
              : undefined,
          signal,
        },
        owner,
        {
          dispatched: () => {
            dispatched = true;
          },
          response: observed => {
            response = observed;
          },
        },
      );
      apiFinished = performance.now();
      return value;
    } catch (error) {
      apiFinished = performance.now();
      failure = error as typeof failure;
      throw error;
    } finally {
      // A received response has known body bytes. An uncertain dispatched request
      // retains its full reservation. Only a proven pre-dispatch cancellation is free.
      if (live && trip && settleActual) {
        const held = trip.uploadReservations?.[reservationId];
        if (held != null) {
          trip.used.uploads += response
            ? encoded.bytes + response.responseBytes
            : dispatched
            ? held
            : 0;
          delete trip.uploadReservations![reservationId];
          await persist?.();
        }
      }
      if (response) {
        await store.saveUploadState?.(
          owner,
          uploadKey('capability'),
          response.syncVersion >= 2 ? 2 : 1,
        );
        if (
          response.retryAfterMs != null &&
          (response.status === 429 || response.status === 503)
        )
          await store.saveUploadState?.(
            owner,
            uploadKey('retry-at'),
            Date.now() + response.retryAfterMs,
          );
      }
      const entry = {
        stage,
        outcome: failure ? 'pending_retry' : 'received_response',
        startedAt: new Date(started).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: apiFinished - apiStarted,
        prepareDurationMs: apiStarted - preparing,
        settlementDurationMs: performance.now() - apiFinished,
        requestBytes: encoded.bytes,
        decodedRequestBytes: encoded.decodedBytes,
        encoding: encoded.encoding,
        responseBytes: response?.responseBytes ?? null,
        status: response?.status ?? failure?.status ?? null,
        requestId: response?.requestId ?? null,
        serverTiming: response?.serverTiming ?? null,
        reason: failure
          ? signal?.aborted
            ? 'opportunity_cancelled'
            : failure.code === 'REQUEST_TIMEOUT'
            ? 'request_timeout'
            : 'request_failed'
          : undefined,
      };
      await store.appendUploadDiagnostic?.(owner, entry);
      await options.observe?.(entry);
    }
  };
}
