import type { RawProbeOutput } from '../measurements/types';
export type Direction = 'download' | 'upload';
export interface ReferenceResult {
  direction: Direction;
  reason: string;
  host: string;
  clientBytes: number | null;
  serverBytes: number | null;
  clientSeconds: number | null;
  serverSeconds: number | null;
  opened: boolean;
  cleanClose: boolean;
  callbacks?: RawProbeOutput['callbacks'];
  droppedCallbacks?: number;
}
export interface ReferenceMessage {
  version: 1;
  runId: string;
  type: 'progress' | 'finished';
  reason?: string;
  results: ReferenceResult[];
}
const reasons = new Set([
  'running',
  'complete',
  'cancelled',
  'timeout',
  'network',
  'invalid_response',
  'unsupported',
  'consent_required',
  'data_threshold',
]);
export function parseReferenceMessage(
  raw: string,
  runId: string,
): ReferenceMessage {
  if (raw.length > 1024 * 1024) {
    throw new Error('Reference message is too large.');
  }
  const value = JSON.parse(raw);
  if (
    value.version !== 1 ||
    value.runId !== runId ||
    !['progress', 'finished'].includes(value.type) ||
    !Array.isArray(value.results) ||
    value.results.length > 2 ||
    (value.type === 'finished' && !reasons.has(value.reason))
  ) {
    throw new Error('Invalid reference message.');
  }
  const directions = new Set();
  for (const result of value.results) {
    if (
      !['download', 'upload'].includes(result.direction) ||
      directions.has(result.direction) ||
      !reasons.has(result.reason) ||
      typeof result.host !== 'string' ||
      !/^[a-zA-Z0-9.-]+\.measurement-lab\.org$/.test(result.host) ||
      result.host.length > 253 ||
      typeof result.opened !== 'boolean' ||
      typeof result.cleanClose !== 'boolean'
    ) {
      throw new Error('Invalid reference result.');
    }
    if (
      result.callbacks !== undefined &&
      (!Array.isArray(result.callbacks) ||
        result.callbacks.length > 256 ||
        JSON.stringify(result.callbacks).length > 263000 ||
        result.callbacks.some(
          (callback: Record<string, unknown>) =>
            !callback ||
            typeof callback.observedAt !== 'string' ||
            typeof callback.elapsedMs !== 'number' ||
            !Number.isFinite(callback.elapsedMs) ||
            callback.elapsedMs < 0,
        ))
    )
      throw new Error('Invalid reference callback log.');
    if (
      result.droppedCallbacks !== undefined &&
      (!Number.isSafeInteger(result.droppedCallbacks) ||
        result.droppedCallbacks < 0)
    )
      throw new Error('Invalid reference callback count.');
    directions.add(result.direction);
    for (const field of [
      'clientBytes',
      'serverBytes',
      'clientSeconds',
      'serverSeconds',
    ]) {
      const number = result[field];
      if (
        number !== null &&
        (typeof number !== 'number' ||
          !Number.isFinite(number) ||
          number < 0 ||
          number > Number.MAX_SAFE_INTEGER)
      ) {
        throw new Error('Invalid reference counter.');
      }
    }
  }
  return value as ReferenceMessage;
}
