import {
  DEFAULT_PROBE_CONFIG,
  validateProbeConfig,
} from '../measurements/config';
import type { MeasurementConfig } from './types';
export const DEFAULT_SESSION_CONFIG: MeasurementConfig = {
  ...DEFAULT_PROBE_CONFIG,
  rttIntervalMs: 60_000,
  downloadIntervalMs: 300_000,
  uploadIntervalMs: 300_000,
};
export function validateSessionConfig(
  config: MeasurementConfig,
): MeasurementConfig {
  const probes = validateProbeConfig(config);
  for (const [name, interval] of Object.entries({
    RTT: config.rttIntervalMs,
    download: config.downloadIntervalMs,
    upload: config.uploadIntervalMs,
  })) {
    if (
      !Number.isInteger(interval) ||
      interval < 10_000 ||
      interval > 3_600_000
    ) {
      throw new Error(`${name} interval must be between 10 and 3600 seconds.`);
    }
  }
  return { ...config, ...probes };
}
