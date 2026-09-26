import { DEFAULT_SESSION_CONFIG, validateSessionConfig } from './config';
import { startMeasurementLoop } from '../measurements/scheduler';
import type { MeasurementLoop } from '../measurements/scheduler';
import type { MeasurementStore } from '../storage/types';
import type {
  BackgroundExecutor,
  MeasurementConfig,
  ServiceStatus,
} from './types';

const emptyStatus = (): ServiceStatus => ({
  state: 'stopped',
  sessionId: null,
  startedAt: null,
  elapsedMs: 0,
  heartbeatCount: 0,
  lastHeartbeatAt: null,
  measurementCount: 0,
  error: null,
});
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function createSessionController(
  executor: BackgroundExecutor,
  store: MeasurementStore,
  startLoop: typeof startMeasurementLoop = startMeasurementLoop,
) {
  let status = emptyStatus();
  let startedMonotonic = 0;
  let loop: MeasurementLoop | undefined;
  let operations: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(current: ServiceStatus) => void>();
  const snapshot = (): ServiceStatus => ({
    ...status,
    elapsedMs:
      status.startedAt === null
        ? 0
        : Math.max(0, performance.now() - startedMonotonic),
  });
  const publish = () => {
    for (const listener of listeners) {
      try {
        listener(snapshot());
      } catch (error) {
        console.error('Session listener failed', error);
      }
    }
  };
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = operations.then(action);
    operations = result.catch(() => undefined);
    return result;
  }
  async function shutdown(
    reason: string | null = null,
    completionReason = 'Stopped by user.',
  ) {
    if (status.state === 'stopped') {
      return;
    }
    const id = status.sessionId!;
    status = { ...status, state: 'stopping', error: reason };
    publish();
    let failure = reason;
    try {
      await loop?.stop();
    } catch (error) {
      failure = failure ?? message(error);
    }
    loop = undefined;
    try {
      await executor.stop();
      await store.endSession(
        id,
        failure ? 'interrupted' : 'completed',
        failure ?? completionReason,
      );
      status = { ...emptyStatus(), error: failure };
    } catch (error) {
      // Keep Stop available to retry platform cleanup or the closing transaction.
      status = { ...status, state: 'running', error: message(error) };
      throw error;
    } finally {
      publish();
    }
  }
  function fail(id: string, error: Error) {
    enqueue(async () => {
      if (status.sessionId === id && status.state === 'running') {
        await shutdown(error.message);
      }
    }).catch(() => {});
  }
  return {
    startSession(
      input: MeasurementConfig = DEFAULT_SESSION_CONFIG,
      resumedFromId?: string,
    ): Promise<string> {
      return enqueue(async () => {
        await store.initialize();
        if (status.state === 'running' && status.sessionId) {
          return status.sessionId;
        }
        const config = validateSessionConfig(input);
        const id = await store.createSession(config, resumedFromId);
        status = { ...emptyStatus(), state: 'starting', sessionId: id };
        publish();
        try {
          await executor.start(
            () => {
              if (status.sessionId !== id || status.state !== 'running') {
                return;
              }
              status = {
                ...status,
                heartbeatCount: status.heartbeatCount + 1,
                lastHeartbeatAt: Date.now(),
              };
              publish();
              store
                .touchSession(id)
                .catch(error =>
                  fail(id, new Error(`Storage failure: ${message(error)}`)),
                );
            },
            error => fail(id, error),
          );
          startedMonotonic = performance.now();
          status = {
            ...status,
            state: 'running',
            startedAt: Date.now(),
            heartbeatCount: 1,
            lastHeartbeatAt: Date.now(),
          };
          loop = startLoop(id, config, store, () => {
            if (status.sessionId === id) {
              status = {
                ...status,
                measurementCount: status.measurementCount + 1,
              };
              publish();
            }
          });
          loop.done
            .then(
              () =>
                enqueue(async () => {
                  if (status.sessionId === id && status.state === 'running') {
                    await shutdown(
                      null,
                      'Measurement schedule completed or a session limit was reached.',
                    );
                  }
                }),
              error =>
                fail(id, new Error(`Measurement stopped: ${message(error)}`)),
            )
            .catch(() => {});
          publish();
          return id;
        } catch (error) {
          try {
            await executor.stop();
            await store.endSession(
              id,
              'interrupted',
              `Startup failed: ${message(error)}`,
            );
            status = { ...emptyStatus(), error: message(error) };
          } catch (cleanupError) {
            status = {
              ...status,
              state: 'running',
              error: `${message(error)} Cleanup failed: ${message(
                cleanupError,
              )}`,
            };
          }
          publish();
          throw error;
        }
      });
    },
    stopSession(): Promise<void> {
      return enqueue(() => shutdown());
    },
    async getServiceStatus(): Promise<ServiceStatus> {
      await store.initialize();
      return snapshot();
    },
    subscribeToStatus(listener: (current: ServiceStatus) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
