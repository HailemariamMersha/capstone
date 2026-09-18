import BackgroundService from 'react-native-background-actions';
import type { BackgroundExecutor } from '../sessions/types';

const HEARTBEAT_MS = 60_000;
const START_TIMEOUT_MS = 10_000;

/** Library-owned native execution; all application work runs in TypeScript. */
export function createBackgroundExecutor(): BackgroundExecutor {
  let cancel: (() => void) | undefined;
  let removeExpiration: (() => void) | undefined;

  return {
    async start(onHeartbeat, onError) {
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      let acknowledge: () => void = () => {};
      let rejectStart: (error: Error) => void = () => {};
      const ready = new Promise<void>((resolve, reject) => {
        acknowledge = resolve;
        rejectStart = reject;
      });
      // Attach a handler immediately, including while the native start call is pending.
      const readiness = ready.then(() => undefined);
      readiness.catch(() => undefined);
      cancel = () => {
        cancelled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (startupTimer !== undefined) {
          clearTimeout(startupTimer);
        }
        rejectStart(new Error('Background startup was cancelled.'));
      };
      const expiration = () =>
        onError(new Error('The operating system ended background execution.'));
      BackgroundService.on('expiration', expiration);
      removeExpiration = () =>
        BackgroundService.removeListener('expiration', expiration);

      const tick = () => {
        if (cancelled) {
          return;
        }
        try {
          onHeartbeat();
          timer = setTimeout(tick, HEARTBEAT_MS);
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      };
      startupTimer = setTimeout(
        () =>
          rejectStart(
            new Error('The background task did not start within 10 seconds.'),
          ),
        START_TIMEOUT_MS,
      );
      try {
        await BackgroundService.start(
          () =>
            new Promise<void>(() => {
              if (cancelled) {
                return;
              }
              if (startupTimer !== undefined) {
                clearTimeout(startupTimer);
              }
              acknowledge();
              timer = setTimeout(tick, HEARTBEAT_MS);
              // BackgroundService.stop() releases the library's headless task wrapper.
              // Do not resolve this inner promise on cancellation: the library would
              // auto-stop again and could stop a newly started session.
            }),
          {
            taskName: 'CapstoneMeasurement',
            taskTitle: 'Capstone session active',
            taskDesc:
              'Measurements are saved on this device. Tap to open and stop.',
            taskIcon: { name: 'ic_measurement', type: 'drawable' },
            color: '#375976',
            foregroundServiceType: ['specialUse'],
          },
        );
        await readiness;
      } catch (error) {
        cancel();
        throw error;
      }
    },
    async stop() {
      cancel?.();
      removeExpiration?.();
      removeExpiration = undefined;
      await BackgroundService.stop();
      cancel = undefined;
    },
  };
}
