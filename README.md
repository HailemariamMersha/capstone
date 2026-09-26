# Crowdsourced Satellite Network Measurements on Moving Platforms

An Android capstone for measuring network performance during flights and other mobility scenarios. We ship Android this semester and develop shared React Native/TypeScript code for a later iPhone release. The research contribution is an offline-first measurement pipeline, reliability evaluation and a real or simulated mobility dataset.

The authoritative scope and M1–M11 acceptance criteria are in the [full semester plan](docs/semester-plan.md).

## Architecture

**Cross-platform by default; use React Native libraries for operating-system integration.**

```text
React Native CLI + TypeScript (no Expo)
  UI / shared session controller / scheduled HTTP probe engine
    → react-native-background-actions (platform background execution)
    → OP-SQLite in WAL mode (local source of truth)
    → deferred synchronization (planned)
    → FastAPI → PostgreSQL + TimescaleDB → Python/pandas analysis
```

Session orchestration, scheduling, HTTP probes and persistence logic run in TypeScript. The background-actions library owns its native foreground service; there is no custom Kotlin measurement service or bridge. `MainActivity.kt` and `MainApplication.kt` are the standard React Native Android bootstrap files, not measurement logic. Dependencies can still contain native implementations.

Keep probe definitions, HTTP RTT/download/upload logic, configuration, data models, database schema, API client and sync orchestration shared. Platform permissions and background execution remain isolated. iOS will reuse this application code, but its background execution and release configuration must be validated separately; continuous locked-phone measurement is not established on iOS. The library documents the distinction in its [background execution guidance](https://github.com/Rapsssito/react-native-background-actions#readme).

Android uses a declared `specialUse` foreground service for user-started research measurement, with foreground-service, notification and wake-lock permissions. The service type is supplied both in the manifest and library options. Play Store distribution requires review of this use case; see [Android service types](https://developer.android.com/develop/background-work/services/fgs/service-types). The pinned library version is installed through npm without local native patches.

## Current implementation: controlled measurements, context, export and sync

The app runs scheduled HTTP RTT, download and upload probes through `react-native-background-actions`. Default intervals remain 60 seconds for RTT and five minutes for download/upload, with an immediate initial batch. Payloads remain 1 MiB download and 256 KiB upload; settings also offer 5/10 MiB download and 1 MiB upload. Probes run serially; missed intervals are logged and skipped instead of replayed in a burst.

Optional **ICMP RTT** uses `ping-react-native` when you enter a hostname or IP. It runs at the RTT interval and stores native RTT/TTL separately from total probe duration. ICMP does not use USB forwarding: `127.0.0.1` pings the phone itself. Compare with HTTP against the same remote host; a missing ICMP reply does not establish an internet outage.

**Session safeguards** default to two hours, a 100 MiB planned-payload allowance, and stopping at or below 15% battery when unplugged. Attempts reserve their full payload allowance, including failures and cancellations. This is not a carrier-data counter: headers, retransmissions and context/sync traffic are outside the allowance. The first exhausted limit ends the session and records its reason. Existing session configurations are normalized when resumed.

**Context snapshots** record network type, connectivity, available Wi-Fi details, battery percentage, charging state and server-observed public IP/ASN. They are collected at session start, about once a minute and after network changes, between probes. Location permission for Wi-Fi details is optional and requested only by the dedicated button; denied/unavailable values stay null. No GPS coordinates are collected. ASN enrichment requires a server-side database; local USB requests correctly have no public IP/ASN. Third-party NetInfo reachability polling is disabled. Context requests can warm the probe connection and are outside its timed interval.

**OP-SQLite** remains the local source of truth. Schema version 2 migrates version 1 without deleting records, enables WAL/foreign keys, and serializes transactions. An attempt is committed before its network request. Results and sync queue entries are committed together. On a new JS process, old active sessions and unfinished attempts become interrupted; recovery never restarts collection automatically. Resume creates a new linked session.

**Export CSV / Export JSON** is available for every saved session. CSV contains all measurements, including rows beyond the visible history page. JSON includes session configuration, measurements, events and context snapshots. Exports are generated from consistent repository reads; a live SQLite database file is never copied. Spreadsheet formula characters are escaped in CSV. Files remain in the app cache until replaced or cleared; sharing uses the platform share sheet.

**Sync now** sends up to 50 pending records from closed sessions to the entered server. The local FastAPI server now accepts `/api/v1/ingest`, commits records to SQLite and acknowledges individual IDs/versions. Duplicate uploads do not create duplicate records. Only matching acknowledgements clear queue entries; errors and unacknowledged records get persistent exponential backoff (up to an hour). Continue tapping Sync now, or enable automatic retries every 30 seconds while the app is visible and collection is stopped. Stop collection before syncing; the UI prevents starting a measurement during sync. Sync destination/token are held only in memory for the current app run. Queue data persists across restarts.

Remote sync requires HTTPS and a server token. The local server defaults to `backend/data/ingestion.sqlite`, which is gitignored. This is the local ingestion prototype; PostgreSQL/TimescaleDB, cloud deployment and closed-app background sync remain future work. Export and measurement collection do not require sync.

Traceroute and the commercial SpeedChecker SDK were evaluated from their published source but are not integrated because of concrete Android compatibility/initialization blockers. See [library evaluation and methodology](docs/library-evaluation.md). Our shared application logic remains TypeScript; native libraries provide OS integration. iOS is not validated.

## Code organization

- `src/sessions/`: configuration, lifecycle state machine and serialized operations.
- `src/background/`: background-actions adapter and task-start acknowledgement.
- `src/measurements/`: HTTP/ICMP adapters, schedules, safeguards and structured results.
- `src/storage/`: OP-SQLite adapter, schema, transactional repository and recovery.
- `src/components/SessionSettings.tsx`, `SessionHistory.tsx`: configuration and saved history.
- `src/services/measurement.ts`, `App.tsx`: composition, permissions and controls.
- `src/network/`: NetInfo and battery context collection.
- `src/export/`, `src/sync/`: CSV/JSON sharing and acknowledged batch synchronization.
- `src/api/`, `backend/`: shared protocol and local FastAPI probe server.

```ts
startSession(config?: MeasurementConfig, resumedFromId?: string): Promise<string>
stopSession(): Promise<void>
getServiceStatus(): Promise<ServiceStatus>
subscribeToStatus(listener: (status: ServiceStatus) => void): () => void
```

Status states are `stopped`, `starting`, `running` and `stopping`. Repeated starts share the active session; stop is idempotent. Startup requires native task acknowledgement. Failed platform cleanup preserves a retryable Stop control.

## Revised semester milestones

| Milestone | Deliverable and acceptance | Timeline |
| --- | --- | --- |
| M1 — Project foundation | RN CLI/TypeScript, shared interfaces and architecture, Android build and basic screen on a physical phone | Week 1 |
| M2 — RN measurement proof | Reusable TypeScript RTT/download/upload probes, configuration, timeout/error results, temporary screen and minimal FastAPI probes | Weeks 2–3 |
| M3 — Background execution proof | Library-backed TypeScript probes continue for 30–60 minutes locked/backgrounded, with explainable timing and session status on reopen | Weeks 3–4 |
| M4 — Offline-first storage | SQLite/OP-SQLite with WAL; save measurements before upload; local history, session recovery, durable queue | Weeks 4–5 |
| M5 — Complete measurement engine | Separate probe schedules, connection timing if feasible, failure/gap logs, structured context, battery/data safeguards; multi-hour ground run | Weeks 6–7 |
| M6 — Backend and deferred sync | FastAPI ingestion, PostgreSQL/TimescaleDB, acknowledged batches, idempotent IDs, retries, first deployed region | Weeks 8–9 |
| M7 — Network and flight context | NetInfo, available WiFi metadata, backend public IP/ASN, manual flight/provider details, optional location | Weeks 10–11 |
| M8 — Fake-flight evaluation | Lock, background, process loss, reconnect, network interruption, backend outage/delay, failed probes/uploads, repeated sync and OS service limits | Weeks 11–12 |
| M9 — Real-world validation | Flight dataset if available, otherwise a controlled unstable-network or mobile fallback; full phone-to-analysis path | Weeks 12–13 |
| M10 — Analysis | Reproducible pandas/Jupyter RTT, throughput, outages, context and success-rate figures | Weeks 13–14 |
| M11 — Finalization | Stable Android prototype, documented methods/limitations, dataset format, demo, report and presentation | Weeks 14–15 |

M3 is an experimental gate: an active notification alone does not prove that TypeScript probes keep executing. Validate actual timestamps and results. If the library-backed approach fails, resolve the background architecture before flight collection. Do not silently reintroduce custom native measurement logic.

Planned initial schedule: connectivity every 15–30 seconds, RTT every 60 seconds, download/upload every five minutes, metadata on change plus periodic snapshots, public IP/ASN at session start and network changes, optional low-frequency location, and sync independently when connectivity is suitable.

SQLite now persists measurements before any future upload attempt; backend ingestion remains planned. Backend: FastAPI in Docker, PostgreSQL + TimescaleDB, initially one Fly.io region. Probes use controlled HTTP endpoints; HTTP RTT is an application-layer measurement, not ICMP latency. GPS and SSID availability must not block collection.

Before a flight, prove the entire ground pipeline: start → background probes → local persistence → network loss and failure records → reconnect → idempotent sync → analysis. iOS release, additional probe regions, raw DNS, traceroute, advanced provider classification, dashboard and public dataset interface are later work. No third-party speed-test SDK or complex login is required for the MVP.

## Development

Prerequisites: Node >=22.11, JDK 17, Android SDK/platform 36, build tools 36.0.0 and NDK 27.1.12297006. Configure `ANDROID_HOME` or an ignored `android/local.properties` with your SDK path.

```bash
npm ci
npm start
```

With an emulator or USB-debugging phone attached, in another terminal:

```bash
adb devices
adb reverse tcp:8081 tcp:8081
npm run android
```

Validation:

```bash
npm run typecheck
npm run lint
npm test -- --runInBand --watchman=false
cd android
./gradlew :app:assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

The bundled release variant does not need Metro, but currently uses the scaffold's debug signing key for local testing. Application ID remains `com.labpracticeapp`. iOS simulator/device builds and signing are not validated this semester.

## Run scheduled measurements locally

From the repository root (Python 3.14 was used for validation):

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

In another terminal, connect the emulator or USB-debugging phone:

```bash
adb reverse tcp:8000 tcp:8000
```

Open the app, leave the URL at `http://127.0.0.1:8000`, and tap **Start session**. View the session in **Saved sessions** to see RTT, download and upload results. Background or lock the phone, reopen it and refresh history. Stop the server to verify persisted failure results. **Stop session** aborts any in-flight probe, saves its cancellation and ends the session.

Force-stop and relaunch during a session to test recovery: it should be stopped, the old session should be interrupted, and saved results should remain. Resume that history entry to start a linked session. Do not clear app data for this check.

Android release networking permits HTTP only for localhost, 127.0.0.1 and the emulator host alias 10.0.2.2. Other release servers must use HTTPS. Debug builds additionally allow HTTP LAN servers for development. The local server needs no cloud account or deployment.

Backend tests:

```bash
backend/.venv/bin/python -m pytest backend/tests -q
```

## Background and recovery acceptance checklist

1. Start: running only after the library task starts, with a session ID and foreground notification when allowed. Confirm actual successful probes in saved history.
2. Stop: abort and save the current probe, stop timers/service and mark the session completed. Repeated starts/stops must not create duplicate services.
3. Lock/background for **30 minutes, 60 minutes and two hours on a physical Android phone**, using a bundled build. Record device/OS, timestamps, gaps, results, battery and data usage. A notification or heartbeat alone does not satisfy M3.
4. Test removal from Recents separately from force-stop. Relaunch after process loss: stopped status, interrupted previous session, preserved results and unfinished-attempt recovery. Resume must create a linked new ID.
5. Test notification denial, startup rejection/timeout, database failure and retry.
6. Disconnect the network and stop/delay the server: failed probes must persist, collection must remain controllable, and reconnect must permit later successful probes. Queue entries must survive restarts; after sync, verify matching records exist on the server before they disappear from the pending count.

Inspect Android service state with `adb shell dumpsys activity services com.labpracticeapp`. Unit tests cannot establish OS/OEM endurance. M3 remains an experimental gate until the physical runs pass. Full M5/M6 acceptance, cloud deployment and physical reliability testing are necessary before the flight pipeline is ready.

## Validation

- The earlier M2 emulator test verified two RTT/download/upload batches against local FastAPI, then three structured failures with the server stopped. All 13 backend contract tests passed.
- Automated checks now cover native task acknowledgement, startup/cleanup failures, session lifecycle, cancellation, skipped intervals, persisted history and real SQLite transactions. Repository tests verify WAL, restart recovery, durable IDs, rollback when queue insertion fails, concurrent operations and schema-version rejection, version-one migration, export completeness, limits and acknowledged sync. SQLite tests use Node's `node:sqlite`; use Node 22.13+ for these tests (Node 26.5 used here).
- Physical-phone 30/60/120-minute background endurance, battery impact, Recents behavior and iOS builds remain pending. Emulator checks establish functionality only, not satellite performance or physical-device reliability.

### M3/M4 implementation checks — 2026-09-18

- TypeScript, ESLint and 54 Jest tests passed; all 13 backend tests passed.
- Android release build passed with OP-SQLite 18.2.3 and background-actions 4.1.0; no custom Kotlin measurement implementation remains.
- API 36.1 ARM64 emulator: actual RTT, 1 MiB download and 256 KiB upload succeeded and appeared in SQLite-backed history. Android reported the library service as foreground.
- A resumed session completed a scheduled RTT at `11:59:40Z` during a screen-off interval of more than one minute; its initial probes ran at `11:58:40Z`. History showed the same session with four successful results.
- Force-stop/relaunch retained results, marked the old session interrupted and left runtime status stopped. Resume created a new durable ID linked to the old session and reused its configuration.
- With a deliberately delayed RTT endpoint, force-stop during the request recovered one explicit `interrupted` result with unconfirmed bytes, retaining earlier successes and pending queue entries.
- Normal Stop during a delayed request persisted a `cancelled` result, completed the session and removed the foreground service (`dumpsys` showed none).
- These bounded emulator checks support the implementation; the physical-device endurance checklist above is still open. Backend synchronization is not implemented.


### Testing the new features

1. Install the rebuilt release APK with `adb install -r` to retain existing data. Migration is automatic.
2. Start the updated backend and reconnect `adb reverse tcp:8000 tcp:8000`.
3. For a short test, set maximum duration to one minute. Optionally enter `127.0.0.1` as an explicitly local ICMP adapter test. The session should stop automatically, record its reason, and retain results/context.
4. Export CSV and JSON from that session using the phone share sheet. Check that JSON includes configuration/events/snapshots.
5. With collection stopped, use `http://127.0.0.1:8000` in Sync server URL and tap Sync now. Up to 50 records are acknowledged per batch; repeat or enable automatic retries to drain the queue.
6. Stop the server, sync another completed session, restart the server, and wait for backoff before retrying. Confirm the server retains one record per installation/type/ID.
7. For actual-network ICMP/public-IP tests, use a reachable remote probe server. USB/loopback results cannot validate those network paths. Physical-phone endurance and iOS validation remain open.

### Export/context/ICMP/sync validation — 2026-09-26

- TypeScript, ESLint and 72 Jest tests pass; 16 backend tests pass. Android release assembly passes with the newly pinned native libraries.
- Existing emulator sessions from schema version 1 remain visible after the schema version 2 upgrade. Automated migration tests also verify record preservation and recovery.
- Two one-minute emulator sessions ended automatically with `session_limit: duration` events. The ICMP-enabled session saved HTTP RTT, download, upload and one successful local ICMP sample (native RTT and TTL), plus Wi-Fi/battery/charging context.
- Native Android share sheets opened with `session.json` and `session.csv` attachments. Automated export tests cover quoting and complete history beyond 50 rows.
- Emulator to FastAPI ingestion: 41 records acknowledged (5 sessions, 17 measurements, 16 events, 3 snapshots), verified in the server SQLite database; pending count became zero.
- Loopback ICMP and USB HTTP validate implementation only. Actual-network comparison, physical-phone endurance with the new dependencies, optional Wi-Fi details across manufacturers, remote ASN enrichment and iOS validation remain open.
