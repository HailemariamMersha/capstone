import {
  requireMlabConsent,
  runTripMlab,
  MLAB_RESERVATION,
  MLAB_CONSENT,
} from '../reference/tripMlab';
import { NativeModules, NativeEventEmitter, AppState } from 'react-native';
import { deadline } from '../services/deadline';
import {
  COLLECTOR_POLICY,
  INTERVALS,
  advance,
  takeDue,
  resetProbes,
  transferTimeout,
  newHealth,
  increment,
  type ScheduledProbe,
} from './scheduler';
import DeviceInfo from 'react-native-device-info';
import { measurementStore as store } from '../storage/database';
import {
  acquireActivity,
  acquireMeasurementActivity,
  setTripArmed,
} from '../services/activityGate';
import { foregroundService } from '../background/serviceCoordinator';
import { runProbe } from '../measurements/runProbe';
import { runDiagnostic } from '../measurements/diagnostics';
import { requestedPayload } from '../measurements/diagnosticConfig';
import { runPaperProbe, paperCharge } from '../measurements/paperProbes';
import {
  PAPER_REGISTRY,
  PAPER_SUITE_VERSION,
  PAPER_CDN_LIMIT,
  PAPER_DNS_LIMIT,
  newPaperSchedule,
  readyPaperJobs,
  type PaperJob,
} from '../measurements/paperSuite';
import { newTripPolicy } from './policy';
import { participantDefaults } from '../participant/defaults';
import type { MeasurementConfig, ServiceStatus } from '../sessions/types';
import type { Measurement, ProbeType } from '../measurements/types';
import type { NetworkSnapshot } from '../network/types';
import {
  TRIP_POLICY,
  isHourlyPilot,
  isPaperPolicy,
  uncappedMlab,
  PILOT_TEST_PROVIDERS,
  DETECTOR_POLICY,
  type Trip,
  type FlightDetails,
  flightDetails,
  evaluate,
  transition,
  reserve,
  reserveContent,
  settleContent,
  reservePair,
  transferInterval,
  HOURLY_TRANSFER_POLICY,
} from './model';
import { uploadTrip, cancelTripUpload } from './sync';
import publicConfig from '../config/public.json';
import { normalizeNetId } from './payment';

interface Wifi {
  networkKey: string;
  handle: string;
  ssid: string | null;
  bssid: string | null;
  validated: boolean;
  bound: boolean;
}
const native = NativeModules.FlightNetwork as
  | {
      pilotBuild?: boolean;
      bindWifi(): Promise<Wifi | null>;
      release(): Promise<void>;
      runtimeState?(): Promise<Record<string, number | boolean>>;
    }
  | undefined;
