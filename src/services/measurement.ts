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
);
export const {
  startSession,
  stopSession,
  getServiceStatus,
  subscribeToStatus,
} = controller;
