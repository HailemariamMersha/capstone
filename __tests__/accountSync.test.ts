import { createAccountSync } from '../src/sync/accountSync';
import { acquireActivity, currentActivity } from '../src/services/activityGate';
const session = {
  id: 's',
  ownerId: 'a',
  uploadStatus: 'Saved locally',
  state: 'completed',
  config: {},
  measurementCount: 1,
};
const record = { type: 'session', id: 's', version: 2, payload: session };
function fixture() {
  const store: any = {
    initialize: jest.fn(),
    uploadReady: jest.fn().mockResolvedValue(true),
    deferUpload: jest.fn(),
    requeueSync: jest.fn(),
    hasActiveSession: jest.fn().mockResolvedValue(false),
    accountSessions: jest.fn().mockResolvedValue([session]),
    sessionManifest: jest.fn().mockResolvedValue([record]),
    getSyncBatch: jest
      .fn()
      .mockResolvedValueOnce({ records: [record] })
      .mockResolvedValue({ records: [] }),
    setUploadStatus: jest.fn(),
    failSync: jest.fn(),
    acknowledgeSync: jest.fn(),
  };
  const request: any = jest
    .fn()
    .mockImplementation(async (path: string) =>
      path.endsWith('/records')
        ? { acknowledged: [record] }
        : path.endsWith('/complete')
        ? { complete: true }
        : {},
    );
  const deps = {
    store,
    request,
    identity: jest.fn().mockResolvedValue({ owner: 'a', mobileUploads: false }),
    network: jest.fn().mockResolvedValue({ connected: true, wifi: true }),
    now: () => 0,
  };
  return { ...deps, run: createAccountSync(deps) };
}
test('manifests precede bounded owned batches, exact acknowledgements precede completion', async () => {
  const f = fixture();
  await f.run();
  expect(f.store.initialize).toHaveBeenCalledWith(false);
  expect(f.store.getSyncBatch).toHaveBeenCalledWith(50, 'a', 's');
  expect(f.request.mock.calls.map((c: any[]) => c[0])).toEqual([
    '/sessions/s/manifest',
    '/sessions/s/records',
    '/sessions/s/complete',
  ]);
  expect(f.request.mock.calls[0][1].session.ownerId).toBeUndefined();
  expect(f.store.acknowledgeSync).toHaveBeenCalledTimes(1);
  expect(f.store.setUploadStatus).toHaveBeenLastCalledWith(
    'a',
    's',
    'Uploaded',
  );
  expect(currentActivity()).toBeNull();
});
test('collection and persisted active sessions prevent even credential/network requests', async () => {
  const f = fixture();
  const release = acquireActivity('measurement');
  await f.run();
  release();
  expect(f.identity).not.toHaveBeenCalled();
  f.store.hasActiveSession.mockResolvedValue(true);
  await f.run();
  expect(f.identity).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
});
test('Wi-Fi preference defers mobile network upload and preserves pending records', async () => {
  const f = fixture();
  f.network.mockResolvedValue({ connected: true, wifi: false });
  await f.run();
  expect(f.request).not.toHaveBeenCalled();
  expect(f.store.setUploadStatus).toHaveBeenCalledWith(
    'a',
    's',
    'Waiting for connection',
  );
  expect(f.store.acknowledgeSync).not.toHaveBeenCalled();
});
test('signed-out users cannot upload; incomplete acknowledgement remains retryable', async () => {
  const f = fixture();
  f.identity.mockResolvedValueOnce(null);
  await f.run();
  expect(f.request).not.toHaveBeenCalled();
  f.request.mockResolvedValue({ acknowledged: [] });
  await f.run();
  expect(f.store.acknowledgeSync).not.toHaveBeenCalled();
  expect(f.store.failSync).toHaveBeenCalled();
  expect(f.store.setUploadStatus).not.toHaveBeenCalledWith(
    'a',
    's',
    'Uploaded',
  );
});
test('duplicate concurrent triggers are coalesced', async () => {
  const f = fixture();
  await Promise.all([f.run(), f.run(), f.run()]);
  expect(f.identity).toHaveBeenCalledTimes(1);
});

test('persisted backoff skips uploads and server reconciliation requeues only owned manifest records', async () => {
  const f = fixture();
  f.store.uploadReady.mockResolvedValueOnce(false);
  await f.run();
  expect(f.request).not.toHaveBeenCalled();
  f.request.mockImplementation(async (path: string) =>
    path.endsWith('/records')
      ? { acknowledged: [record] }
      : path.endsWith('/complete')
      ? {
          complete: false,
          missing: [
            record,
            { type: 'session', id: 'someone-else', version: 1 },
          ],
        }
      : {},
  );
  await f.run();
  expect(f.store.requeueSync).toHaveBeenCalledWith([record]);
  expect(f.store.setUploadStatus).toHaveBeenLastCalledWith(
    'a',
    's',
    'Saved locally',
  );
});
