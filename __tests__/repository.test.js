import { createRepository } from '../src/storage/repository';
import { DEFAULT_SESSION_CONFIG as config } from '../src/sessions/config';
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
let directory, db, store;
function open() {
  db = new DatabaseSync(join(directory, 'test.sqlite'));
  store = createRepository(
    {
      execute: async (sql, params = []) => {
        const statement = db.prepare(sql);
        if (statement.columns().length) {
          return { rows: statement.all(...params) };
        }
        statement.run(...params);
        return { rows: [] };
      },
    },
    'test',
  );
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'capstone-db-'));
  open();
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
const success = attempt => ({
  ...attempt,
  success: true,
  value: 12,
  durationMs: 12,
  errorType: null,
  errorMessage: null,
  transferredBytes: attempt.requestedBytes,
  httpStatus: 200,
});
test('enables WAL, migrations and durable result/queue records', async () => {
  const id = await store.createSession(config);
  expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
  expect(db.prepare('PRAGMA user_version').get().user_version).toBe(2);
  const attempt = await store.beginAttempt(
    id,
    'http_rtt',
    new Date().toISOString(),
  );
  await store.finishAttempt(success(attempt));
  await store.finishAttempt(success(attempt));
  expect(await store.listMeasurements(id)).toHaveLength(1);
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type='measurement'",
      )
      .get().n,
  ).toBe(1);
  await store.endSession(id, 'completed', 'user');
  db.close();
  open();
  expect(await store.getSession(id)).toMatchObject({
    state: 'completed',
    config,
    measurementCount: 1,
  });
  expect((await store.listMeasurements(id))[0].measurement).toMatchObject({
    success: true,
    value: 12,
  });
});
test('cold restart recovers pending attempts once and links a resumed session', async () => {
  const id = await store.createSession(config);
  const attempt = await store.beginAttempt(
    id,
    'download',
    new Date().toISOString(),
  );
  db.close();
  open();
  expect(await store.getSession(id)).toMatchObject({
    state: 'interrupted',
    measurementCount: 1,
  });
  expect((await store.listMeasurements(id))[0]).toMatchObject({
    state: 'complete',
    measurement: { id: attempt.id, success: false, errorType: 'interrupted' },
  });
  const resumed = await store.createSession(config, id);
  expect(await store.getSession(resumed)).toMatchObject({
    resumedFromId: id,
    state: 'active',
  });
  await store.initialize();
  expect(
    (await store.listEvents(id)).filter(e => e.kind === 'session_interrupted'),
  ).toHaveLength(1);
  await expect(
    store.beginAttempt(id, 'upload', new Date().toISOString()),
  ).rejects.toThrow('active session');
});
test('queue failure rolls back the result and permits retry without loss', async () => {
  const id = await store.createSession(config);
  const attempt = await store.beginAttempt(
    id,
    'upload',
    new Date().toISOString(),
  );
  db.exec(
    "CREATE TRIGGER fail_queue BEFORE INSERT ON sync_queue WHEN NEW.entity_type='measurement' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
  );
  await expect(store.finishAttempt(success(attempt))).rejects.toThrow(
    'disk full',
  );
  expect((await store.listMeasurements(id))[0].state).toBe('pending');
  db.exec('DROP TRIGGER fail_queue');
  await store.finishAttempt(success(attempt));
  expect((await store.listMeasurements(id))[0].measurement.success).toBe(true);
});
test('serializes concurrent transactions and rejects mismatched results', async () => {
  const id = await store.createSession(config);
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.beginAttempt(id, 'http_rtt', new Date().toISOString()),
    ),
  );
  expect(new Set(attempts.map(a => a.id)).size).toBe(8);
  await expect(
    store.finishAttempt({ ...attempts[0], type: 'upload' }),
  ).rejects.toThrow('match');
  await Promise.all(attempts.map(a => store.finishAttempt(success(a))));
  expect((await store.getSession(id)).measurementCount).toBe(8);
  expect(await store.listMeasurements(id, 3, 3)).toHaveLength(3);
});
test('future schema is refused without destroying data', async () => {
  db.exec('PRAGMA user_version=99');
  await expect(store.initialize()).rejects.toThrow('newer app');
  expect(db.prepare('PRAGMA user_version').get().user_version).toBe(99);
});

test('exports all measurements, events and snapshots without the history page limit', async () => {
  const id = await store.createSession(config);
  for (let i = 0; i < 55; i++) {
    const attempt = await store.beginAttempt(
      id,
      'http_rtt',
      new Date().toISOString(),
    );
    await store.finishAttempt(success(attempt));
  }
  await store.saveSnapshot(id, {
    id: 'temporary',
    timestamp: new Date().toISOString(),
    type: 'wifi',
    batteryPercent: 42,
  });
  const data = await store.exportSession(id);
  expect(data.measurements).toHaveLength(55);
  expect(data.snapshots[0]).toMatchObject({ batteryPercent: 42 });
  expect(data.snapshots[0].id).not.toBe('temporary');
  expect(data.events).toHaveLength(1);
});
test('sync excludes active sessions and applies version-specific acknowledgements', async () => {
  const id = await store.createSession(config);
  expect((await store.getSyncBatch()).records).toHaveLength(0);
  await store.endSession(id, 'completed', 'test');
  const batch = await store.getSyncBatch();
  expect(batch.records.length).toBeGreaterThan(0);
  await store.acknowledgeSync(
    batch.records.map(r => ({ ...r, version: r.version - 1 })),
  );
  expect((await store.getSyncBatch()).records).toHaveLength(
    batch.records.length,
  );
  await store.failSync(batch.records, 'offline');
  expect((await store.getSyncBatch()).records).toHaveLength(0);
  db.exec('UPDATE sync_queue SET next_attempt_at=0');
  await store.acknowledgeSync(batch.records);
  expect(await store.pendingCount()).toBe(0);
});
test('payload allowance counts pending and failed attempts', async () => {
  const id = await store.createSession({ ...config, maxPayloadBytes: 8 });
  await store.beginAttempt(id, 'http_rtt', new Date().toISOString());
  await store.beginAttempt(id, 'http_rtt', new Date().toISOString());
  await expect(
    store.beginAttempt(id, 'http_rtt', new Date().toISOString()),
  ).rejects.toThrow('budget');
});
test('version-one migration preserves existing records and recovers an open session', async () => {
  const id = await store.createSession(config);
  const attempt = await store.beginAttempt(
    id,
    'http_rtt',
    new Date().toISOString(),
  );
  await store.finishAttempt(success(attempt));
  db.exec(
    'ALTER TABLE sync_queue DROP COLUMN version; ALTER TABLE sync_queue DROP COLUMN next_attempt_at; ALTER TABLE sync_queue DROP COLUMN last_error; PRAGMA user_version=1',
  );
  db.close();
  open();
  expect(await store.getSession(id)).toMatchObject({
    state: 'interrupted',
    measurementCount: 1,
  });
  expect(
    (await store.getSyncBatch()).records.some(r => r.id === attempt.id),
  ).toBe(true);
});