const executor = {
  start: foregroundService.startCollection,
  stop: foregroundService.stop,
};
let trip: Trip | null = null;
let segment: string | null = null;
let running: Promise<void> | null = null;
let starting = false;
let abort: AbortController | null = null;
let probeAbort: AbortController | null = null;
let probeInterruptionReason: string | null = null;
function abortProbe(reason: string) {
  if (probeAbort && !probeAbort.signal.aborted) {
    probeInterruptionReason = reason;
    probeAbort.abort();
  }
}
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
let persistenceLane: Promise<unknown> = Promise.resolve();
let segmentLane: Promise<unknown> = Promise.resolve();
function withSegment<T>(
  task: (id: string) => Promise<T>,
): Promise<T | undefined> {
  const work = segmentLane.then(() => (segment ? task(segment) : undefined));
  segmentLane = work.catch(() => {});
  return work;
}
async function persist(paymentNetId?: string) {
  if (!trip) return;
  trip.revision++;
  const snapshot = JSON.parse(JSON.stringify(trip)) as Trip;
  const work = persistenceLane.then(() =>
    store.saveTrip(snapshot, paymentNetId),
  );
  persistenceLane = work.catch(() => {});
  await work;
  publish();
}
async function record(kind: string, details: Record<string, unknown>) {
  await withSegment(async id => {
    await store.addEvent(id, kind, details);
    return true;
  }).then(async written => {
    if (written || !trip) return;
    const queue = (trip.pendingControlEvents ??= []);
    if (queue.length < 64) queue.push({ kind, details });
    else {
      const last = queue[63];
      queue[63] = {
        kind: 'collector_buffer_overflow',
        details: {
          droppedEvents:
            last.kind === 'collector_buffer_overflow'
              ? Number(last.details.droppedEvents) + 1
              : 2,
        },
      };
    }
    await persist();
  });
}
const config = (t = trip!): MeasurementConfig => ({
  ...participantDefaults,
  collectorVersion: isPaperPolicy(t.policy.version)
    ? 'skymeasure-libraries-3'
    : 'skymeasure-libraries-2',
  collectorPolicy: COLLECTOR_POLICY,
  detectorPolicy: t.detectorPolicy ?? DETECTOR_POLICY,
  streamDownloads: true,
  httpEnabled: !isPaperPolicy(t.policy.version),
  ...(isPaperPolicy(t.policy.version)
    ? {
        measurementSuiteVersion: PAPER_SUITE_VERSION,
        paperRegistry: PAPER_REGISTRY,
      }
    : {}),
  referenceByteThreshold: uncappedMlab(t.policy.version) ? null : 90 * 1048576,
  maxDurationMs: TRIP_POLICY.maximumMs,
  maxPayloadBytes: uncappedMlab(t.policy.version)
    ? null
    : t.policy.transferBytes +
      t.policy.diagnosticBytes +
      t.policy.liveUploadBytes,
  downloadBytes: t.policy.downloadBytes,
  uploadBytes: t.policy.uploadBytes,
  tracerouteMaxHops: 20,
  loadedLatencyEnabled: false,
  tripId: t.id,
  segmentIndex: t.segmentCount,
  flight: t.flight,
  transferSchedule: t.transferSchedule,
  flightPolicy: t.policy,
  mlabPolicy: t.mlab
    ? {
        consentVersion: t.mlab.consentVersion,
        reservationBytes: uncappedMlab(t.policy.version)
          ? null
          : MLAB_RESERVATION,
        byteThresholdPerDirection: uncappedMlab(t.policy.version)
          ? null
          : 90 * 1048576,
        maximumPairsPerTrip: 1,
        maximumPairsPerDay: 4,
      }
    : undefined,
  pilotTestAsnsEnabled:
    t.pilotTestAsnsEnabled ?? isHourlyPilot(t.policy.version),
  pilotTestProviderAsns:
    t.pilotTestAsnsEnabled ?? isHourlyPilot(t.policy.version)
      ? Object.keys(PILOT_TEST_PROVIDERS).map(Number)
      : [],
  groundTest: t.groundTest ?? false,
  collectionMode: t.shadow ? 'detector_shadow' : 'flight_auto',
});
async function openSegment() {
  if (!trip) return;
  // Only the worker opens/closes; control writes take the same lane.
  const work = segmentLane.then(async () => {
    if (!trip) return;
    segment = await store.createSession(config(), undefined, trip.ownerId);
    trip.segmentCount++;
    trip.segmentHealth = newHealth();
    const buffered = trip.pendingControlEvents ?? [];
    for (const event of buffered)
      await store.addEvent(segment, event.kind, {
        ...event.details,
        bufferedDuringUpload: true,
      });
    trip.pendingControlEvents = [];
    await persist();
  });
  segmentLane = work.catch(() => {});
  await work;
}
async function closeSegment(reason: string) {
  await withSegment(async id => {
    if (!trip) return;
    await store.addEvent(id, 'segment_health', {
      policyVersion: COLLECTOR_POLICY.version,
      ...trip.segmentHealth,
      observedEndAt: new Date().toISOString(),
    });
    await store.addEvent(id, 'trip_segment_closed', {
      tripId: trip.id,
      reason,
      budgets: { ...trip.used },
    });
    await store.endSession(
      id,
      trip.state === 'interrupted' ? 'interrupted' : 'completed',
      reason,
    );
    segment = null;
  });
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
    if (Object.keys(saved.contentReservations ?? {}).length) {
      for (const key of Object.keys(saved.contentReservations!))
        settleContent(saved, key, null);
      saved.revision++;
      await store.saveTrip(saved);
    }
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
    if (saved.pendingControlEvents?.length) {
      const recovered = await store.createSession(
        config(saved),
        undefined,
        owner,
      );
      for (const event of saved.pendingControlEvents)
        await store.addEvent(recovered, event.kind, {
          ...event.details,
          bufferedDuringUpload: true,
          recoveredAfterInterruption: true,
        });
      await store.endSession(
        recovered,
        'interrupted',
        'buffered_control_evidence_recovered',
      );
      saved.segmentCount++;
      saved.pendingControlEvents = [];
    }
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
  options: { includeMlab?: boolean; netId?: string } = {},
) {
  if (tripRunning()) throw new Error('A trip is already running.');
  const details = flightDetails(flight, true);
  delete details.expectedMinutes;
  const netId = normalizeNetId(options.netId ?? '');
  starting = true;
  try {
    release = await acquireMeasurementActivity();
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
    const selectedPolicy = newTripPolicy(
      native.pilotBuild === true && publicConfig.pilotTestAsnsEnabled,
    );
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
      policy: selectedPolicy,
      pilotTestAsnsEnabled:
        native.pilotBuild === true && publicConfig.pilotTestAsnsEnabled,
      groundTest: false,
      detectorPolicy: DETECTOR_POLICY,
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
      collectorPolicy: COLLECTOR_POLICY.version,
      ...(isPaperPolicy(selectedPolicy.version)
        ? { measurementSuiteVersion: PAPER_SUITE_VERSION }
        : { transferSchedule: HOURLY_TRANSFER_POLICY }),
      pendingControlEvents: [],
      transferFailures: { download: 0, upload: 0 },
      mlab:
        shadow && options.includeMlab === false
          ? undefined
          : {
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
    await persist(netId);
    await openSegment();
    const serviceGeneration = await executor.start(
      () => {
        withSegment(sessionId => store.touchSession(sessionId)).catch(() =>
          abort?.abort(),
        );
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
            if (!segment && trip.pendingControlEvents?.length)
              await openSegment();
            await closeSegment(trip.reason);
            await persist();
          }
        } catch {
          lastError =
            'Final save needs recovery. Reopen the app before starting another trip.';
        } finally {
          try {
            await Promise.resolve()
              .then(() => native?.release())
              .catch(() => {});
            release?.();
            release = null;
            setTripArmed(false);
          } finally {
            // Collection is already durably closed and its lease released. Keep
            // the same native service alive while its owner becomes the uploader.
            try {
              await foregroundService.handoffToUploads(serviceGeneration);
            } finally {
              running = null;
              publish();
            }
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
  abortProbe('participant_stop');
  abort?.abort();
  cancelTripUpload();
  await running;
}

async function loop(signal: AbortSignal) {
  const stop = new AbortController();
  let controlWake = new AbortController(),
    workerWake = new AbortController();
  let identityAbort: AbortController | null = null;
  let wifi: Wifi | null = null;
  let snapshot: NetworkSnapshot | null = null;
  let identityAt = -Infinity,
    identityDue = 0;
  let identity: {
    publicIp?: string;
    asn?: number;
    reverseDns?: string;
    popCode?: string;
    asnUnavailable?: string;
  } = {};
  let lastControlAt = Date.now(),
    lastElapsed: number | null = null;
  let power: Record<string, number | boolean> | null = null;
  let rotating = false,
    recoveringGap = false;
  let lastHeavyEnd = -Infinity;
  let activity = 'idle';
  let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let drainStartedAt: number | null = null;
  let drainingType: string | null = null;
  const iso = (at = Date.now()) => new Date(at).toISOString();
  const health = () => (trip!.segmentHealth ??= newHealth());
  const ended = () =>
    signal.aborted || stop.signal.aborted || !trip || trip.phase === 'finished';
  const cancel = () => {
    stop.abort();
    abortProbe(trip?.reason ?? 'trip_ended');
    identityAbort?.abort();
    cancelTripUpload();
    controlWake.abort();
    workerWake.abort();
  };
  const fail = () => {
    lastError = 'Collection interrupted; saved observations are retained.';
    if (trip) {
      trip.state = 'interrupted';
      trip.phase = 'finished';
      trip.reason = 'collector_error';
    }
    cancel();
  };
  signal.addEventListener('abort', cancel);
  const networkListener = new NativeEventEmitter(
    NativeModules.FlightNetwork,
  ).addListener(
    'flightNetworkChanged',
    (event?: { handle?: string; lost?: boolean; kind?: string }) => {
      if (event?.kind !== 'capabilities') {
        identity = {};
        identityAt = -Infinity;
        identityDue = 0;
        abortProbe('wifi_changed');
        identityAbort?.abort();
        cancelTripUpload();
      }
      controlWake.abort();
      workerWake.abort();
    },
  );
  const appListener = AppState?.addEventListener?.('change', state => {
    record('collector_lifecycle', { state, observedAt: iso() }).catch(fail);
    controlWake.abort();
    workerWake.abort();
  });

  function beginRotation() {
    if (ended() || rotating || uploading || !trip) return;
    rotating = true;
    drainStartedAt = Date.now();
    drainingType = activity;
    identityAbort?.abort();
    const light = [
      'icmp_burst',
      'udp_echo',
      'tcp_connect',
      'traceroute',
      'idle',
    ].includes(activity);
    if (!light) abortProbe('segment_boundary');
    else
      graceTimer = setTimeout(
        () => abortProbe('segment_boundary'),
        Math.max(
          0,
          trip.nextUploadAt + COLLECTOR_POLICY.boundaryGraceMs - Date.now(),
        ),
      );
    controlWake.abort();
    workerWake.abort();
  }
  function armBoundary() {
    if (boundaryTimer !== undefined) clearTimeout(boundaryTimer);
    if (!ended())
      boundaryTimer = setTimeout(
        beginRotation,
        Math.max(0, trip!.nextUploadAt - Date.now()),
      );
  }
  armBoundary();

  async function control() {
    let nextTick = Date.now();
    while (!ended()) {
      controlWake = new AbortController();
      power = (await native!.runtimeState?.().catch(() => null)) ?? null;
      const now = Date.now();
      const elapsed =
        typeof power?.elapsedRealtimeMs === 'number'
          ? power.elapsedRealtimeMs
          : null;
      const unobserved = Math.max(
        now - lastControlAt,
        elapsed != null && lastElapsed != null ? elapsed - lastElapsed : 0,
      );
      if (unobserved > COLLECTOR_POLICY.gapMs) {
        recoveringGap = true;
        abortProbe('clock_gap');
        const skipped: Record<string, number> = {};
        for (const [type, interval] of Object.entries(INTERVALS)) {
          const due = trip!.due[type];
          if (due != null && due <= now) {
            skipped[type] = Math.floor((now - due) / interval) + 1;
            increment(health().expected, type, skipped[type]);
            increment(health().skips, `late_wakeup:${type}`, skipped[type]);
          }
        }
        trip!.due = resetProbes(now);
        const skippedTransferDirections =
          trip!.pendingTransferPair?.directions.slice() ?? [];
        for (const type of skippedTransferDirections) {
          increment(health().expected, type);
          increment(health().skips, `late_wakeup:${type}`);
        }
        // A reserved pair may straddle a suspension. Preserve its charge but do
        // not replay its remaining direction as soon as the device wakes.
        trip!.pendingTransferPair = undefined;
        if (trip!.nextTransferAt != null && trip!.nextTransferAt <= now)
          trip!.nextTransferAt = advance(
            trip!.nextTransferAt,
            now,
            transferInterval(trip!),
          );
        if (
          trip!.mlab &&
          !trip!.mlab.reserved &&
          (trip!.mlab.dueAt ?? Infinity) <= now
        )
          trip!.mlab.dueAt = now + 60000 + Math.floor(Math.random() * 120000);
        health().gaps++;
        health().unobservedMs += unobserved;
        await record('collector_gap', {
          startedAt: iso(lastControlAt),
          endedAt: iso(now),
          durationMs: unobserved,
          reason: 'late_control_wakeup',
          skipped,
          skippedTransferDirections,
          clock: 'wall_and_android_elapsed_realtime',
          power,
        });
        recoveringGap = false;
      }
      lastControlAt = now;
      lastElapsed = elapsed;
      // Check before network work and before any resumed probe. A suspension can
      // delay handling; record the real handling time rather than backdating it.
      if (now >= trip!.startedAt + trip!.policy.maximumMs) {
        trip!.phase = 'finished';
        trip!.state = 'completed';
        trip!.reason = 'safety_ceiling';
        trip!.endedAt = now;
        await record('collector_deadline', {
          scheduledAt: iso(trip!.startedAt + trip!.policy.maximumMs),
          handledAt: iso(now),
          latenessMs: now - trip!.startedAt - trip!.policy.maximumMs,
        });
        abortProbe('safety_ceiling');
        workerWake.abort();
        break;
      }
      const selected = await native!.bindWifi().catch(() => null);
      if (selected?.handle !== wifi?.handle) {
        identity = {};
        identityAt = -Infinity;
        identityDue = 0;
        await record('collector_route', {
          previousHandle: wifi?.handle ?? null,
          selectedHandle: selected?.handle ?? null,
          observedAt: iso(),
        });
      }
      wifi = selected;
      if (
        wifi?.bound &&
        Date.now() >= identityDue &&
        !uploading &&
        !rotating &&
        reserve(trip!, 'diagnostics', 2048)
      ) {
        const handle = wifi.handle,
          requestedAt = Date.now();
        const requestDeadline = deadline(
          COLLECTOR_POLICY.identityTimeoutMs,
          stop.signal,
        );
        identityAbort = new AbortController();
        const interrupt = () => identityAbort?.abort();
        requestDeadline.signal.addEventListener('abort', interrupt);
        let reason = 'network_error';
        try {
          const response = await fetch(
            `${participantDefaults.serverUrl}/api/v1/context`,
            {
              signal: identityAbort.signal,
              headers: { 'Cache-Control': 'no-cache', Connection: 'close' },
            },
          );
          reason = response.ok ? 'invalid_response' : `http_${response.status}`;
          if (response.ok && response.headers.get('X-Capstone-Probe') === '1') {
            const text = await response.text();
            if (
              text.length <= 2048 &&
              Date.now() - requestedAt <= COLLECTOR_POLICY.identityTimeoutMs &&
              !identityAbort.signal.aborted &&
              (await native!.bindWifi())?.handle === handle
            ) {
              const value = JSON.parse(text);
              if (
                value &&
                typeof value === 'object' &&
                (value.asn == null || Number.isSafeInteger(value.asn)) &&
                (typeof value.observedAt !== 'number' ||
                  Math.abs(Date.now() - value.observedAt * 1000) <=
                    COLLECTOR_POLICY.identityFreshMs)
              ) {
                identity = {
                  publicIp:
                    typeof value.publicIp === 'string'
                      ? value.publicIp
                      : undefined,
                  asn: value.asn ?? undefined,
                  popCode:
                    typeof value.popCode === 'string'
                      ? value.popCode
                      : undefined,
                  reverseDns:
                    typeof value.reverseDns === 'string'
                      ? value.reverseDns
                      : undefined,
                  asnUnavailable:
                    typeof value.asnUnavailable === 'string'
                      ? value.asnUnavailable
                      : undefined,
                };
                identityAt = Date.now();
                reason = 'received';
              }
            }
          }
        } catch {
          reason = requestDeadline.timedOut()
            ? 'timeout'
            : identityAbort.signal.aborted
            ? 'cancelled'
            : reason;
        } finally {
          requestDeadline.signal.removeEventListener('abort', interrupt);
          requestDeadline.dispose();
          identityAbort = null;
        }
        identityDue =
          Date.now() +
          (reason === 'received'
            ? COLLECTOR_POLICY.identityRefreshMs
            : COLLECTOR_POLICY.identityRetryMs);
        await record('collector_identity', {
          requestedAt: iso(requestedAt),
          completedAt: iso(),
          reason,
          duringActivity: activity,
          cachedEvidenceRetained:
            reason !== 'received' &&
            Date.now() - identityAt <= COLLECTOR_POLICY.identityFreshMs,
        });
      }
      if (Date.now() - identityAt > COLLECTOR_POLICY.identityFreshMs)
        identity = {};
      const evidence = evaluate({
        now: Date.now(),
        networkKey: wifi?.bound ? wifi.networkKey : null,
        ssid: wifi?.ssid ?? null,
        asn: identity.asn ?? null,
        identityReason: identity.asnUnavailable,
        identityAt: Number.isFinite(identityAt) ? identityAt : null,
        gps: null,
        allowTestAsns:
          native?.pilotBuild === true && publicConfig.pilotTestAsnsEnabled,
      });
      trip = transition(trip!, evidence);
      const battery = await DeviceInfo.getBatteryLevel().catch(() => -1);
      const charging = await DeviceInfo.isBatteryCharging().catch(() => null);
      if (battery >= 0 && battery <= 0.15 && charging === false) {
        trip.phase = 'finished';
        trip.state = 'completed';
        trip.endedAt = Date.now();
        trip.reason = 'battery';
      }
      snapshot = {
        id: '',
        timestamp: iso(),
        type: wifi?.bound ? 'wifi' : 'none',
        isConnected: !!wifi?.bound,
        ssid: wifi?.ssid ?? null,
        bssid: wifi?.bssid ?? null,
        publicIp: identity.publicIp ?? null,
        asn: identity.asn ?? null,
        publicIpObservedAt: Number.isFinite(identityAt)
          ? iso(identityAt)
          : null,
        batteryPercent: battery < 0 ? null : Math.round(battery * 100),
        isCharging: charging,
        isInternetReachable: wifi?.validated ?? null,
        flightEvidence: evidence,
        popCode: identity.popCode ?? null,
        reverseDns: identity.reverseDns ?? null,
      };
      await withSegment(async id => {
        await store.saveSnapshot(id, snapshot!);
        return true;
      });
      await record('flight_detection', {
        tripId: trip.id,
        policyVersion: DETECTOR_POLICY.version,
        phase: trip.phase,
        shadow: trip.shadow,
        ...evidence,
      });
      await record('collector_heartbeat', {
        observedAt: iso(),
        scheduledAt: iso(nextTick),
        activity,
        power,
        appState: AppState?.currentState ?? 'unknown',
      });
      if (Date.now() >= trip.nextUploadAt) beginRotation();
      if (trip.phase === 'finished') abortProbe(trip.reason ?? 'trip_ended');
      await persist();
      workerWake.abort();
      if (Date.now() + COLLECTOR_POLICY.toleranceMs >= nextTick)
        nextTick = advance(
          nextTick,
          Date.now() + COLLECTOR_POLICY.toleranceMs,
          30000,
        );
      const identityWake =
        wifi?.bound && !uploading && !rotating && identityDue > Date.now()
          ? identityDue
          : Infinity;
      if (!ended())
        await wait(
          Math.max(1, Math.min(nextTick, identityWake) - Date.now()),
          controlWake.signal,
        );
    }
  }

  async function probe(
    type: ProbeType,
    scheduledAt: number,
    paperJob?: PaperJob,
  ): Promise<Measurement | undefined> {
    if (Date.now() >= trip!.nextUploadAt) beginRotation();
    if (
      ended() ||
      rotating ||
      !wifi?.bound ||
      Date.now() >= trip!.startedAt + trip!.policy.maximumMs
    ) {
      increment(health().skips, `control_preempted:${type}`);
      await record('probe_skipped', {
        type,
        reason: ended()
          ? 'trip_ended'
          : rotating
          ? 'segment_boundary'
          : 'wifi_unavailable',
        scheduledAt: iso(scheduledAt),
      });
      return;
    }
    const route = await native!.bindWifi().catch(() => null);
    if (!route?.bound || route.handle !== wifi.handle) {
      increment(health().skips, `wifi_route_changed:${type}`);
      await record('probe_skipped', {
        type,
        reason: 'wifi_route_changed',
        scheduledAt: iso(scheduledAt),
      });
      return;
    }
    const id = segment!;
    const saved = snapshot
      ? await withSegment(sid => store.saveSnapshot(sid, snapshot!))
      : undefined;
    const startPower =
      (await native!.runtimeState?.().catch(() => null)) ?? null;
    if (Date.now() >= trip!.nextUploadAt) beginRotation();
    if (ended() || rotating) return;
    const started = Date.now();
    const attempt = await store.beginAttempt(id, type, iso(scheduledAt));
    const cfg = config();
    cfg.timeoutMs =
      type === 'download' || type === 'upload'
        ? type === 'download' && trip!.policy.downloadTimeoutMs != null
          ? trip!.policy.downloadTimeoutMs
          : transferTimeout(
              type === 'download' ? cfg.downloadBytes : cfg.uploadBytes,
            )
        : Math.min(cfg.timeoutMs, 10000);
    probeAbort = new AbortController();
    probeInterruptionReason = null;
    activity = type;
    // SQLite/native context work can cross a boundary after admission. The
    // durable attempt remains evidence, but must not start fresh network work.
    if (ended()) abortProbe(trip?.reason ?? 'trip_ended');
    else if (rotating || Date.now() >= trip!.nextUploadAt) {
      beginRotation();
      abortProbe('segment_boundary');
    }
    increment(health().started, type);
    health().maxLatenessMs = Math.max(
      health().maxLatenessMs,
      started - scheduledAt,
    );
    const timer = setTimeout(
      () => abortProbe('probe_deadline'),
      paperJob
        ? paperJob.timeoutMs + (paperJob.type === 'traceroute' ? 0 : 2000)
        : type === 'traceroute'
        ? 50000
        : type === 'icmp_burst'
        ? 35000
        : cfg.timeoutMs + 2000,
    );
    try {
      let result = probeAbort.signal.aborted
        ? {
            ...attempt,
            success: false,
            value: null,
            durationMs: 0,
            errorType: 'interrupted' as const,
          }
        : paperJob
        ? await runPaperProbe(
            attempt,
            cfg,
            paperJob,
            route.handle,
            probeAbort.signal,
          )
        : type === 'download' || type === 'upload' || type === 'http_rtt'
        ? await runProbe(type, cfg, id, probeAbort.signal, undefined, attempt)
        : await runDiagnostic(attempt, cfg, probeAbort.signal);
      const callbackAt = Date.now();
      const endPower =
        (await native!.runtimeState?.().catch(() => null)) ?? null;
      const elapsedDuration =
        typeof startPower?.elapsedRealtimeMs === 'number' &&
        typeof endPower?.elapsedRealtimeMs === 'number'
          ? endPower.elapsedRealtimeMs - startPower.elapsedRealtimeMs
          : callbackAt - started;
      const reportedValue = result.value ?? null;
      if (!result.success && probeInterruptionReason)
        result = {
          ...result,
          value: null,
          success: false,
          errorType:
            probeInterruptionReason === 'probe_deadline'
              ? 'timeout'
              : 'interrupted',
          interruptionReason:
            probeInterruptionReason === 'probe_deadline'
              ? undefined
              : probeInterruptionReason,
        };
      const timingValid =
        !Number.isFinite(result.durationMs) ||
        elapsedDuration - result.durationMs <=
          COLLECTOR_POLICY.timingGapToleranceMs;
      if (!timingValid)
        result = {
          ...result,
          success: false,
          value: null,
          errorType: 'interrupted',
          interruptionReason: 'clock_gap',
          errorMessage:
            'Clock or callback gap crossed this attempt; original samples and reported value are retained with scheduling evidence.',
        };
      if (paperJob?.type === 'cdn_fetch' && result.paper)
        result.paper.chargedBytes = paperCharge(result, PAPER_CDN_LIMIT);
      await store.finishAttempt({
        ...result,
        id: attempt.id,
        sessionId: id,
        type,
        scheduledAt: iso(scheduledAt),
        networkSnapshot: saved ?? null,
        scheduling: {
          scheduledAt: iso(scheduledAt),
          startedAt: iso(started),
          callbackAt: iso(callbackAt),
          saveRequestedAt: iso(),
          timingValid,
          reportedValue,
          latenessMs: started - scheduledAt,
          wallDurationMs: callbackAt - started,
          startElapsedRealtimeMs:
            typeof startPower?.elapsedRealtimeMs === 'number'
              ? startPower.elapsedRealtimeMs
              : null,
          endElapsedRealtimeMs:
            typeof endPower?.elapsedRealtimeMs === 'number'
              ? endPower.elapsedRealtimeMs
              : null,
        },
      });
      increment(health().completed, type);
      count++;
      await record('measurement_saved', {
        measurementId: attempt.id,
        type,
        scheduledAt: iso(scheduledAt),
        startedAt: iso(started),
        callbackAt: iso(callbackAt),
        persistedAt: iso(),
        wallDurationMs: Date.now() - started,
      });
      latest = {
        type,
        value: result.value,
        unit: result.unit,
        success: result.success,
        timestamp: result.timestamp,
      };
      if (
        (type === 'download' || type === 'upload') &&
        result.errorType !== 'cancelled' &&
        result.errorType !== 'interrupted'
      ) {
        const failures = (trip!.transferFailures ??= {
          download: 0,
          upload: 0,
        });
        failures[type] = result.success ? 0 : failures[type] + 1;
        if (failures[type] === 2)
          await record('transfer_disabled', {
            type,
            reason: 'two_consecutive_failures',
            scope: 'this_trip',
          });
      }
      publish();
      return result;
    } finally {
      clearTimeout(timer);
      probeAbort = null;
      activity = 'idle';
    }
  }

  async function worker() {
    while (!ended()) {
      workerWake = new AbortController();
      const now = Date.now();
      if (
        now >= trip!.startedAt + trip!.policy.maximumMs ||
        recoveringGap ||
        now - lastControlAt > COLLECTOR_POLICY.gapMs
      ) {
        controlWake.abort();
        await wait(250, workerWake.signal);
        continue;
      }
      if (rotating || now >= trip!.nextUploadAt) {
        beginRotation();
        if (boundaryTimer !== undefined) clearTimeout(boundaryTimer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        identityAbort?.abort();
        const scheduled = trip!.nextUploadAt,
          rotationStarted = Date.now();
        trip!.nextUploadAt = advance(
          scheduled,
          rotationStarted,
          trip!.policy.uploadMs,
        );
        if (drainStartedAt != null && drainingType !== 'idle')
          await record('segment_drain', {
            scheduledAt: iso(scheduled),
            startedAt: iso(drainStartedAt),
            endedAt: iso(rotationStarted),
            durationMs: rotationStarted - drainStartedAt,
            graceLimitMs: COLLECTOR_POLICY.boundaryGraceMs,
            type: drainingType,
            reason:
              probeInterruptionReason === 'segment_boundary'
                ? 'grace_expired_or_heavy'
                : 'completed_before_close',
          });
        await closeSegment('periodic_upload');
        await persist();
        release?.();
        release = null;
        const started = Date.now();
        const uploadDeadline = started + COLLECTOR_POLICY.uploadPauseMs;
        uploading = true;
        activity = 'upload';
        publish();
        let outcome = 'deferred_connectivity';
        try {
          const uploadRoute = await native!.bindWifi().catch(() => null);
          if (uploadRoute?.bound && uploadRoute.validated) {
            const result = await uploadTrip(
              trip!,
              true,
              true,
              persist,
              details => record('collector_upload_request', details),
              { deadline: uploadDeadline, signal: stop.signal },
            );
            outcome =
              result?.outcome === 'failed'
                ? 'pending_retry'
                : ended()
                ? 'opportunity_cancelled'
                : 'opportunity_finished';
          }
        } catch (error) {
          outcome =
            (error as { code?: string })?.code === 'UPLOAD_ALLOWANCE'
              ? 'deferred_allowance'
              : 'pending_retry';
          lastError = 'Upload pending; measurements continue.';
        } finally {
          uploading = false;
          activity = 'idle';
          release = acquireActivity('measurement');
          publish();
        }
        const endedAt = Date.now();
        if (!ended()) await openSegment();
        await record('upload_pause', {
          startedAt: iso(started),
          endedAt: iso(endedAt),
          durationMs: endedAt - started,
          scheduledAt: iso(scheduled),
          latenessMs: started - scheduled,
          limitMs: COLLECTOR_POLICY.uploadPauseMs,
          outcome,
        });
        rotating = false;
        drainStartedAt = null;
        drainingType = null;
        armBoundary();
        continue;
      }
      if (
        !wifi?.bound ||
        !(trip!.shadow || trip!.phase === 'collecting') ||
        !snapshot
      ) {
        await wait(1000, workerWake.signal);
        continue;
      }
      const paper = isPaperPolicy(trip!.policy.version);
      if (!Object.keys(trip!.due).length) trip!.due = resetProbes(now);
      if (paper) delete trip!.due.traceroute;
      if (trip!.shadow && !paper) trip!.nextTransferAt ??= now + 300000;
      if (paper && !trip!.paperSchedule) {
        trip!.paperSchedule = newPaperSchedule(trip!.firstQualifiedAt ?? now);
        await persist();
      }
      const heavyAt = Math.max(
        lastHeavyEnd,
        trip!.paperSchedule?.lastHeavyEnd ?? -Infinity,
      );
      const heavyReady = now - heavyAt >= COLLECTOR_POLICY.heavySpacingMs;
      const lightCandidate = (Object.keys(INTERVALS) as ScheduledProbe[])
        .sort((a, b) => (trip!.due[a] ?? Infinity) - (trip!.due[b] ?? Infinity))
        .find(
          type =>
            (trip!.due[type] ?? Infinity) <= now + COLLECTOR_POLICY.toleranceMs,
        );
      const paperReady = paper
        ? readyPaperJobs(trip!.paperSchedule!, now)
        : { ready: [], skipped: [] };
      const targetHealth = (job: PaperJob) =>
        ((health().byTarget ??= {})[job.key] ??= {
          expected: 0,
          started: 0,
          completed: 0,
          skipped: 0,
        });
      for (const { job, count: missed } of paperReady.skipped) {
        increment(health().expected, job.type, missed);
        increment(health().skips, `busy_deadline:${job.key}`, missed);
        targetHealth(job).expected += missed;
        targetHealth(job).skipped += missed;
        await record('probe_skipped', {
          type: job.type,
          targetId: job.targetId,
          roundId: job.roundId,
          scheduledAt: iso(job.scheduledAt),
          count: missed,
          reason:
            job.type !== 'traceroute' && !wifi?.validated
              ? 'wifi_internet_unvalidated'
              : 'paper_slot_expired',
        });
      }
      if (paperReady.skipped.length) await persist();
      const paperCandidate = paperReady.ready.find(
        job =>
          trip!.nextUploadAt - now >= job.timeoutMs + 2000 &&
          (job.type === 'traceroute' || wifi!.validated) &&
          (job.type !== 'cdn_fetch' || heavyReady),
      );
      const firstDue = Math.min(
        lightCandidate ? trip!.due[lightCandidate]! : Infinity,
        paperCandidate?.scheduledAt ?? Infinity,
      );
      if (trip!.mlab && trip!.mlab.dueAt == null) {
        trip!.mlab.dueAt = now + 60000 + Math.floor(Math.random() * 120000);
        await persist();
      }
      if (
        trip!.mlab &&
        !trip!.mlab.reserved &&
        (trip!.mlab.dueAt ?? Infinity) <= now &&
        wifi.validated &&
        heavyReady &&
        (!paper || (trip!.mlab.dueAt ?? Infinity) <= firstDue)
      ) {
        const route = await native!.bindWifi().catch(() => null);
        if (!route?.bound || route.handle !== wifi.handle) {
          controlWake.abort();
          await wait(1000, workerWake.signal);
          continue;
        }
        trip!.mlab.reserved = true;
        const uncapped = uncappedMlab(trip!.policy.version);
        const allowed =
          uncapped || reserve(trip!, 'transfers', MLAB_RESERVATION);
        trip!.mlab.status = allowed ? 'running' : 'allowance_unavailable';
        await persist();
        if (allowed) {
          probeAbort = new AbortController();
          probeInterruptionReason = null;
          activity = 'mlab';
          try {
            const saved = await withSegment(id =>
              store.saveSnapshot(id, snapshot!),
            );
            if (ended()) abortProbe(trip?.reason ?? 'trip_ended');
            else if (rotating || Date.now() >= trip!.nextUploadAt) {
              beginRotation();
              abortProbe('segment_boundary');
            }
            const results = await runTripMlab(
              store,
              segment!,
              trip!.mlab.consentVersion,
              wifi.handle,
              saved ?? snapshot,
              probeAbort.signal,
              trip!.mlab.dueAt!,
              uncapped,
              () => probeInterruptionReason,
            );
            trip!.mlabUsage = {
              downloadClientBytes:
                results.find(r => r.type === 'ndt7_download')?.reference
                  ?.clientBytes ?? null,
              uploadClientBytes:
                results.find(r => r.type === 'ndt7_upload')?.reference
                  ?.clientBytes ?? null,
            };
            count += results.length;
            latest = results[results.length - 1] ?? latest;
            trip!.mlab.status = results.every(r => r.success)
              ? 'complete'
              : 'incomplete';
          } finally {
            probeAbort = null;
            activity = 'idle';
            lastHeavyEnd = Date.now();
            if (trip!.paperSchedule)
              trip!.paperSchedule.lastHeavyEnd = lastHeavyEnd;
          }
          await persist();
          continue;
        }
      }
      if (
        paperCandidate &&
        paperCandidate.scheduledAt <=
          (lightCandidate ? trip!.due[lightCandidate]! : Infinity)
      ) {
        const job = paperCandidate;
        trip!.paperSchedule!.completed.push(job.key);
        const key = `${job.roundId}:${job.key}`;
        const allowed =
          job.type === 'cdn_fetch'
            ? reserveContent(trip!, key, PAPER_CDN_LIMIT)
            : reserve(
                trip!,
                'diagnostics',
                job.type === 'dns_resolver'
                  ? PAPER_DNS_LIMIT
                  : requestedPayload('traceroute', config()),
              );
        increment(health().expected, job.type);
        targetHealth(job).expected++;
        if (!allowed) {
          targetHealth(job).skipped++;
          increment(health().skips, `allowance:${job.key}`);
          await record('probe_skipped', {
            type: job.type,
            targetId: job.targetId,
            roundId: job.roundId,
            reason:
              job.type === 'cdn_fetch'
                ? 'content_allowance'
                : 'diagnostic_allowance',
          });
          await persist();
          continue;
        }
        await persist();
        let result: Measurement | undefined;
        let returned = false;
        try {
          targetHealth(job).started++;
          result = await probe(job.type, job.scheduledAt, job);
          returned = true;
          if (result) targetHealth(job).completed++;
          else targetHealth(job).skipped++;
        } finally {
          if (job.type === 'cdn_fetch') {
            settleContent(
              trip!,
              key,
              returned && !result ? 0 : paperCharge(result, PAPER_CDN_LIMIT),
            );
            lastHeavyEnd = Date.now();
            trip!.paperSchedule!.lastHeavyEnd = lastHeavyEnd;
          }
          await persist();
        }
        continue;
      }
      const candidate = lightCandidate;
      if (candidate) {
        const slot = takeDue(trip!.due[candidate]!, now, INTERVALS[candidate])!;
        trip!.due[candidate] = slot.next;
        increment(health().expected, candidate, slot.skipped + 1);
        if (slot.skipped) {
          increment(health().skips, `busy_deadline:${candidate}`, slot.skipped);
          await record('probe_skipped', {
            type: candidate,
            count: slot.skipped,
            reason: 'busy_deadline',
            scheduledAt: iso(slot.scheduledAt),
          });
        }
        if (
          reserve(trip!, 'diagnostics', requestedPayload(candidate, config()))
        ) {
          await persist();
          await probe(candidate, slot.scheduledAt);
        } else {
          increment(health().skips, `allowance:${candidate}`);
          await record('probe_skipped', {
            type: candidate,
            reason: 'diagnostic_allowance',
          });
        }
        continue;
      }
      if (paper) {
        await wait(1000, workerWake.signal);
        continue;
      }
      const directions = (['download', 'upload'] as const).filter(
        type => (trip!.transferFailures?.[type] ?? 0) < 2,
      );
      if (
        !trip!.pendingTransferPair &&
        wifi.validated &&
        heavyReady &&
        directions.length &&
        trip!.nextTransferAt != null &&
        now + COLLECTOR_POLICY.toleranceMs >= trip!.nextTransferAt
      ) {
        const scheduledAt = trip!.nextTransferAt;
        if (
          reservePair(trip!, now + COLLECTOR_POLICY.toleranceMs, directions)
        ) {
          trip!.pendingTransferPair = { scheduledAt, directions };
          await persist();
        }
      }
      if (trip!.pendingTransferPair && wifi.validated && heavyReady) {
        const pending = trip!.pendingTransferPair;
        const type = pending.directions.shift();
        // Persist dequeue before beginning: interruptions cannot repeat a reserved direction.
        await persist();
        if (type) {
          increment(health().expected, type);
          await probe(type, pending.scheduledAt);
        }
        if (!pending.directions.length) {
          trip!.pendingTransferPair = undefined;
          lastHeavyEnd = Date.now();
        }
        await persist();
        continue;
      }
      await wait(1000, workerWake.signal);
    }
  }

  const controller = control().catch(fail);
  try {
    await worker();
  } finally {
    if (boundaryTimer !== undefined) clearTimeout(boundaryTimer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    cancel();
    await controller;
    networkListener.remove();
    appListener?.remove();
    signal.removeEventListener('abort', cancel);
    await segmentLane;
    await persistenceLane;
  }
}
