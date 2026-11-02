import {
  requireMlabConsent,
  runTripMlab,
  MLAB_RESERVATION,
  MLAB_CONSENT,
} from '../reference/tripMlab';
import { NativeModules, NativeEventEmitter } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import { measurementStore as store } from '../storage/database';
import { acquireActivity, setTripArmed } from '../services/activityGate';
import { createBackgroundExecutor } from '../background/backgroundExecutor';
import { runProbe } from '../measurements/runProbe';
import { runDiagnostic } from '../measurements/diagnostics';
import { requestedPayload } from '../measurements/diagnosticConfig';
import { participantDefaults } from '../participant/defaults';
import type { MeasurementConfig, ServiceStatus } from '../sessions/types';
import type { Measurement, ProbeType } from '../measurements/types';
import type { NetworkSnapshot } from '../network/types';
import {
  TRIP_POLICY,
  type Trip,
  type FlightDetails,
  type GpsEvidence,
  flightDetails,
  evaluate,
  transition,
  reserve,
  reservePair,
} from './model';
import { locationFix } from './location';
import { uploadTrip, cancelTripUpload } from './sync';

interface Wifi {
  networkKey: string;
  handle: string;
  ssid: string | null;
  bssid: string | null;
  validated: boolean;
  bound: boolean;
}
const native = NativeModules.FlightNetwork as
  | { bindWifi(): Promise<Wifi | null>; release(): Promise<void> }
  | undefined;
const executor = createBackgroundExecutor(true);
let trip: Trip | null = null;
let segment: string | null = null;
let running: Promise<void> | null = null;
let starting = false;
let abort: AbortController | null = null;
let probeAbort: AbortController | null = null;
let release: (() => void) | null = null;
let count = 0;
let uploading = false;
let latest: Pick<
  Measurement,
  'type' | 'value' | 'unit' | 'success' | 'timestamp'
> | null = null;
export const tripProgress = () => ({
  count,
  uploading,
  latest,
  error: lastError,
});
let lastError: string | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(fn => fn());
export const subscribeTrip = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const currentTrip = () =>
  trip ? (JSON.parse(JSON.stringify(trip)) as Trip) : null;
