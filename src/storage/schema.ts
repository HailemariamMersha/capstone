/** Version 1. Future schema upgrades must be additive migrations, never database resets. */
export const SCHEMA_VERSION = 2;
export const SCHEMA = [
  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT,
    last_observed_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','completed','interrupted')),
    config_json TEXT NOT NULL, resumed_from_id TEXT REFERENCES sessions(id))`,
  `CREATE TABLE measurements (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    timestamp TEXT NOT NULL, scheduled_at TEXT NOT NULL, type TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','complete')), result_json TEXT NOT NULL)`,
  `CREATE INDEX measurements_session_time ON measurements(session_id, timestamp DESC)`,
  `CREATE TABLE connectivity_events (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    timestamp TEXT NOT NULL, kind TEXT NOT NULL, details_json TEXT NOT NULL)`,
  `CREATE INDEX events_session_time ON connectivity_events(session_id, timestamp DESC)`,
  `CREATE TABLE network_snapshots (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), timestamp TEXT NOT NULL, payload_json TEXT NOT NULL)`,
  `CREATE TABLE sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, acknowledged_at TEXT, UNIQUE(entity_type, entity_id))`,
  `CREATE TABLE device_info (id TEXT PRIMARY KEY, platform TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE debug_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id),
    timestamp TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL)`,
  `CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)`,
];

export const MIGRATION_2 = [
  'ALTER TABLE sync_queue ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE sync_queue ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sync_queue ADD COLUMN last_error TEXT',
];
