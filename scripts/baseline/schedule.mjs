/**
 * The app's collection loop, driven by terminal tools instead of phone libraries.
 *
 * Timing rules are imported from the app, so a policy change there changes the
 * baseline too. The control flow mirrors loop() in src/trips/runtime.ts; keep the
 * two in step. The clock is injected so hours of schedule can be tested in seconds.
 */
import {
  COLLECTOR_POLICY,
  INTERVALS,
  advance,
  increment,
  newHealth,
  resetProbes,
  takeDue,
  transferTimeout,
} from '../../src/trips/scheduler.ts';
import {
  HOURLY_TRANSFER_POLICY,
  PILOT_TRIP_POLICY,
  PAPER_TRIP_POLICY,
  isPaperPolicy,
  reserveContent,
  settleContent,
  reserve,
  reservePair,
  transferInterval,
} from '../../src/trips/model.ts';
import {
  PAPER_CDN_LIMIT,
  PAPER_DNS_LIMIT,
  newPaperSchedule,
  readyPaperJobs,
  paperJobs,
} from '../../src/measurements/paperSuite.ts';
import { requestedPayload } from '../../src/measurements/diagnosticConfig.ts';

export const CONTROL_TICK_MS = 30000;
/**
 * The detector needs two matches at least 30 s apart, checked on 30 s ticks. The first
 * match lands just after a tick, so phones qualify on the third: both automatic trips
 * in the 21 November exports recorded their first probe 60 s after Start.
 */
export const QUALIFICATION_MS = 60000;
/** Median of 53 upload pauses in saved phone exports (range 0.4-31 s). */
export const DEFAULT_UPLOAD_PAUSE_MS = 22000;
export const PAIRED_SHIFT_MS = 30000;
export const PAIRED_MLAB_MS = 225000;
export const PAIRED_TRANSFER_MS = 450000;
/** Same limits probe() applies in the app. */
export const PROBE_TIMEOUT_MS = 10000;
const TRACEROUTE_LIMIT_MS = 50000;
const ICMP_BURST_LIMIT_MS = 35000;
const DIAGNOSTIC_CONFIG = { tracerouteMaxHops: 20 };

/**
 * Extra probes the app does not run. They start only if they cannot delay an app probe.
 * The router comes first: it shows whether loss is already present on the local network.
 */
export const CONTROLS = {
  control_gateway: { offsetMs: 22000, intervalMs: 60000, worstCaseMs: 25000 },
  control_icmp: { offsetMs: 23000, intervalMs: 60000, worstCaseMs: 25000 },
  control_tcp: { offsetMs: 24000, intervalMs: 60000, worstCaseMs: 11000 },
};

/**
 * Interleave with a phone that qualified at phoneAt: light probes 30 s apart, heavy
 * tests outside the phone's own M-Lab (+1 to +3.5 min) and transfer (+5 to +7 min) windows.
 */
export function pairedTimes(phoneAt, now) {
  const steps = Math.max(
    0,
    Math.ceil((now + 2000 - phoneAt - PAIRED_SHIFT_MS) / 60000),
  );
  const qualifiedAt = phoneAt + PAIRED_SHIFT_MS + steps * 60000;
  // Phone pairs start at +5 min, then hourly. Keep 2.5 min clear on either side.
  const clear = at => {
    const phase = (((at - phoneAt - 300000) % 3600000) + 3600000) % 3600000;
    if (phase < 150000) return at + 150000 - phase;
    if (phase > 3600000 - 150000) return at + 3600000 - phase + 150000;
    return at;
  };
  return {
    qualifiedAt,
    mlabDueAt:
      qualifiedAt + 20000 <= phoneAt + PAIRED_MLAB_MS
        ? phoneAt + PAIRED_MLAB_MS
        : clear(qualifiedAt + 20000),
    transferAt: clear(
      Math.max(phoneAt + PAIRED_TRANSFER_MS, qualifiedAt + 60000),
    ),
  };
}

/**
 * deps.clock: { now(), mono(), wait(ms, signal) }
 * deps.run(type, { scheduledAt, timeoutMs, signal }): resolves to a result, never rejects
 * deps.identity({ timeoutMs, signal }): resolves to true when a context reply was received
 * deps.sink: { openSegment, closeSegment, event, save }
 */
