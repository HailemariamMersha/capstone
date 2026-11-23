import { createBackgroundExecutor } from './backgroundExecutor';
import type { BackgroundExecutor } from '../sessions/types';

type Drain = (
  signal: AbortSignal,
  progress: (message: string) => void,
) => Promise<void>;

/** One native service, one generation-owned lifecycle. Collection and draining
 * share the Headless JS task; resolving an old task must never stop its successor. */
export function createServiceCoordinator(executor: BackgroundExecutor) {
  let phase: 'idle' | 'collection' | 'upload' = 'idle';
  let generation = 0;
  let lane: Promise<unknown> = Promise.resolve();
  let drain: Drain | null = null;
  let controller: AbortController | null = null;
  let heartbeat = () => {};
  let error = (_error: Error) => {};
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const result = lane.then(action);
    lane = result.catch(() => {});
    return result;
  };
  async function activate(next: 'collection' | 'upload') {
    if (phase === 'idle')
      await executor.start(
        () => heartbeat(),
        e => error(e),
        next,
      );
    else await executor.setPhase?.(next);
    phase = next;
  }
  const stop = (mine: number) =>
    serial(async () => {
      if (mine !== generation) return;
      controller?.abort();
      controller = null;
      heartbeat = () => {};
      phase = 'idle';
      await executor.stop();
    });
  async function startUpload(expectedGeneration?: number, handoff = false) {
    return serial(async () => {
      if (expectedGeneration != null && expectedGeneration !== generation)
        return false;
      if (phase === 'collection' && !handoff) return false;
      if (phase === 'upload') return true;
      if (!drain) {
        if (phase !== 'idle') {
          phase = 'idle';
          await executor.stop();
        }
        return false;
      }
      const work = drain;
      const mine = ++generation;
      const abort = new AbortController();
      controller = abort;
      heartbeat = () => {};
      error = () => abort.abort();
      try {
        await activate('upload');
      } catch {
        phase = 'idle';
        controller = null;
        await executor.stop().catch(() => {});
        return false;
      }
      const progress = (message: string) => {
        void serial(async () => {
          if (mine === generation && phase === 'upload')
            await executor.setPhase?.('upload', message);
        }).catch(() => abort.abort());
      };
      // Do not await network work here: Stop returns after the durable handoff.
      void Promise.resolve()
        .then(() => work(abort.signal, progress))
        .catch(() => {})
        .finally(() => {
          void stop(mine).catch(() => {});
        });
      return true;
    });
  }
  return {
    uploading: () => phase === 'upload',
    async startCollection(
      onHeartbeat: () => void,
      onError: (e: Error) => void,
    ) {
      // Abort before waiting on the lifecycle lane, invalidating old cleanup.
      const mine = ++generation;
      controller?.abort();
      controller = null;
      heartbeat = onHeartbeat;
      error = onError;
      await serial(() => activate('collection'));
      return mine;
    },
    handoffToUploads: (expectedGeneration?: number) =>
      startUpload(expectedGeneration, true),
    startUploads: () => startUpload(),
    registerDrain(handler: Drain) {
      drain = handler;
      return () => {
        if (drain === handler) drain = null;
      };
    },
    cancelUploads() {
      controller?.abort();
    },
    async stop() {
      const mine = ++generation;
      controller?.abort();
      await stop(mine);
    },
  };
}

export const foregroundService = createServiceCoordinator(
  createBackgroundExecutor(),
);
