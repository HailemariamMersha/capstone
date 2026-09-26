import {
  DEFAULT_PROBE_CONFIG,
  validateProbeConfig,
} from '../measurements/config';
import type { MeasurementConfig } from './types';
export const DEFAULT_SESSION_CONFIG: MeasurementConfig = {
  ...DEFAULT_PROBE_CONFIG,
  maxDurationMs: 2 * 60 * 60 * 1000,
  maxPayloadBytes: 100 * 1024 * 1024,
  minimumBatteryPercent: 15,
  icmpHost: '',
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
  const settings = { ...DEFAULT_SESSION_CONFIG, ...config, ...probes };
  for (const [name, value, min, max] of [
    ['Duration', settings.maxDurationMs!, 10000, 24 * 3600000],
    ['Payload budget', settings.maxPayloadBytes!, 1024, 1024 * 1024 * 1024],
    ['Minimum battery', settings.minimumBatteryPercent!, 0, 100],
  ] as const) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} is outside its supported range.`);
    }
  }
  settings.icmpHost = (settings.icmpHost ?? '').trim();
  if (
    settings.icmpHost &&
    !/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(settings.icmpHost)
  ) {
    throw new Error(
      'ICMP target must be a hostname or IP address without a URL, port or spaces.',
    );
  }
  return settings;
}
