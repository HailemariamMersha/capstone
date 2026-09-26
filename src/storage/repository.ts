import { SCHEMA, SCHEMA_VERSION, MIGRATION_2 } from './schema';
import type { Measurement } from '../measurements/types';
import type { MeasurementConfig, SessionRecord } from '../sessions/types';
import type {
  MeasurementStore,
  SessionEvent,
  SqlDatabase,
  StoredMeasurement,
} from './types';

/** All reads/writes share one async queue, so transactions cannot interleave. */
export function createRepository(
  db: SqlDatabase,
  platform = 'unknown',
): MeasurementStore {
  let initialized: Promise<void> | undefined;
  let operations: Promise<unknown> = Promise.resolve();
  const now = () => new Date().toISOString();
  async function id(): Promise<string> {
    return String(
      (await db.execute('SELECT lower(hex(randomblob(16))) AS id')).rows[0].id,
    );
  }
  async function queue(type: string, entityId: string) {
    await db.execute(
      "INSERT INTO sync_queue(entity_type, entity_id, created_at) VALUES (?,?,?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET state='pending', version=version+1, next_attempt_at=0, acknowledged_at=NULL",
      [type, entityId, now()],
    );
  }
  async function event(
    sessionId: string,
    kind: string,
    details: Record<string, unknown>,
  ) {
    const eventId = await id();
    await db.execute(
      'INSERT INTO connectivity_events(id,session_id,timestamp,kind,details_json) VALUES (?,?,?,?,?)',
      [eventId, sessionId, now(), kind, JSON.stringify(details)],
    );
    await queue('event', eventId);
  }
  async function transaction<T>(action: () => Promise<T>): Promise<T> {
    await db.execute('BEGIN IMMEDIATE');
    try {
      const value = await action();
      await db.execute('COMMIT');
      return value;
    } catch (error) {
      await db.execute('ROLLBACK');
      throw error;
    }
  }
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = operations.then(action);
    operations = result.catch(() => undefined);
    return result;
  }
  function initialize(): Promise<void> {
    if (!initialized) {
      initialized = serialize(async () => {
        const mode = await db.execute('PRAGMA journal_mode=WAL');
        if (String(mode.rows[0]?.journal_mode).toLowerCase() !== 'wal') {
          throw new Error('SQLite could not enable WAL mode.');
        }
        await db.execute('PRAGMA foreign_keys=ON');
        await db.execute('PRAGMA busy_timeout=5000');
        await db.execute('PRAGMA synchronous=FULL');
        const version = Number(
          (await db.execute('PRAGMA user_version')).rows[0].user_version,
        );
        if (version > SCHEMA_VERSION) {
          throw new Error('Database belongs to a newer app version.');
        }
        await transaction(async () => {
          if (version === 0) {
            for (const sql of SCHEMA) {
              await db.execute(sql);
            }

            await db.execute(
              'INSERT INTO device_info(id,platform,created_at) VALUES (?,?,?)',
              [await id(), platform, now()],
            );
          }
          if (version < 2) {
            for (const sql of MIGRATION_2) {
              await db.execute(sql);
            }
            await db.execute(`PRAGMA user_version=${SCHEMA_VERSION}`);
          }
          // Run once per JS process, before any new session can be started.
          const stale = (
            await db.execute(
              "SELECT id,last_observed_at FROM sessions WHERE state='active'",
            )
          ).rows;
          for (const session of stale) {
            const sessionId = String(session.id);
            const unfinished = (
              await db.execute(
                "SELECT id FROM measurements WHERE session_id=? AND state='pending'",
                [sessionId],
              )
            ).rows;
            await db.execute(
              "UPDATE measurements SET state='complete' WHERE session_id=? AND state='pending'",
              [sessionId],
            );
            for (const row of unfinished) {
              await queue('measurement', String(row.id));
            }
            await db.execute(
              "UPDATE sessions SET state='interrupted',ended_at=? WHERE id=?",
              [now(), sessionId],
            );
            await event(sessionId, 'session_interrupted', {
              lastObservedAt: session.last_observed_at,
              detectedAt: now(),
              unfinishedProbes: unfinished.length,
              reason:
                'Previous JS process ended; exact interruption time is unknown.',
            });
            await db.execute(
              'INSERT INTO debug_logs(session_id,timestamp,level,message) VALUES (?,?,?,?)',
              [
                sessionId,
                now(),
                'warning',
                'Recovered interrupted session and unfinished probe attempts.',
              ],
            );
            await queue('session', sessionId);
          }
        });
      });
      initialized.catch(() => {
        initialized = undefined;
      });
    }
    return initialized;
  }
  async function read<T>(action: () => Promise<T>): Promise<T> {
    await initialize();
    return serialize(action);
  }
  async function write<T>(action: () => Promise<T>): Promise<T> {
    return read(() => transaction(action));
  }
  const toSession = (row: Record<string, unknown>): SessionRecord => ({
    id: String(row.id),
    startedAt: String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    lastObservedAt: String(row.last_observed_at),
    state: row.state as SessionRecord['state'],
    config: JSON.parse(String(row.config_json)) as MeasurementConfig,
    resumedFromId:
      row.resumed_from_id === null ? null : String(row.resumed_from_id),
    measurementCount: Number(row.measurement_count),
  });
  const sessionSelect = `SELECT s.*, (SELECT COUNT(*) FROM measurements m WHERE m.session_id=s.id AND m.state='complete') AS measurement_count FROM sessions s`;
  return {
    initialize,
    saveSnapshot: (sessionId, snapshot) =>
      write(async () => {
        const saved = { ...snapshot, id: await id() };
        await db.execute(
          'INSERT INTO network_snapshots(id,session_id,timestamp,payload_json) VALUES (?,?,?,?)',
          [saved.id, sessionId, saved.timestamp, JSON.stringify(saved)],
        );
        await queue('snapshot', saved.id);
        return saved;
      }),
    exportSession: sessionId =>
      read(async () => {
        const row = (
          await db.execute(`${sessionSelect} WHERE s.id=?`, [sessionId])
        ).rows[0];
        if (!row) {
          throw new Error('Session not found.');
        }
        const measurements = (
          await db.execute(
            'SELECT result_json,scheduled_at,state FROM measurements WHERE session_id=? ORDER BY timestamp,rowid',
            [sessionId],
          )
        ).rows.map(r => ({
          ...JSON.parse(String(r.result_json)),
          scheduledAt: r.scheduled_at,
          state: r.state,
        }));
        const events = (
          await db.execute(
            'SELECT * FROM connectivity_events WHERE session_id=? ORDER BY timestamp,rowid',
            [sessionId],
          )
        ).rows.map(r => ({
          id: r.id,
          timestamp: r.timestamp,
          kind: r.kind,
          details: JSON.parse(String(r.details_json)),
        }));
        const snapshots = (
          await db.execute(
            'SELECT payload_json FROM network_snapshots WHERE session_id=? ORDER BY timestamp,rowid',
            [sessionId],
          )
        ).rows.map(r => JSON.parse(String(r.payload_json)));
        return {
          schemaVersion: SCHEMA_VERSION,
          exportedAt: now(),
          session: toSession(row),
          measurements,
          events,
          snapshots,
        };
      }),
    getSyncBatch: (limit = 50) =>
      read(async () => {
        const installationId = String(
          (await db.execute('SELECT id FROM device_info LIMIT 1')).rows[0].id,
        );
        const candidates = (
          await db.execute(
            `SELECT q.* FROM sync_queue q WHERE q.state='pending' AND q.next_attempt_at<=? AND EXISTS (
        SELECT 1 FROM sessions s WHERE s.state!='active' AND s.id=CASE q.entity_type
          WHEN 'session' THEN q.entity_id
          WHEN 'measurement' THEN (SELECT session_id FROM measurements WHERE id=q.entity_id)
          WHEN 'event' THEN (SELECT session_id FROM connectivity_events WHERE id=q.entity_id)
          WHEN 'snapshot' THEN (SELECT session_id FROM network_snapshots WHERE id=q.entity_id) END
      ) ORDER BY q.id LIMIT ?`,
            [Date.now(), limit],
          )
        ).rows;
        const records = [];
        for (const row of candidates) {
          const entityId = String(row.entity_id);
          let payload: Record<string, unknown>;
          if (row.entity_type === 'session') {
            payload = {
              ...toSession(
                (await db.execute(`${sessionSelect} WHERE s.id=?`, [entityId]))
                  .rows[0],
              ),
            };
          } else if (row.entity_type === 'measurement') {
            const m = (
              await db.execute(
                'SELECT result_json,scheduled_at FROM measurements WHERE id=?',
                [entityId],
              )
            ).rows[0];
            payload = {
              ...JSON.parse(String(m.result_json)),
              scheduledAt: m.scheduled_at,
            };
          } else if (row.entity_type === 'snapshot') {
            const r = (
              await db.execute(
                'SELECT session_id,payload_json FROM network_snapshots WHERE id=?',
                [entityId],
              )
            ).rows[0];
            payload = {
              ...JSON.parse(String(r.payload_json)),
              sessionId: r.session_id,
            };
          } else {
            const r = (
              await db.execute('SELECT * FROM connectivity_events WHERE id=?', [
                entityId,
              ])
            ).rows[0];
            payload = {
              id: r.id,
              sessionId: r.session_id,
              timestamp: r.timestamp,
              kind: r.kind,
              details: JSON.parse(String(r.details_json)),
            };
          }
          records.push({
            type: String(row.entity_type),
            id: entityId,
            version: Number(row.version),
            payload,
          });
        }
        return { installationId, records };
      }),
    acknowledgeSync: records =>
      write(async () => {
        for (const record of records) {
          await db.execute(
            "UPDATE sync_queue SET state='acknowledged',acknowledged_at=?,last_error=NULL WHERE entity_type=? AND entity_id=? AND version=?",
            [now(), record.type, record.id, record.version],
          );
        }
      }),
    failSync: (records, error) =>
      write(async () => {
        for (const record of records) {
          await db.execute(
            'UPDATE sync_queue SET attempts=attempts+1,last_error=?,next_attempt_at=?+MIN(3600000,1000*(1 << MIN(attempts+1,12))) WHERE entity_type=? AND entity_id=? AND version=?',
            [
              error.slice(0, 500),
              Date.now(),
              record.type,
              record.id,
              record.version,
            ],
          );
        }
      }),
    createSession: (config, resumedFromId) =>
      write(async () => {
        const sessionId = await id();
        const timestamp = now();
        await db.execute(
          "INSERT INTO sessions(id,started_at,last_observed_at,state,config_json,resumed_from_id) VALUES (?,?,?,'active',?,?)",
          [
            sessionId,
            timestamp,
            timestamp,
            JSON.stringify(config),
            resumedFromId ?? null,
          ],
        );
        await db.execute(
          'INSERT OR REPLACE INTO app_settings(key,value_json) VALUES (?,?)',
          ['last_session_config', JSON.stringify(config)],
        );
        await event(sessionId, 'session_started', {
          resumedFromId: resumedFromId ?? null,
        });
        await queue('session', sessionId);
        return sessionId;
      }),
    endSession: (sessionId, state, reason) =>
      write(async () => {
        const rows = (
          await db.execute('SELECT state FROM sessions WHERE id=?', [sessionId])
        ).rows;
        if (!rows.length || rows[0].state !== 'active') {
          return;
        }
        // If writing the final result failed, the durable pending attempt still becomes an interruption record.
        const pending = (
          await db.execute(
            "SELECT id FROM measurements WHERE session_id=? AND state='pending'",
            [sessionId],
          )
        ).rows;
        await db.execute(
          "UPDATE measurements SET state='complete' WHERE session_id=? AND state='pending'",
          [sessionId],
        );
        for (const row of pending) {
          await queue('measurement', String(row.id));
        }
        await db.execute(
          'UPDATE sessions SET state=?,ended_at=?,last_observed_at=? WHERE id=?',
          [state, now(), now(), sessionId],
        );
        await event(sessionId, 'session_ended', {
          state,
          reason,
          unfinishedProbes: pending.length,
        });
        await db.execute(
          'INSERT INTO debug_logs(session_id,timestamp,level,message) VALUES (?,?,?,?)',
          [sessionId, now(), state === 'completed' ? 'info' : 'error', reason],
        );
        await queue('session', sessionId);
      }),
    touchSession: sessionId =>
      write(async () => {
        await db.execute(
          "UPDATE sessions SET last_observed_at=? WHERE id=? AND state='active'",
          [now(), sessionId],
        );
      }),
    beginAttempt: (sessionId, type, scheduledAt) =>
      write(async () => {
        const session = (
          await db.execute(
            "SELECT config_json FROM sessions WHERE id=? AND state='active'",
            [sessionId],
          )
        ).rows[0];
        if (!session) {
          throw new Error('Cannot measure outside an active session.');
        }
        const config = JSON.parse(
          String(session.config_json),
        ) as MeasurementConfig;
        const result: Measurement = {
          id: await id(),
          sessionId,
          timestamp: now(),
          type,
          durationMs: 0,
          value: null,
          unit: type.endsWith('rtt') ? 'ms' : 'Mbps',
          success: false,
          errorType: 'interrupted',
          errorMessage:
            'Probe attempt began but no result was committed before interruption.',
          httpStatus: null,
          requestedBytes:
            type === 'icmp_rtt'
              ? 64
              : type === 'http_rtt'
              ? 4
              : type === 'download'
              ? config.downloadBytes
              : config.uploadBytes,
          transferredBytes: null,
          probeServer: config.serverUrl,
          probeRegion: null,
          networkSnapshot: null,
        };
        const used = Number(
          (
            await db.execute(
              "SELECT COALESCE(SUM(json_extract(result_json,'$.requestedBytes')),0) AS total FROM measurements WHERE session_id=?",
              [sessionId],
            )
          ).rows[0].total,
        );
        if (
          config.maxPayloadBytes !== undefined &&
          used + result.requestedBytes > config.maxPayloadBytes
        ) {
          throw new Error('Session payload budget reached.');
        }
        await db.execute(
          "INSERT INTO measurements(id,session_id,timestamp,scheduled_at,type,state,result_json) VALUES (?,?,?,?,?,'pending',?)",
          [
            result.id,
            sessionId,
            result.timestamp,
            scheduledAt,
            type,
            JSON.stringify(result),
          ],
        );
        await db.execute('UPDATE sessions SET last_observed_at=? WHERE id=?', [
          now(),
          sessionId,
        ]);
        return result;
      }),
    finishAttempt: result =>
      write(async () => {
        const row = (
          await db.execute(
            'SELECT state,session_id,type FROM measurements WHERE id=?',
            [result.id],
          )
        ).rows[0];
        if (
          !row ||
          row.session_id !== result.sessionId ||
          row.type !== result.type
        ) {
          throw new Error('Result does not match a recorded attempt.');
        }
        if (row.state === 'complete') {
          return;
        }
        await db.execute(
          "UPDATE measurements SET state='complete',timestamp=?,result_json=? WHERE id=?",
          [result.timestamp, JSON.stringify(result), result.id],
        );
        await queue('measurement', result.id);
        if (!result.success) {
          await event(result.sessionId, 'probe_failure', {
            measurementId: result.id,
            type: result.type,
            errorType: result.errorType,
          });
        }
        await db.execute('UPDATE sessions SET last_observed_at=? WHERE id=?', [
          now(),
          result.sessionId,
        ]);
      }),
    addEvent: (sessionId, kind, details) =>
      write(() => event(sessionId, kind, details)),
    listSessions: (limit = 20, offset = 0) =>
      read(async () =>
        (
          await db.execute(
            `${sessionSelect} ORDER BY s.started_at DESC,s.rowid DESC LIMIT ? OFFSET ?`,
            [limit, offset],
          )
        ).rows.map(toSession),
      ),
    getSession: sessionId =>
      read(async () => {
        const row = (
          await db.execute(`${sessionSelect} WHERE s.id=?`, [sessionId])
        ).rows[0];
        return row ? toSession(row) : null;
      }),
    listMeasurements: (sessionId, limit = 50, offset = 0) =>
      read(async () =>
        (
          await db.execute(
            'SELECT result_json,scheduled_at,state FROM measurements WHERE session_id=? ORDER BY timestamp DESC,rowid DESC LIMIT ? OFFSET ?',
            [sessionId, limit, offset],
          )
        ).rows.map(row => ({
          measurement: JSON.parse(String(row.result_json)) as Measurement,
          scheduledAt: String(row.scheduled_at),
          state: row.state as StoredMeasurement['state'],
        })),
      ),
    listEvents: sessionId =>
      read(async () =>
        (
          await db.execute(
            'SELECT * FROM connectivity_events WHERE session_id=? ORDER BY timestamp DESC,rowid DESC LIMIT 20',
            [sessionId],
          )
        ).rows.map(row => ({
          id: String(row.id),
          timestamp: String(row.timestamp),
          kind: String(row.kind),
          details: JSON.parse(
            String(row.details_json),
          ) as SessionEvent['details'],
        })),
      ),
    pendingCount: () =>
      read(async () =>
        Number(
          (
            await db.execute(
              "SELECT COUNT(*) AS total FROM sync_queue WHERE state='pending'",
            )
          ).rows[0].total,
        ),
      ),
  };
}
