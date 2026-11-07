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
  | {
      bindWifi(): Promise<Wifi | null>;
      release(): Promise<void>;
      runtimeState?(): Promise<Record<string, number | boolean>>;
    }
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
let persistenceLane: Promise<unknown> = Promise.resolve();
let segmentLane: Promise<unknown> = Promise.resolve();
function withSegment<T>(
  task: (id: string) => Promise<T>,
): Promise<T | undefined> {
  const work = segmentLane.then(() => (segment ? task(segment) : undefined));
  segmentLane = work.catch(() => {});
  return work;
}
async function persist() {
  if (!trip) return;
  trip.revision++;
  const snapshot = JSON.parse(JSON.stringify(trip)) as Trip;
  const work = persistenceLane.then(() => store.saveTrip(snapshot));
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
  collectorVersion: 'skymeasure-libraries-2',
  collectorPolicy: COLLECTOR_POLICY,
  streamDownloads: true,
  httpEnabled: true,
  referenceByteThreshold: 90 * 1048576,
  maxDurationMs: TRIP_POLICY.maximumMs,
  maxPayloadBytes:
    t.policy.transferBytes +
    t.policy.diagnosticBytes +
    t.policy.liveUploadBytes,
  downloadBytes: TRIP_POLICY.downloadBytes,
  uploadBytes: TRIP_POLICY.uploadBytes,
  tracerouteMaxHops: 20,
  loadedLatencyEnabled: false,
  tripId: t.id,
  segmentIndex: t.segmentCount,
  flight: t.flight,
  flightPolicy: t.policy,
  mlabPolicy: t.mlab
    ? {
        consentVersion: t.mlab.consentVersion,
        reservationBytes: MLAB_RESERVATION,
        byteThresholdPerDirection: 90 * 1048576,
        maximumPairsPerTrip: 1,
        maximumPairsPerDay: 4,
      }
    : undefined,
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
  options: { includeMlab?: boolean } = {},
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
      collectorPolicy: COLLECTOR_POLICY.version,
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
    await persist();
    await openSegment();
    await executor.start(
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
  const stop = new AbortController();
  let controlWake = new AbortController(),
    workerWake = new AbortController();
  let identityAbort: AbortController | null = null;
  let wifi: Wifi | null = null;
  let snapshot: NetworkSnapshot | null = null;
  let gps: GpsEvidence | null = null;
  let gpsAt = -Infinity,
    identityAt = -Infinity,
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
  const iso = (at = Date.now()) => new Date(at).toISOString();
  const health = () => (trip!.segmentHealth ??= newHealth());
  const ended = () =>
    signal.aborted || stop.signal.aborted || !trip || trip.phase === 'finished';
  const cancel = () => {
    stop.abort();
    probeAbort?.abort();
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
        gps = null;
        probeAbort?.abort();
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
        probeAbort?.abort();
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
        if (trip!.nextTransferAt != null && trip!.nextTransferAt <= now)
          trip!.nextTransferAt = advance(
            trip!.nextTransferAt,
            now,
            Math.max(
              300000,
              ((trip!.flight.expectedMinutes ?? 1440) * 60000) / 10,
            ),
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
        probeAbort?.abort();
        workerWake.abort();
        break;
      }
      const selected = await native!.bindWifi().catch(() => null);
      if (selected?.handle !== wifi?.handle) {
        identity = {};
        identityAt = -Infinity;
        identityDue = 0;
        gps = null;
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
        gps = await locationFix(stop.signal);
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
        policyVersion: trip.policy.version,
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
      if (Date.now() >= trip.nextUploadAt) {
        rotating = true;
        probeAbort?.abort();
      }
      if (trip.phase === 'finished') probeAbort?.abort();
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

  async function probe(type: ProbeType, scheduledAt: number) {
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
    if (ended() || rotating) return;
    const started = Date.now();
    const attempt = await store.beginAttempt(id, type, iso(scheduledAt));
    const cfg = config();
    cfg.timeoutMs =
      type === 'download' || type === 'upload'
        ? transferTimeout(
            type === 'download' ? cfg.downloadBytes : cfg.uploadBytes,
          )
        : Math.min(cfg.timeoutMs, 10000);
    probeAbort = new AbortController();
    activity = type;
    increment(health().started, type);
    health().maxLatenessMs = Math.max(
      health().maxLatenessMs,
      started - scheduledAt,
    );
    const timer = setTimeout(
      () => probeAbort?.abort(),
      type === 'traceroute'
        ? 50000
        : type === 'icmp_burst'
        ? 35000
        : cfg.timeoutMs + 2000,
    );
    try {
      let result =
        type === 'download' || type === 'upload' || type === 'http_rtt'
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
          errorMessage:
            'Clock or callback gap crossed this attempt; original samples and reported value are retained with scheduling evidence.',
        };
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
        rotating = true;
        identityAbort?.abort();
        const scheduled = trip!.nextUploadAt,
          started = Date.now();
        trip!.nextUploadAt = advance(scheduled, started, trip!.policy.uploadMs);
        await closeSegment('periodic_upload');
        await persist();
        release?.();
        release = null;
        uploading = true;
        activity = 'upload';
        publish();
        let outcome = 'deferred_connectivity';
        try {
          if (wifi?.bound && wifi.validated) {
            await uploadTrip(trip!, true, true, persist, details =>
              record('collector_upload_request', details),
            );
            outcome = 'opportunity_finished';
          }
        } catch {
          outcome = 'pending_retry';
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
      if (!Object.keys(trip!.due).length) trip!.due = resetProbes(now);
      if (trip!.shadow) trip!.nextTransferAt ??= now + 300000;
      if (trip!.mlab && trip!.mlab.dueAt == null) {
        trip!.mlab.dueAt = now + 60000 + Math.floor(Math.random() * 120000);
        await persist();
      }
      const heavyReady = now - lastHeavyEnd >= COLLECTOR_POLICY.heavySpacingMs;
      if (
        trip!.mlab &&
        !trip!.mlab.reserved &&
        (trip!.mlab.dueAt ?? Infinity) <= now &&
        wifi.validated &&
        heavyReady
      ) {
        const route = await native!.bindWifi().catch(() => null);
        if (!route?.bound || route.handle !== wifi.handle) {
          controlWake.abort();
          await wait(1000, workerWake.signal);
          continue;
        }
        trip!.mlab.reserved = true;
        const allowed = reserve(trip!, 'transfers', MLAB_RESERVATION);
        trip!.mlab.status = allowed ? 'running' : 'allowance_unavailable';
        await persist();
        if (allowed) {
          probeAbort = new AbortController();
          activity = 'mlab';
          try {
            const saved = await withSegment(id =>
              store.saveSnapshot(id, snapshot!),
            );
            const results = await runTripMlab(
              store,
              segment!,
              trip!.mlab.consentVersion,
              wifi.handle,
              saved ?? snapshot,
              probeAbort.signal,
              trip!.mlab.dueAt!,
            );
            count += results.length;
            latest = results[results.length - 1] ?? latest;
            trip!.mlab.status = results.every(r => r.success)
              ? 'complete'
              : 'incomplete';
          } finally {
            probeAbort = null;
            activity = 'idle';
            lastHeavyEnd = Date.now();
          }
          await persist();
          continue;
        }
      }
      const candidate = (Object.keys(INTERVALS) as ScheduledProbe[])
        .sort((a, b) => (trip!.due[a] ?? Infinity) - (trip!.due[b] ?? Infinity))
        .find(
          type =>
            (trip!.due[type] ?? Infinity) <= now + COLLECTOR_POLICY.toleranceMs,
        );
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
    cancel();
    await controller;
    networkListener.remove();
    appListener?.remove();
    signal.removeEventListener('abort', cancel);
    await segmentLane;
    await persistenceLane;
  }
}
