import { runProbe } from './runProbe';
import type { ProbeType } from './types';
import type { MeasurementConfig } from '../sessions/types';
import type { MeasurementStore } from '../storage/types';

export interface MeasurementLoop {
  done: Promise<void>;
  stop(): Promise<void>;
}
export interface SchedulerDependencies {
  now: () => number;
  wallNow: () => number;
  probe: typeof runProbe;
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
  const abort = new AbortController();
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const origin = dependencies.now();
  const wallOrigin = dependencies.wallNow();
  const schedule: { type: ProbeType; interval: number; due: number }[] = [
    { type: 'http_rtt', interval: config.rttIntervalMs, due: origin },
    { type: 'download', interval: config.downloadIntervalMs, due: origin },
    { type: 'upload', interval: config.uploadIntervalMs, due: origin },
  ];
  const done = (async () => {
    while (!abort.signal.aborted) {
      schedule.sort((a, b) => a.due - b.due);
      const next = schedule[0];
      const delay = next.due - dependencies.now();
      if (delay > 0) {
        await new Promise<void>(resolve => {
          wake = resolve;
          timer = setTimeout(resolve, delay);
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
      const attempt = await store.beginAttempt(
        sessionId,
        next.type,
        new Date(wallOrigin + next.due - origin).toISOString(),
      );
      // The attempt is durable before any network request. Even cancellation is persisted.
      const result = await dependencies.probe(
        next.type,
        config,
        sessionId,
        abort.signal,
      );
      await store.finishAttempt({ ...result, id: attempt.id });
      onSaved();
      next.due += next.interval;
    }
  })();
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
