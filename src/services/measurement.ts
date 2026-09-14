import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export type MeasurementConfig = Record<string, never>;
export type ServiceStatus = {
  state: 'stopped' | 'starting' | 'running' | 'stopping';
  sessionId: string | null;
  startedAt: number | null;
  elapsedMs: number;
  heartbeatCount: number;
  lastHeartbeatAt: number | null;
  error: string | null;
};

type MeasurementModule = {
  startSession(config: MeasurementConfig): Promise<string>;
  stopSession(): Promise<void>;
  getServiceStatus(): Promise<ServiceStatus>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

const native = NativeModules.MeasurementModule as MeasurementModule | undefined;
export const isMeasurementSupported = Platform.OS === 'android' && !!native;

function module(): MeasurementModule {
  if (!isMeasurementSupported || !native) {
    throw new Error(
      'The measurement service requires the Android native build.',
    );
  }
  return native;
}

export async function startSession(
  config: MeasurementConfig = {},
): Promise<string> {
  return module().startSession(config);
}
export async function stopSession(): Promise<void> {
  return module().stopSession();
}
export async function getServiceStatus(): Promise<ServiceStatus> {
  return module().getServiceStatus();
}
export function subscribeToStatus(
  listener: (status: ServiceStatus) => void,
): () => void {
  const subscription = new NativeEventEmitter(module()).addListener(
    'MeasurementServiceStatusChanged',
    listener,
  );
  return () => subscription.remove();
}
