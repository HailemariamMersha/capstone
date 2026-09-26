import { createSyncClient, validateSyncUrl } from '../src/sync/client';
const record = {
  type: 'measurement',
  id: 'm',
  version: 1,
  payload: { id: 'm' },
};
function setup(result) {
  const store = {
    getSyncBatch: jest.fn(async () => ({
      installationId: 'device',
      records: [record],
    })),
    acknowledgeSync: jest.fn(async () => {}),
    failSync: jest.fn(async () => {}),
  };
  const transport = jest.fn(async () => ({
    ok: true,
    json: async () => result,
  }));
  return { store, transport, client: createSyncClient(store, transport) };
}
test('only explicitly acknowledged IDs and versions leave the queue', async () => {
  const { store, client } = setup({
    acknowledged: [{ ...record, version: 2 }],
  });
  expect(await client.sync('http://127.0.0.1:8000')).toBe(0);
  expect(store.acknowledgeSync).toHaveBeenCalledWith([]);
  expect(store.failSync).toHaveBeenCalledWith([record], expect.any(String));
});
test('coalesces sync calls and acknowledges only after a successful response', async () => {
  const { store, client, transport } = setup({ acknowledged: [record] });
  await Promise.all([
    client.sync('http://localhost:8000'),
    client.sync('http://localhost:8000'),
  ]);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(store.acknowledgeSync).toHaveBeenCalledWith([record]);
});
test('network failures retain records for backoff retry', async () => {
  const { store, client, transport } = setup({});
  transport.mockRejectedValue(new Error('offline'));
  await expect(client.sync('https://example.org')).rejects.toThrow('offline');
  expect(store.acknowledgeSync).not.toHaveBeenCalled();
  expect(store.failSync).toHaveBeenCalledWith([record], 'offline');
});
test('remote HTTP and embedded credentials are rejected', () => {
  expect(() => validateSyncUrl('http://example.org')).toThrow('HTTPS');
  expect(() => validateSyncUrl('https://secret@example.org')).toThrow(
    'credentials',
  );
});

test('sync cannot overlap active measurement traffic', async () => {
  const { acquireActivity } = require('../src/services/activityGate');
  const release = acquireActivity('measurement');
  const { client, transport } = setup({ acknowledged: [record] });
  try {
    await expect(client.sync('http://localhost:8000')).rejects.toThrow(
      'measurement',
    );
    expect(transport).not.toHaveBeenCalled();
  } finally {
    release();
  }
});
