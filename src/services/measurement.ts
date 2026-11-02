import {
  tripRunning,
  tripServiceStatus,
  subscribeTrip,
  stopTrip,
  recoverTrips,
} from '../trips/runtime';
import { localSession } from '../auth/client';
import { acquireActivity, currentActivity } from './activityGate';
import type { MeasurementConfig } from '../sessions/types';
import { runProbe } from '../measurements/runProbe';
import { runIcmp } from '../measurements/icmp';
import { runDiagnostic } from '../measurements/diagnostics';
import { createContextCollector } from '../network/context';
import { startMeasurementLoop } from '../measurements/scheduler';
import { Platform } from 'react-native';
import { createBackgroundExecutor } from '../background/backgroundExecutor';
import { measurementStore } from '../storage/database';
import { createSessionController } from '../sessions/sessionController';

export type { MeasurementConfig, ServiceStatus } from '../sessions/types';

// Both platforms use the same session code. Only Android is validated this semester.
export const isMeasurementSupported =
  Platform.OS === 'android' || Platform.OS === 'ios';
const controller = createSessionController(
  createBackgroundExecutor(),
  measurementStore,
  (id, config, store, onSaved) => {
    const collector = createContextCollector(
      config.serverUrl,
      config.httpEnabled !== false,
    );
    const loop = startMeasurementLoop(id, config, store, onSaved, {
      now: () => performance.now(),
      wallNow: () => Date.now(),
      probe: runProbe,
      icmp: runIcmp,
      diagnostic: runDiagnostic,
      sample: collector.sample,
      onContextChange: collector.onChange,
    });
    loop.done.then(collector.stop, collector.stop);
    return loop;
  },
);
export const stopSession = () =>
  tripRunning() ? stopTrip() : controller.stopSession();
export async function getServiceStatus() {
  const active = tripServiceStatus();
  if (active) return active;
  const status = await controller.getServiceStatus();
  const session = await localSession();
  if (session) await recoverTrips(session.user.id);
  return status;
}
export function subscribeToStatus(
  fn: (status: import('../sessions/types').ServiceStatus) => void,
) {
  const a = controller.subscribeToStatus(fn);
  const b = subscribeTrip(() => {
    getServiceStatus()
      .then(fn)
      .catch(() => {});
  });
  return () => {
    a();
    b();
  };
}

let releaseMeasurement: (() => void) | undefined;
controller.subscribeToStatus(status => {
  if (status.state === 'stopped') {
    releaseMeasurement?.();
    releaseMeasurement = undefined;
  }
});
export async function startSession(
  config?: MeasurementConfig,
  resumedFromId?: string,
  ownerId?: string,
): Promise<string> {
  if (tripRunning()) throw new Error('Stop the trip before manual collection.');
  if (currentActivity() !== 'measurement') {
    releaseMeasurement = acquireActivity('measurement');
  }
  try {
    return await controller.startSession(config, resumedFromId, ownerId);
  } catch (error) {
    if (
      (await controller.getServiceStatus().catch(() => null))?.state !==
      'running'
    ) {
      releaseMeasurement?.();
      releaseMeasurement = undefined;
    }
    throw error;
  }
}
