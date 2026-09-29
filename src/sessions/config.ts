import {
  DEFAULT_PROBE_CONFIG,
  validateProbeConfig,
} from '../measurements/config';
import type { MeasurementConfig } from './types';
export const MAX_SESSION_PAYLOAD_BYTES = 10 * 1024 * 1024 * 1024;
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
  if (
    config.mode === 'ndt7_reference' ||
    config.mode === 'speedchecker_reference'
  ) {
    throw new Error(
      'Reference tests must be started from the reference test panel.',
    );
  }
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
    [
      'Payload budget',
      settings.maxPayloadBytes!,
      1024,
      MAX_SESSION_PAYLOAD_BYTES,
    ],
    ['Minimum battery', settings.minimumBatteryPercent!, 0, 100],
  ] as const) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} is outside its supported range.`);
    }
  }
  settings.udpHost = settings.udpHost?.trim();
  settings.icmpHost = (settings.icmpHost ?? '').trim();
  settings.tracerouteHost = settings.tracerouteHost?.trim();
  if (
    settings.tracerouteHost &&
    !/^[a-zA-Z0-9:][a-zA-Z0-9.:-]{0,252}$/.test(settings.tracerouteHost)
  ) {
    throw new Error(
      'Traceroute target must be a hostname or IP without a URL or spaces.',
    );
  }
  if (
    settings.tracerouteMaxHops !== undefined &&
    (!Number.isInteger(settings.tracerouteMaxHops) ||
      settings.tracerouteMaxHops < 1 ||
      settings.tracerouteMaxHops > 30)
  ) {
    throw new Error('Traceroute maximum hops must be between 1 and 30.');
  }
  for (const flag of [
    'httpEnabled',
    'icmpBurstEnabled',
    'tcpEnabled',
    'loadedLatencyEnabled',
  ] as const) {
    if (settings[flag] !== undefined && typeof settings[flag] !== 'boolean') {
      throw new Error(`${flag} must be enabled or disabled.`);
    }
  }
  if (settings.httpEnabled === false && settings.loadedLatencyEnabled) {
    throw new Error('Enable HTTP measurements to run HTTP loaded latency.');
  }
  if (
    settings.httpEnabled === false &&
    !settings.icmpHost &&
    !settings.tracerouteHost &&
    !settings.udpHost &&
    !settings.tcpEnabled
  ) {
    throw new Error('Select at least one packet probe target.');
  }
  if (settings.icmpBurstEnabled && !settings.icmpHost) {
    throw new Error('Enter an ICMP target to enable burst sampling.');
  }
  if (
    settings.diagnosticsIntervalMs !== undefined &&
    (!Number.isInteger(settings.diagnosticsIntervalMs) ||
      settings.diagnosticsIntervalMs < 60000 ||
      settings.diagnosticsIntervalMs > 3600000)
  ) {
    throw new Error('Diagnostic interval must be between 60 and 3600 seconds.');
  }
  if (settings.udpHost !== undefined) {
    settings.udpHost = settings.udpHost.trim();
  }
  if (settings.udpHost && !/^(\d{1,3}\.){3}\d{1,3}$/.test(settings.udpHost)) {
    throw new Error('UDP target must be the controlled server’s IPv4 address.');
  }
  if (
    settings.udpHost &&
    settings.udpHost
      .split('.')
      .some(part => Number(part) > 255 || String(Number(part)) !== part)
  ) {
    throw new Error('Enter a valid IPv4 address for UDP.');
  }
  if (
    settings.udpHost &&
    (!Number.isInteger(settings.udpPort) ||
      settings.udpPort! < 1 ||
      settings.udpPort! > 65535)
  ) {
    throw new Error('UDP port must be between 1 and 65535.');
  }
  if (
    settings.icmpHost &&
    !/^[a-zA-Z0-9:][a-zA-Z0-9.:-]{0,252}$/.test(settings.icmpHost)
  ) {
    throw new Error(
      'ICMP target must be a hostname or IP address without a URL, port or spaces.',
    );
  }
  return settings;
}
