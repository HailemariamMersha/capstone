import { DEFAULT_SESSION_CONFIG } from '../sessions/config';
import config from '../config/public.json';
import type { MeasurementConfig } from '../sessions/types';
export const participantDefaults: MeasurementConfig = {
  ...DEFAULT_SESSION_CONFIG,
  httpEnabled: false,
  maxDurationMs: 600000,
  maxPayloadBytes: 100 * 1024 * 1024,
  minimumBatteryPercent: 15,
  serverUrl: config.probeUrl,
  icmpHost: 'google.com',
  icmpBurstEnabled: true,
  tcpEnabled: true,
  tcpServerUrl: 'https://google.com',
  tracerouteHost: 'google.com',
  tracerouteMaxHops: 10,
  udpHost: config.udpHost,
  udpPort: config.udpPort,
  diagnosticsIntervalMs: 60000,
  collectorVersion: config.collectorVersion,
  probeRegion: config.probeRegion,
};
