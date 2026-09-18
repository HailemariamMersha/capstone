import type { ProbeConfig } from './types';

export const MIB = 1024 * 1024;
export const DOWNLOAD_SIZES = [MIB, 5 * MIB, 10 * MIB] as const;
export const UPLOAD_SIZES = [256 * 1024, MIB] as const;
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
  if (!(DOWNLOAD_SIZES as readonly number[]).includes(config.downloadBytes)) {
    throw new Error('Download size must be 1, 5 or 10 MiB.');
  }
  if (!(UPLOAD_SIZES as readonly number[]).includes(config.uploadBytes)) {
    throw new Error('Upload size must be 256 KiB or 1 MiB.');
  }
  return { ...config, serverUrl: url.href.replace(/\/$/, '') };
}

let sequence = 0;
/** Temporary process-local identifiers. Durable IDs are introduced with M4 storage. */
export function prototypeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++sequence}`;
}
