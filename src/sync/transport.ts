import { Buffer } from 'buffer';
import { gzipSync } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';
import configuration from '../config/public.json';
import type { MeasurementStore } from '../storage/types';

/** Object keys are canonical; array order is part of the immutable wire body. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map(key => [key, item[key]]),
        )
      : item,
  );
  return Buffer.from(sha256(Buffer.from(text, 'utf8'))).toString('hex');
}
export const uploadEnvironment = fingerprint(configuration.apiUrl);
export const uploadKey = (kind: string, id = '') =>
  `${uploadEnvironment}:${kind}:${id}`;

export function jsonBody(value: unknown, gzip: boolean) {
  const text = JSON.stringify(value);
  const bytes = Buffer.from(text, 'utf8');
  if (gzip && bytes.length >= 1024) {
    const encoded = gzipSync(bytes, { level: 1, mtime: 0 });
    if (encoded.byteLength < bytes.byteLength)
      return {
        body: encoded.buffer.slice(
          encoded.byteOffset,
          encoded.byteOffset + encoded.byteLength,
        ) as ArrayBuffer,
        bytes: encoded.byteLength,
        decodedBytes: bytes.length,
        encoding: 'gzip' as const,
      };
  }
  return {
    body: text,
    bytes: bytes.length,
    decodedBytes: bytes.length,
    encoding: 'identity' as const,
  };
}

export async function syncVersion(store: MeasurementStore, owner: string) {
  return Number(
    (await store.getUploadState?.(owner, uploadKey('capability'))) ?? 1,
  );
}

export interface ApiResponseObservation {
  status: number;
  responseBytes: number;
  syncVersion: number;
  requestId: string | null;
  serverTiming: string | null;
  retryAfterMs: number | null;
}
export interface ApiObserver {
  dispatched?(): void;
  response?(value: ApiResponseObservation): void;
}