export const tripRunning = () => running !== null || starting;
export function tripServiceStatus(): ServiceStatus | null {
  if (!tripRunning() || !trip) return null;
  return {
    state: 'running',
    sessionId: segment,
    startedAt: trip.startedAt,
    elapsedMs: Date.now() - trip.startedAt,
    heartbeatCount: 0,
    lastHeartbeatAt: trip.evidence?.at ?? null,
    measurementCount: count,
    error: lastError,
  };
}
async function persist() {
  if (trip) {
    trip.revision++;
    await store.saveTrip(trip);
    publish();
  }
}
const config = (): MeasurementConfig => ({
  ...participantDefaults,
  httpEnabled: true,
  referenceByteThreshold: 90 * 1048576,
  maxDurationMs: TRIP_POLICY.maximumMs,
  maxPayloadBytes:
    trip!.policy.transferBytes +
    trip!.policy.diagnosticBytes +
    trip!.policy.liveUploadBytes,
  downloadBytes: TRIP_POLICY.downloadBytes,
  uploadBytes: TRIP_POLICY.uploadBytes,
  tracerouteMaxHops: 20,
  loadedLatencyEnabled: false,
  tripId: trip!.id,
  segmentIndex: trip!.segmentCount,
  flight: trip!.flight,
  flightPolicy: trip!.policy,
  mlabPolicy: trip!.mlab
    ? {
        consentVersion: trip!.mlab.consentVersion,
        reservationBytes: MLAB_RESERVATION,
        byteThresholdPerDirection: 90 * 1048576,
        maximumPairsPerTrip: 1,
        maximumPairsPerDay: 4,
      }
    : undefined,
  collectionMode: trip!.shadow ? 'detector_shadow' : 'flight_auto',
});
async function openSegment() {
  if (!trip) return;
  segment = await store.createSession(config(), undefined, trip.ownerId);
  trip.segmentCount++;
  await persist();
}
async function closeSegment(reason: string) {
  if (!segment || !trip) return;
  await store.addEvent(segment, 'trip_segment_closed', {
    tripId: trip.id,
    reason,
    budgets: { ...trip.used },
  });
  await store.endSession(
    segment,
    trip.state === 'interrupted' ? 'interrupted' : 'completed',
    reason,
  );
  segment = null;
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}
export async function recoverTrips(owner: string, startup = false) {
  if (running || (starting && !startup)) return;
  await store.initialize(true);
  const sessions = await store.accountSessions(owner);
  for (const saved of await store.accountTrips(owner)) {
    for (const session of sessions.filter(
      s => s.config.tripId === saved.id && s.state === 'active',
    )) {
      await store.endSession(
        session.id,
        'interrupted',
        'process_interrupted_exact_end_unknown',
      );
    }
    if (saved.state !== 'active') continue;
    const indices = sessions
      .filter(s => s.config.tripId === saved.id)
      .map(s => s.config.segmentIndex ?? -1);
    saved.segmentCount = Math.max(
      saved.segmentCount,
      ...indices.map(i => i + 1),
    );
    saved.state = 'interrupted';
    saved.phase = 'finished';
    saved.endedAt = Date.now();
    saved.reason = 'process_interrupted_exact_end_unknown';
    saved.revision++;
    await store.saveTrip(saved);
  }
}
export async function startTrip(
  owner: string,
  flight: FlightDetails,
  shadow = false,
) {
  if (tripRunning()) throw new Error('A trip is already running.');
  const details = flightDetails(flight);
  starting = true;
  try {
    release = acquireActivity('measurement');
  } catch (e) {
    starting = false;
    throw e;
  }
  setTripArmed(true);
  try {
    if (!native)
      throw new Error('Flight collection requires the Android pilot build.');
    await requireMlabConsent(owner);
    await recoverTrips(owner, true);
    // Platform permission/location checks happen while the app is visible.
    await native.bindWifi();
    await store.initialize(true);
    const bytes = new Uint8Array(16);
    (
      globalThis as unknown as {
        crypto: { getRandomValues(v: Uint8Array): Uint8Array };
      }
    ).crypto.getRandomValues(bytes);
    const id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    const now = Date.now();
    trip = {
      id,
      ownerId: owner,
      revision: 0,
      startedAt: now,
      endedAt: null,
      state: 'active',
      phase: 'watching',
      reason: null,
      flight: details,
      policy: TRIP_POLICY,
      segmentCount: 0,
      firstQualifiedAt: null,
      candidateAt: null,
      candidateKey: null,
      qualifiedKey: null,
      disconnectedAt: null,
      lowSpeedAt: null,
      airborneSeen: false,
      evidence: null,
      used: { transfers: 0, diagnostics: 0, uploads: 0 },
      transferPairs: 0,
      nextTransferAt: null,
      nextUploadAt: now + 900000,
      due: {},
      shadow,
      mlab: {
        consentVersion: MLAB_CONSENT,
        dueAt: null,
        reserved: false,
        status: 'waiting_for_connectivity',
      },
    };
    count = 0;
    latest = null;
    lastError = null;
    abort = new AbortController();
    await persist();
    await openSegment();
    await executor.start(
      () => {
        if (segment) store.touchSession(segment).catch(() => abort?.abort());
      },
      () => abort?.abort(),
    );
    running = loop(abort.signal)
      .catch(async () => {
        lastError = 'Collection interrupted; saved observations are retained.';
        if (trip) {
          trip.state = 'interrupted';
          trip.reason = 'collector_error';
        }
      })
      .finally(async () => {
        try {
          if (trip) {
            trip.phase = 'finished';
            trip.endedAt ??= Date.now();
            if (trip.state === 'active') trip.state = 'completed';
            trip.reason ??= 'participant_stop';
            await closeSegment(trip.reason);
            await persist();
          }
        } catch {
          lastError =
            'Final save needs recovery. Reopen the app before starting another trip.';
        } finally {
          try {
            await executor.stop();
          } finally {
            await Promise.resolve()
              .then(() => native?.release())
              .catch(() => {});
            release?.();
            release = null;
            setTripArmed(false);
            running = null;
            publish();
          }
        }
      });
  } catch (e) {
    try {
      if (trip?.state === 'active') {
        trip.phase = 'finished';
        trip.state = 'interrupted';
        trip.endedAt = Date.now();
        trip.reason = 'startup_failed';
        await closeSegment('startup_failed');
        await persist();
      }
    } finally {
      await executor.stop().catch(() => {});
      await Promise.resolve()
        .then(() => native?.release())
        .catch(() => {});
      release?.();
      release = null;
      setTripArmed(false);
    }
    throw e;
  } finally {
    starting = false;
    publish();
  }
}
export async function stopTrip() {
  abort?.abort();
  probeAbort?.abort();
  cancelTripUpload();
  await running;
}
async function loop(signal: AbortSignal) {
  let gps: GpsEvidence | null = null;
  let gpsAt = -Infinity,
    identityAt = -Infinity;
  let identity: {
    publicIp?: string;
    asn?: number;
    reverseDns?: string;
    popCode?: string;
    asnUnavailable?: string;
  } = {};
  let handle: string | null = null;
  let wake = new AbortController();
  const listener = new NativeEventEmitter(
    NativeModules.FlightNetwork,
  ).addListener(
    'flightNetworkChanged',
    (event?: { handle?: string; lost?: boolean; kind?: string }) => {
      if (event?.kind !== 'capabilities') {
        identity = {};
        identityAt = -Infinity;
      }
      if (trip && event?.lost && event.handle === handle) {
        trip.qualifiedKey = null;
        trip.candidateKey = null;
        trip.candidateAt = null;
      }
      if (event?.kind !== 'capabilities') {
        probeAbort?.abort();
        cancelTripUpload();
      }
      wake.abort();
    },
  );
  const cancellation = () => {
    probeAbort?.abort();
    wake.abort();
  };
  signal.addEventListener('abort', cancellation);
  try {
    while (!signal.aborted && trip && trip.phase !== 'finished') {
      wake = new AbortController();
      const cycleAt = Date.now();
      const wifi = await native!.bindWifi().catch(() => null);
      if (wifi?.handle !== handle) {
        identity = {};
        identityAt = -Infinity;
        gps = null;
        handle = wifi?.handle ?? null;
      }
      if (
        wifi?.bound &&
        Date.now() - identityAt >= 60000 &&
        reserve(trip, 'diagnostics', 2048)
      ) {
        identityAt = Date.now();
        identity = {};
        await persist();
        probeAbort = new AbortController();
        const timer = setTimeout(() => probeAbort?.abort(), 3000);
        try {
          const result = await fetch(
            `${participantDefaults.serverUrl}/api/v1/context`,
            {
              signal: probeAbort.signal,
              headers: { 'Cache-Control': 'no-cache', Connection: 'close' },
            },
          );
          if (result.ok && result.headers.get('X-Capstone-Probe') === '1') {
            const raw = await result.text();
            if (
              raw.length <= 2048 &&
              !probeAbort.signal.aborted &&
              (await native!.bindWifi())?.handle === handle
            )
              identity = JSON.parse(raw);
          }
        } catch {
          /* Unknown evidence is retained below. */
        } finally {
          clearTimeout(timer);
        }
      }
      if (Date.now() - identityAt > 120000) identity = {};
      let evidence = evaluate({
        now: Date.now(),
        networkKey: wifi?.bound ? wifi.networkKey : null,
        ssid: wifi?.ssid ?? null,
        asn: identity.asn ?? null,
        identityReason: identity.asnUnavailable,
        identityAt: Number.isFinite(identityAt) ? identityAt : null,
        gps,
      });
      if (
        wifi?.bound &&
        (evidence.asn.state === 'positive' ||
          evidence.ssid.state === 'positive') &&
        Date.now() - gpsAt >= 60000
      ) {
        gpsAt = Date.now();
        gps = await locationFix(signal);
        evidence = evaluate({
          now: Date.now(),
          networkKey: wifi.networkKey,
          ssid: wifi.ssid,
          asn: identity.asn ?? null,
          identityReason: identity.asnUnavailable,
          identityAt: Number.isFinite(identityAt) ? identityAt : null,
          gps,
        });
      }
      trip = transition(trip, evidence);
      const battery = await DeviceInfo.getBatteryLevel().catch(() => -1);
      const charging = await DeviceInfo.isBatteryCharging().catch(() => null);
      if (battery >= 0 && battery <= 0.15 && charging === false) {
        trip.phase = 'finished';
        trip.state = 'completed';
        trip.endedAt = Date.now();
        trip.reason = 'battery';
      }
      await persist();
      if (segment)
        await store.addEvent(segment, 'flight_detection', {
          tripId: trip.id,
          policyVersion: TRIP_POLICY.version,
          phase: trip.phase,
          shadow: trip.shadow,
          ...evidence,
        });
      if (trip.phase === 'finished' || signal.aborted) break;
      if (Date.now() >= trip.nextUploadAt) {
        const start = Date.now();
        trip.nextUploadAt +=
          (Math.floor((start - trip.nextUploadAt) / 900000) + 1) * 900000;
        await closeSegment('periodic_upload');
        await persist();
        release?.();
        release = null;
        uploading = true;
        publish();
        try {
          if (wifi?.bound && wifi.validated)
            await uploadTrip(trip, true, true, persist);
        } catch {
          lastError = 'Upload pending; measurements continue.';
        } finally {
          uploading = false;
          publish();
          release = acquireActivity('measurement');
        }
        if (signal.aborted) break;
        await openSegment();
        await store.addEvent(segment!, 'upload_pause', {
          startedAt: start,
          endedAt: Date.now(),
          durationMs: Date.now() - start,
        });
      }
      if (trip.shadow && wifi?.bound)
        trip.nextTransferAt ??= Date.now() + 300000;
      if (wifi?.bound && (trip.phase === 'collecting' || trip.shadow)) {
        const snapshot: NetworkSnapshot = {
          id: '',
          timestamp: new Date().toISOString(),
          type: 'wifi',
          isConnected: true,
          ssid: wifi.ssid,
          bssid: wifi.bssid,
          publicIp: identity.publicIp ?? null,
          asn: identity.asn ?? null,
          publicIpObservedAt: Number.isFinite(identityAt)
            ? new Date(identityAt).toISOString()
            : null,
          batteryPercent: battery < 0 ? null : Math.round(battery * 100),
          isCharging: charging,
          isInternetReachable: wifi.validated,
          flightEvidence: evidence,
          popCode: identity.popCode ?? null,
          reverseDns: identity.reverseDns ?? null,
        };
        const saved = await store.saveSnapshot(segment!, snapshot);
        const cfg = config();
        if (trip.mlab && trip.mlab.dueAt == null) {
          // Persist randomized spacing; segment rotation never resets it.
          trip.mlab.dueAt =
            Date.now() + 60000 + Math.floor(Math.random() * 120000);
          await persist();
        }
        if (
          trip.mlab &&
          !trip.mlab.reserved &&
          trip.mlab.dueAt != null &&
          Date.now() >= trip.mlab.dueAt &&
          wifi.validated &&
          !signal.aborted
        ) {
          const route = await native!.bindWifi().catch(() => null);
          if (route?.bound && route.handle === wifi.handle) {
            trip.mlab.reserved = true;
            const allowed = reserve(trip, 'transfers', MLAB_RESERVATION);
            trip.mlab.status = allowed ? 'running' : 'allowance_unavailable';
            await persist();
            if (allowed) {
              probeAbort = new AbortController();
              if (signal.aborted) probeAbort.abort();
              const results = await runTripMlab(
                store,
                segment!,
                trip.mlab.consentVersion,
                wifi.handle,
                saved,
                probeAbort.signal,
              );
              for (const result of results) {
                count++;
                latest = result;
              }
              trip.mlab.status = results.every(r => r.success)
                ? 'complete'
                : 'incomplete';
              await persist();
            }
          }
        }
        const probe = async (type: ProbeType) => {
          if (signal.aborted) return;
          const currentWifi = await native!.bindWifi().catch(() => null);
          if (!currentWifi?.bound || currentWifi.handle !== wifi.handle) {
            await store.addEvent(segment!, 'probe_skipped', {
              type,
              reason: 'wifi_route_changed',
            });
            return;
          }
          probeAbort = new AbortController();
          const attempt = await store.beginAttempt(
            segment!,
            type,
            new Date().toISOString(),
          );
          const timer = setTimeout(() => probeAbort?.abort(), 120000);
          try {
            const result =
              type === 'download' || type === 'upload' || type === 'http_rtt'
                ? await runProbe(type, cfg, segment!, probeAbort.signal)
                : await runDiagnostic(attempt, cfg, probeAbort.signal);
            await store.finishAttempt({
              ...result,
              id: attempt.id,
              networkSnapshot: saved,
            });
            count++;
            latest = {
              type: result.type ?? type,
              value: result.value,
              unit: result.unit,
              success: result.success,
              timestamp: result.timestamp,
            };
            publish();
          } finally {
            clearTimeout(timer);
          }
        };
        for (const [type, interval] of [
          ['icmp_burst', 60000],
          ['udp_echo', 60000],
          ['tcp_connect', 60000],
          ['traceroute', 900000],
        ] as [ProbeType, number][]) {
          if (signal.aborted || Date.now() < (trip.due[type] ?? 0)) continue;
          trip.due[type] = Date.now() + interval;
          if (!reserve(trip, 'diagnostics', requestedPayload(type, cfg))) {
            await store.addEvent(segment!, 'probe_skipped', {
              type,
              reason: 'diagnostic_allowance',
            });
            continue;
          }
          await persist();
          await probe(type);
        }
        if (
          wifi.validated &&
          !signal.aborted &&
          reservePair(trip, Date.now())
        ) {
          await persist();
          await probe('download');
          await probe('upload');
        }
      }
      if (!signal.aborted)
        await wait(Math.max(100, 30000 - (Date.now() - cycleAt)), wake.signal);
    }
  } finally {
    listener.remove();
    signal.removeEventListener('abort', cancellation);
  }
}
