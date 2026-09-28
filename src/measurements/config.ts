import type { ProbeConfig } from './types';

export const MIB = 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 100 * MIB;

/** User-entered MiB, rounded to the nearest whole byte. Invalid text stays invalid. */
export function payloadBytesFromMiB(value: string): number {
  const text = value.trim();
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)
    ? Math.round(Number(text) * MIB)
    : NaN;
}
export const DEFAULT_PROBE_CONFIG: ProbeConfig = {
  serverUrl: 'http://127.0.0.1:8000',
  timeoutMs: 30_000,
  downloadBytes: MIB,
  uploadBytes: 256 * 1024,
};

export function validateProbeConfig(config: ProbeConfig): ProbeConfig {
  const url = new URL(config.serverUrl.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Use an HTTP(S) server URL without credentials, query or fragment.',
    );
  }
  if (
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 100 ||
    config.timeoutMs > 120_000
  ) {
    throw new Error('Timeout must be between 100 and 120000 milliseconds.');
  }
  for (const [name, bytes] of [
    ['Download', config.downloadBytes],
    ['Upload', config.uploadBytes],
  ] as const) {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > MAX_PAYLOAD_BYTES
    ) {
      throw new Error(`${name} size must be between 1 byte and 100 MiB.`);
    }
  }
  return { ...config, serverUrl: url.href.replace(/\/$/, '') };
}

let sequence = 0;
/** Temporary process-local identifiers. Durable IDs are introduced with M4 storage. */
export function prototypeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++sequence}`;
}
