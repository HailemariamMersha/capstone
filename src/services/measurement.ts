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
    const collector = createContextCollector(config.serverUrl);
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
export const { stopSession, getServiceStatus, subscribeToStatus } = controller;

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
): Promise<string> {
  if (currentActivity() !== 'measurement') {
    releaseMeasurement = acquireActivity('measurement');
  }
  try {
    return await controller.startSession(config, resumedFromId);
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
