import { acquireActivity } from '../services/activityGate';
import type { MeasurementStore, SyncRecord } from '../storage/types';

export function validateSyncUrl(input: string): string {
  const url = new URL(input.trim());
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['http:', 'https:'].includes(url.protocol)
  ) {
    throw new Error(
      'Enter an HTTP(S) server URL without credentials, query or fragment.',
    );
  }
  if (
    url.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname)
  ) {
    throw new Error('Remote synchronization requires HTTPS.');
  }
  return url.toString().replace(/\/$/, '');
}
/** One bounded batch. Unacknowledged records remain durable and retryable. */
export function createSyncClient(
  store: MeasurementStore,
  transport: typeof fetch = fetch,
) {
  let active: Promise<number> | undefined;
  return {
    sync(url: string, token = ''): Promise<number> {
      if (active) {
        return active;
      }
      active = (async () => {
        const server = validateSyncUrl(url);
        const release = acquireActivity('sync');
        try {
          const batch = await store.getSyncBatch(50);
          if (!batch.records.length) {
            return 0;
          }
          const abort = new AbortController();
          const timer = setTimeout(() => abort.abort(), 20000);
          try {
            const response = await transport(`${server}/api/v1/ingest`, {
              method: 'POST',
              signal: abort.signal,
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify(batch),
            });
            if (!response.ok) {
              throw new Error(`Sync server returned HTTP ${response.status}.`);
            }
            const result = await response.json();
            if (!Array.isArray(result.acknowledged)) {
              throw new Error('Missing server acknowledgements.');
            }
            const acknowledged: SyncRecord[] = batch.records.filter(record =>
              result.acknowledged.some(
                (ack: { id?: unknown; type?: unknown; version?: unknown }) =>
                  ack &&
                  ack.id === record.id &&
                  ack.type === record.type &&
                  ack.version === record.version,
              ),
            );
            await store.acknowledgeSync(acknowledged);
            const remaining = batch.records.filter(
              record => !acknowledged.includes(record),
            );
            if (remaining.length) {
              await store.failSync(
                remaining,
                'Server did not acknowledge these records.',
              );
            }
            return acknowledged.length;
          } catch (error) {
            await store.failSync(
              batch.records,
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          } finally {
            clearTimeout(timer);
          }
        } finally {
          release();
        }
      })().finally(() => {
        active = undefined;
      });
      return active;
    },
  };
}
