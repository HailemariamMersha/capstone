import { runProbe } from './runProbe';
import type { NetworkSnapshot } from '../network/types';
import type { Measurement } from './types';
import type { ProbeType } from './types';
import type { MeasurementConfig } from '../sessions/types';
import type { MeasurementStore } from '../storage/types';
import { requestedPayload } from './diagnosticConfig';

export interface MeasurementLoop {
  done: Promise<void>;
  stop(): Promise<void>;
}
export interface SchedulerDependencies {
  now: () => number;
  wallNow: () => number;
  probe: typeof runProbe;
  diagnostic?: (
    attempt: Measurement,
    config: MeasurementConfig,
    signal: AbortSignal,
  ) => Promise<Measurement>;
  onContextChange?: (callback: () => void) => () => void;
  sample?: () => Promise<{ snapshot: NetworkSnapshot; changed: boolean }>;
  icmp?: (
    attempt: Measurement,
    host: string,
    timeout: number,
    signal: AbortSignal,
  ) => Promise<Measurement>;
}
const defaults: SchedulerDependencies = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  probe: runProbe,
};

export function startMeasurementLoop(
  sessionId: string,
  config: MeasurementConfig,
  store: MeasurementStore,
  onSaved: () => void,
  dependencies: SchedulerDependencies = defaults,
): MeasurementLoop {
  if (
    (config.icmpBurstEnabled ||
      config.tcpEnabled ||
      config.tracerouteHost ||
      config.udpHost ||
      config.loadedLatencyEnabled) &&
    !dependencies.diagnostic
  ) {
    throw new Error('Optional diagnostic executor is unavailable.');
  }
  const abort = new AbortController();
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const origin = dependencies.now();
  const wallOrigin = dependencies.wallNow();
  const schedule: { type: ProbeType; interval: number; due: number }[] =
    config.httpEnabled === false
      ? []
      : [
          { type: 'http_rtt', interval: config.rttIntervalMs, due: origin },
          {
            type: 'download',
            interval: config.downloadIntervalMs,
            due: origin,
          },
          { type: 'upload', interval: config.uploadIntervalMs, due: origin },
        ];
  if (config.icmpHost && dependencies.icmp) {
    schedule.splice(1, 0, {
      type: config.icmpBurstEnabled ? 'icmp_burst' : 'icmp_rtt',
      interval: config.rttIntervalMs,
      due: origin,
    });
  }
  if (config.tcpEnabled) {
    schedule.push({
      type: 'tcp_connect',
      interval: config.rttIntervalMs,
      due: origin,
    });
  }
  const diagnosticInterval = config.diagnosticsIntervalMs ?? 300000;
  if (config.tracerouteHost) {
    schedule.push({ type: 'traceroute', interval: 900000, due: origin });
  }
  if (config.udpHost) {
    schedule.push({
      type: 'udp_echo',
      interval: diagnosticInterval,
      due: origin,
    });
  }
  if (config.loadedLatencyEnabled && config.httpEnabled !== false) {
    schedule.push({
      type: 'loaded_download',
      interval: diagnosticInterval,
      due: origin,
    });
    schedule.push({
      type: 'loaded_upload',
      interval: diagnosticInterval,
      due: origin,
    });
  }
  if (!schedule.length) throw new Error('No measurement probes are enabled.');
  let snapshot: NetworkSnapshot | null = null;
  let lastSample = -Infinity;
  let usedBytes = 0;
  let contextDirty = true;
  const unsubscribe = dependencies.onContextChange?.(() => {
    contextDirty = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    wake?.();
  });
  const limit = async (reason: string) => {
    await store.addEvent(sessionId, 'session_limit', {
      reason,
      reservedPayloadBytes: usedBytes,
    });
  };
  const deadline = config.maxDurationMs ?? 2 * 3600000;
  const lifetimeTimer = setTimeout(() => {
    abort.abort();
    wake?.();
  }, deadline);
  const done = (async () => {
    while (!abort.signal.aborted) {
      if (dependencies.now() - origin >= deadline) {
        break;
      }
      if (
        dependencies.sample &&
        (contextDirty || dependencies.now() - lastSample >= 60000)
      ) {
        contextDirty = false;
        const current = await dependencies.sample();
        snapshot = await store.saveSnapshot(sessionId, current.snapshot);
        lastSample = dependencies.now();
        if (current.changed) {
          await store.addEvent(sessionId, 'network_change', {
            snapshotId: snapshot.id,
            type: snapshot.type,
          });
        }
        if (
          snapshot.batteryPercent != null &&
          snapshot.batteryPercent <= (config.minimumBatteryPercent ?? 15) &&
          snapshot.isCharging === false
        ) {
          await limit('battery');
          break;
        }
      }
      schedule.sort((a, b) => a.due - b.due);
      const next = schedule[0];
      const delay = next.due - dependencies.now();
      if (delay > 0) {
        await new Promise<void>(resolve => {
          wake = resolve;
          timer = setTimeout(
            resolve,
            Math.min(
              delay,
              60000,
              Math.max(1, deadline - (dependencies.now() - origin)),
            ),
          );
        });
        timer = undefined;
        wake = undefined;
        continue;
      }
      const lateByMs = Math.max(0, dependencies.now() - next.due);
      const skipped = Math.floor(lateByMs / next.interval);
      if (lateByMs > Math.max(1000, next.interval / 10)) {
        await store.addEvent(sessionId, 'schedule_gap', {
          type: next.type,
          lateByMs,
          skipped,
          scheduledAt: new Date(wallOrigin + next.due - origin).toISOString(),
        });
      }
      // Skip missed intervals instead of generating a catch-up traffic burst.
      next.due += skipped * next.interval;
      if (abort.signal.aborted) {
        break;
      }
      const requested = requestedPayload(next.type, config);
      if (
        usedBytes + requested >
        (config.maxPayloadBytes ?? 100 * 1024 * 1024)
      ) {
        await limit('payload_budget');
        break;
      }
      const attempt = await store.beginAttempt(
        sessionId,
        next.type,
        new Date(wallOrigin + next.due - origin).toISOString(),
      );
      // The attempt is durable before any network request. Even cancellation is persisted.
      usedBytes += requested; // Includes failed and cancelled attempts; headers/retransmissions are not measurable here.
      const result =
        next.type === 'icmp_rtt' && dependencies.icmp
          ? await dependencies.icmp(
              attempt,
              config.icmpHost!,
              config.timeoutMs,
              abort.signal,
            )
          : next.type === 'http_rtt' ||
            next.type === 'download' ||
            next.type === 'upload'
          ? await dependencies.probe(next.type, config, sessionId, abort.signal)
          : await dependencies.diagnostic!(attempt, config, abort.signal);
      await store.finishAttempt({
        ...result,
        id: attempt.id,
        networkSnapshot: snapshot,
      });
      onSaved();
      next.due += next.interval;
    }
    if (dependencies.now() - origin >= deadline) {
      await limit('duration');
    }
  })().finally(() => {
    unsubscribe?.();
    clearTimeout(lifetimeTimer);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
  return {
    done,
    async stop() {
      abort.abort();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      wake?.();
      await done;
    },
  };
}