export async function runSchedule(deps, options) {
  const { clock, sink } = deps;
  const { durationMs, signal: external } = options;
  // Historical reference fixtures explicitly supply their collected policy.
  const policy = options.policy ?? PAPER_TRIP_POLICY;
  const paper = isPaperPolicy(policy.version);
  const collector = options.collectorPolicy ?? COLLECTOR_POLICY;
  const uploadPauseMs = options.uploadPauseMs ?? DEFAULT_UPLOAD_PAUSE_MS;
  const random = options.random ?? Math.random;
  const iso = (at = clock.now()) => new Date(at).toISOString();
  const startedAt = clock.now();
  const stopAt = startedAt + Math.min(durationMs, policy.maximumMs);
  const qualifiedAt =
    options.paired?.qualifiedAt ?? startedAt + QUALIFICATION_MS;
  const trip = {
    startedAt,
    endedAt: null,
    phase: 'watching',
    reason: null,
    flight: {},
    policy,
    ...(paper
      ? {
          measurementSuiteVersion: 'paper-core-v1',
          paperSchedule: newPaperSchedule(qualifiedAt),
        }
      : { transferSchedule: HOURLY_TRANSFER_POLICY }),
    contentReservations: {},
    used: { transfers: 0, diagnostics: 0, uploads: 0 },
    transferPairs: 0,
    nextTransferAt: null,
    nextUploadAt: startedAt + policy.uploadMs,
    due: {},
    controlDue: {},
    transferFailures: { download: 0, upload: 0 },
    pendingTransferPair: undefined,
    mlab: options.mlab
      ? { dueAt: null, reserved: false, status: 'waiting' }
      : undefined,
    segmentCount: 0,
  };
  let health = newHealth();
  const stop = new AbortController();
  let controlWake = new AbortController();
  let workerWake = new AbortController();
  let probeAbort = null;
  let identityAbort = null;
  let identityDue = 0;
  let uploading = false;
  let rotating = false;
  let recoveringGap = false;
  let lastControlAt = clock.now();
  let lastHeavyEnd = -Infinity;
  let activeType = 'idle';
  let interruptionReason = null;
  let boundaryWake = new AbortController(),
    graceWake = new AbortController();
  function beginRotation() {
    if (ended() || rotating || uploading) return;
    rotating = true;
    const light = [
      'idle',
      'icmp_burst',
      'udp_echo',
      'tcp_connect',
      'traceroute',
    ].includes(activeType);
    if (!light || !collector.boundaryGraceMs) {
      if (probeAbort) {
        interruptionReason = 'segment_boundary';
        probeAbort.abort();
      }
    } else {
      const grace = (graceWake = new AbortController());
      clock
        .wait(
          Math.max(
            0,
            trip.nextUploadAt + collector.boundaryGraceMs - clock.now(),
          ),
          grace.signal,
        )
        .then(() => {
          if (!grace.signal.aborted && probeAbort) {
            interruptionReason = 'segment_boundary';
            probeAbort.abort();
          }
        });
    }
    workerWake.abort();
    controlWake.abort();
  }
  function armBoundary() {
    boundaryWake.abort();
    if (!collector.boundaryGraceMs || ended()) return;
    const wake = (boundaryWake = new AbortController());
    clock
      .wait(Math.max(0, trip.nextUploadAt - clock.now()), wake.signal)
      .then(() => {
        if (!wake.signal.aborted && !ended()) beginRotation();
      });
  }
  const ended = () => stop.signal.aborted || trip.phase === 'finished';
  const finish = reason => {
    if (trip.phase === 'finished') return;
    trip.phase = 'finished';
    trip.reason = reason;
    trip.endedAt = clock.now();
    probeAbort?.abort();
    identityAbort?.abort();
    controlWake.abort();
    workerWake.abort();
    stop.abort();
  };
  const onExternal = () => finish('operator_stop');
  external?.addEventListener('abort', onExternal);

  let segmentOpen = false;
  async function openSegment() {
    health = newHealth();
    await sink.openSegment(trip.segmentCount++);
    segmentOpen = true;
  }
  async function closeSegment(reason) {
    if (!segmentOpen) return;
    await sink.event('segment_health', {
      policyVersion: COLLECTOR_POLICY.version,
      ...health,
      observedEndAt: iso(),
    });
    await sink.event('trip_segment_closed', {
      reason,
      budgets: { ...trip.used },
    });
    await sink.closeSegment(reason);
    segmentOpen = false;
  }

  async function handleGap(now) {
    recoveringGap = true;
    probeAbort?.abort();
    const skipped = {};
    for (const [type, interval] of Object.entries(INTERVALS)) {
      const due = trip.due[type];
      if (due != null && due <= now) {
        skipped[type] = Math.floor((now - due) / interval) + 1;
        increment(health.expected, type, skipped[type]);
        increment(health.skips, `late_wakeup:${type}`, skipped[type]);
      }
    }
    if (Object.keys(trip.due).length) trip.due = resetProbes(now);
    trip.controlDue = {};
    const directions = trip.pendingTransferPair?.directions.slice() ?? [];
    for (const type of directions) {
      increment(health.expected, type);
      increment(health.skips, `late_wakeup:${type}`);
    }
    trip.pendingTransferPair = undefined;
    if (trip.nextTransferAt != null && trip.nextTransferAt <= now)
      trip.nextTransferAt = advance(
        trip.nextTransferAt,
        now,
        transferInterval(trip),
      );
    if (
      trip.mlab &&
      !trip.mlab.reserved &&
      (trip.mlab.dueAt ?? Infinity) <= now
    )
      trip.mlab.dueAt = now + 60000 + Math.floor(random() * 120000);
    health.gaps++;
    health.unobservedMs += now - lastControlAt;
    await sink.event('collector_gap', {
      startedAt: iso(lastControlAt),
      endedAt: iso(now),
      durationMs: now - lastControlAt,
      reason: 'late_control_wakeup',
      skipped,
      skippedTransferDirections: directions,
    });
    recoveringGap = false;
  }

  async function control() {
    let nextTick = clock.now();
    while (!ended()) {
      controlWake = new AbortController();
      const now = clock.now();
      if (now - lastControlAt > COLLECTOR_POLICY.gapMs) await handleGap(now);
      lastControlAt = now;
      if (now >= stopAt) {
        finish(
          durationMs >= PILOT_TRIP_POLICY.maximumMs
            ? 'safety_ceiling'
            : 'duration_reached',
        );
        break;
      }
      if (now >= qualifiedAt && trip.phase === 'watching') {
        trip.phase = 'collecting';
        trip.nextTransferAt = paper
          ? null
          : options.paired?.transferAt ?? qualifiedAt + 300000;
        await sink.event('baseline_collecting', {
          observedAt: iso(now),
          qualifiedAt: iso(qualifiedAt),
          assumed: true,
        });
      }
      if (
        now >= identityDue &&
        !uploading &&
        !rotating &&
        reserve(trip, 'diagnostics', 2048)
      ) {
        identityAbort = new AbortController();
        let received = false;
        try {
          received = await deps.identity({
            timeoutMs: COLLECTOR_POLICY.identityTimeoutMs,
            signal: identityAbort.signal,
          });
        } finally {
          identityAbort = null;
        }
        identityDue =
          clock.now() +
          (received
            ? COLLECTOR_POLICY.identityRefreshMs
            : COLLECTOR_POLICY.identityRetryMs);
      }
      if (clock.now() >= trip.nextUploadAt) beginRotation();
      workerWake.abort();
      if (clock.now() + COLLECTOR_POLICY.toleranceMs >= nextTick)
        nextTick = advance(
          nextTick,
          clock.now() + COLLECTOR_POLICY.toleranceMs,
          CONTROL_TICK_MS,
        );
      const wakes = [nextTick, stopAt];
      if (trip.phase === 'watching') wakes.push(qualifiedAt);
      if (!uploading && !rotating && identityDue > clock.now())
        wakes.push(identityDue);
      if (!ended())
        await clock.wait(
          Math.max(1, Math.min(...wakes) - clock.now()),
          controlWake.signal,
        );
    }
  }

  async function probe(type, scheduledAt, paperJob) {
    if (clock.now() >= trip.nextUploadAt) beginRotation();
    if (ended() || rotating) {
      increment(health.skips, `control_preempted:${type}`);
      await sink.event('probe_skipped', {
        type,
        reason: ended() ? 'trip_ended' : 'segment_boundary',
        scheduledAt: iso(scheduledAt),
      });
      return null;
    }
    const isTransfer = type === 'download' || type === 'upload';
    const timeoutMs =
      paperJob?.timeoutMs ??
      (isTransfer
        ? type === 'download' && policy.downloadTimeoutMs != null
          ? policy.downloadTimeoutMs
          : transferTimeout(
              type === 'download'
                ? trip.policy.downloadBytes
                : trip.policy.uploadBytes,
            )
        : PROBE_TIMEOUT_MS);
    const limitMs = paperJob
      ? paperJob.timeoutMs + (type === 'traceroute' ? 0 : 2000)
      : type === 'traceroute'
      ? TRACEROUTE_LIMIT_MS
      : ['icmp_burst', 'control_icmp', 'control_gateway'].includes(type)
      ? ICMP_BURST_LIMIT_MS
      : timeoutMs + 2000;
    const results = await execute(
      [type],
      scheduledAt,
      timeoutMs,
      limitMs,
      paperJob,
    );
    const result = results[0];
    if (
      isTransfer &&
      result &&
      result.errorType !== 'cancelled' &&
      result.errorType !== 'interrupted'
    ) {
      trip.transferFailures[type] = result.success
        ? 0
        : trip.transferFailures[type] + 1;
      if (trip.transferFailures[type] === 2)
        await sink.event('transfer_disabled', {
          type,
          reason: 'two_consecutive_failures',
          scope: 'this_trip',
        });
    }
    return result;
  }

  /** M-Lab is one run with two results; everything else is one run with one. */
  async function execute(types, scheduledAt, timeoutMs, limitMs, paperJob) {
    const isControl = types[0].startsWith('control_');
    const started = clock.now();
    const startedMono = clock.mono();
    if (!isControl) {
      for (const type of types) increment(health.started, type);
      health.maxLatenessMs = Math.max(
        health.maxLatenessMs,
        started - scheduledAt,
      );
    }
    const abort = new AbortController();
    const done = new AbortController();
    probeAbort = abort;
    activeType = types[0];
    interruptionReason = null;
    clock.wait(limitMs, done.signal).then(() => {
      if (!done.signal.aborted) abort.abort();
    });
    let outcome;
    try {
      outcome = await deps.run(types[0], {
        scheduledAt,
        timeoutMs,
        paperJob,
        signal: abort.signal,
      });
    } finally {
      done.abort();
      probeAbort = null;
      activeType = 'idle';
    }
    const callbackAt = clock.now();
    const wallDurationMs = callbackAt - started;
    // Wall and monotonic time disagree if the computer slept during the attempt.
    const monoDurationMs = clock.mono() - startedMono;
    const timingValid =
      Math.abs(wallDurationMs - monoDurationMs) <=
      COLLECTOR_POLICY.timingGapToleranceMs;
    const results = (Array.isArray(outcome) ? outcome : [outcome]).map(
      result => ({
        ...result,
        ...(!result.success && interruptionReason
          ? { errorType: 'interrupted', interruptionReason, value: null }
          : {}),
        ...(timingValid
          ? {}
          : {
              success: false,
              value: null,
              errorType: 'interrupted',
              errorMessage:
                'Clock gap crossed this attempt; original samples are retained.',
            }),
        scheduledAt: iso(scheduledAt),
        scheduling: {
          scheduledAt: iso(scheduledAt),
          startedAt: iso(started),
          callbackAt: iso(callbackAt),
          saveRequestedAt: iso(),
          timingValid,
          reportedValue: result.value ?? null,
          latenessMs: started - scheduledAt,
          wallDurationMs,
          startElapsedRealtimeMs: startedMono,
          endElapsedRealtimeMs: startedMono + monoDurationMs,
        },
      }),
    );
    for (const result of results) {
      if (!isControl) increment(health.completed, result.type);
      await sink.save(result, isControl);
    }
    return results;
  }

  function dueControl(now) {
    const enabled =
      options.controls === true
        ? Object.keys(CONTROLS)
        : options.controls || [];
    if (!enabled.length) return null;
    for (const [type, spec] of Object.entries(CONTROLS))
      trip.controlDue[type] ??= now + spec.offsetMs;
    const nextApp = Math.min(
      ...Object.values(trip.due),
      ...(paper
        ? paperJobs(qualifiedAt, trip.paperSchedule.roundIndex)
            .filter(j => !trip.paperSchedule.completed.includes(j.key))
            .map(j => j.scheduledAt)
        : []),
      trip.nextTransferAt ?? Infinity,
      trip.mlab && !trip.mlab.reserved ? trip.mlab.dueAt ?? Infinity : Infinity,
      trip.nextUploadAt,
    );
    for (const type of enabled) {
      const spec = CONTROLS[type];
      const slot = takeDue(trip.controlDue[type], now, spec.intervalMs);
      if (!slot) continue;
      trip.controlDue[type] = slot.next;
      if (nextApp - now >= spec.worstCaseMs)
        return { type, at: slot.scheduledAt };
    }
    return null;
  }

  async function worker() {
    while (!ended()) {
      workerWake = new AbortController();
      const now = clock.now();
      if (recoveringGap || now - lastControlAt > COLLECTOR_POLICY.gapMs) {
        controlWake.abort();
        await clock.wait(250, workerWake.signal);
        continue;
      }
      if (rotating || now >= trip.nextUploadAt) {
        beginRotation();
        boundaryWake.abort();
        graceWake.abort();
        identityAbort?.abort();
        const scheduled = trip.nextUploadAt;
        trip.nextUploadAt = advance(scheduled, now, trip.policy.uploadMs);
        await closeSegment('periodic_upload');
        uploading = true;
        // Control wakes must not shorten the gap; only the end of the run may.
        await clock.wait(uploadPauseMs, stop.signal);
        uploading = false;
        const endedAt = clock.now();
        if (!ended()) await openSegment();
        await sink.event('upload_pause', {
          startedAt: iso(now),
          endedAt: iso(endedAt),
          durationMs: endedAt - now,
          scheduledAt: iso(scheduled),
          latenessMs: now - scheduled,
          limitMs: COLLECTOR_POLICY.uploadPauseMs,
          outcome: 'simulated_pause',
          simulated: true,
        });
        rotating = false;
        armBoundary();
        continue;
      }
      if (trip.phase !== 'collecting') {
        await clock.wait(1000, workerWake.signal);
        continue;
      }
      if (!Object.keys(trip.due).length) {
        // The app starts its offsets when the worker first sees qualification.
        trip.due = resetProbes(now);
        for (const [type, spec] of Object.entries(CONTROLS))
          trip.controlDue[type] = now + spec.offsetMs;
      }
      if (paper) delete trip.due.traceroute;
      const paperReady = paper
        ? readyPaperJobs(trip.paperSchedule, now)
        : { ready: [], skipped: [] };
      for (const { job, count } of paperReady.skipped) {
        increment(health.expected, job.type, count);
        increment(health.skips, `busy_deadline:${job.key}`, count);
        await sink.event('probe_skipped', {
          type: job.type,
          targetId: job.targetId,
          roundId: job.roundId,
          reason: 'paper_slot_expired',
          count,
        });
      }
      const lightTime = Math.min(...Object.values(trip.due));
      if (trip.mlab && trip.mlab.dueAt == null)
        trip.mlab.dueAt =
          options.paired?.mlabDueAt ??
          now + 60000 + Math.floor(random() * 120000);
      const heavyReady = now - lastHeavyEnd >= COLLECTOR_POLICY.heavySpacingMs;
      if (
        trip.mlab &&
        !trip.mlab.reserved &&
        trip.mlab.dueAt <= now &&
        heavyReady &&
        (!paper ||
          Math.min(lightTime, paperReady.ready[0]?.scheduledAt ?? Infinity) >=
            trip.mlab.dueAt)
      ) {
        trip.mlab.reserved = true;
        const results = await execute(
          ['ndt7_download', 'ndt7_upload'],
          trip.mlab.dueAt,
          60000,
          60000,
        );
        trip.mlab.status = results.every(r => r.success)
          ? 'complete'
          : 'incomplete';
        lastHeavyEnd = clock.now();
        continue;
      }
      const paperCandidate = paperReady.ready.find(
        j =>
          now + j.timeoutMs + 2000 <= trip.nextUploadAt &&
          (j.type !== 'cdn_fetch' || heavyReady),
      );
      if (paperCandidate && paperCandidate.scheduledAt <= lightTime) {
        const job = paperCandidate,
          key = `${job.roundId}:${job.key}`;
        trip.paperSchedule.completed.push(job.key);
        increment(health.expected, job.type);
        const allowed =
          job.type === 'cdn_fetch'
            ? reserveContent(trip, key, PAPER_CDN_LIMIT)
            : reserve(
                trip,
                'diagnostics',
                job.type === 'dns_resolver'
                  ? PAPER_DNS_LIMIT
                  : requestedPayload('traceroute', DIAGNOSTIC_CONFIG),
              );
        if (!allowed) {
          await sink.event('probe_skipped', {
            type: job.type,
            targetId: job.targetId,
            reason: 'allowance',
          });
          continue;
        }
        let result;
        try {
          result = await probe(job.type, job.scheduledAt, job);
        } finally {
          if (job.type === 'cdn_fetch') {
            settleContent(
              trip,
              key,
              result?.paper?.bodyBytes ?? PAPER_CDN_LIMIT,
            );
            lastHeavyEnd = clock.now();
          }
        }
        continue;
      }
      const candidate = Object.keys(INTERVALS)
        .sort((a, b) => trip.due[a] - trip.due[b])
        .find(type => trip.due[type] <= now + COLLECTOR_POLICY.toleranceMs);
      if (candidate) {
        const slot = takeDue(trip.due[candidate], now, INTERVALS[candidate]);
        trip.due[candidate] = slot.next;
        increment(health.expected, candidate, slot.skipped + 1);
        if (slot.skipped) {
          increment(health.skips, `busy_deadline:${candidate}`, slot.skipped);
          await sink.event('probe_skipped', {
            type: candidate,
            count: slot.skipped,
            reason: 'busy_deadline',
            scheduledAt: iso(slot.scheduledAt),
          });
        }
        if (
          reserve(
            trip,
            'diagnostics',
            requestedPayload(candidate, DIAGNOSTIC_CONFIG),
          )
        ) {
          await probe(candidate, slot.scheduledAt);
        } else {
          increment(health.skips, `allowance:${candidate}`);
          await sink.event('probe_skipped', {
            type: candidate,
            reason: 'diagnostic_allowance',
          });
        }
        continue;
      }
      const directions = (paper ? [] : ['download', 'upload']).filter(
        type => trip.transferFailures[type] < 2,
      );
      if (
        !trip.pendingTransferPair &&
        heavyReady &&
        directions.length &&
        trip.nextTransferAt != null &&
        now + COLLECTOR_POLICY.toleranceMs >= trip.nextTransferAt
      ) {
        const scheduledAt = trip.nextTransferAt;
        if (reservePair(trip, now + COLLECTOR_POLICY.toleranceMs, directions))
          trip.pendingTransferPair = { scheduledAt, directions };
      }
      if (trip.pendingTransferPair && heavyReady) {
        const pending = trip.pendingTransferPair;
        const type = pending.directions.shift();
        if (type) {
          increment(health.expected, type);
          await probe(type, pending.scheduledAt);
        }
        if (!pending.directions.length) {
          trip.pendingTransferPair = undefined;
          lastHeavyEnd = clock.now();
        }
        continue;
      }
      const extra = trip.pendingTransferPair ? null : dueControl(now);
      if (extra) {
        await probe(extra.type, extra.at);
        continue;
      }
      await clock.wait(1000, workerWake.signal);
    }
  }

  await openSegment();
  armBoundary();
  await sink.event('session_started', { startedAt: iso(startedAt) });
  const controller = control().catch(error => {
    finish('baseline_error');
    throw error;
  });
  try {
    await worker();
  } catch (error) {
    finish('baseline_error');
    throw error;
  } finally {
    boundaryWake.abort();
    graceWake.abort();
    external?.removeEventListener('abort', onExternal);
    await controller;
    await closeSegment(trip.reason ?? 'operator_stop');
  }
  return trip;
}

export const realClock = {
  now: () => Date.now(),
  mono: () => performance.now(),
  wait: (ms, signal) =>
    new Promise(resolve => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done);
    }),
};
