> **Current library-only collection:** Android packet measurements now use `icmpenguin`, `react-native-tcp-socket` and `react-native-udp`. The custom C++ engine is preserved on `experiment/custom-packet-engine`. See [library choices, exact field limitations and comparison commands](docs/library-packet-comparison.md). Historical custom-engine validation below applies to that baseline.

# SkyMeasure

SkyMeasure now includes a participant app and a private researcher workspace around the existing library collector. See the [staging setup guide](docs/skymeasure/setup.md), [delivery and validation record](docs/skymeasure/validation.md), and [combined CSV guide](docs/skymeasure/combined-csv.md).

The participant app uses React Native Paper and React Navigation, Google OAuth through Supabase PKCE, encrypted Keychain sessions, and account-owned OP-SQLite records. Home, Sessions, and Account replace the technical prototype screen. The Next.js dashboard shows received sessions, individual observations, researcher membership, and authenticated JSON/CSV downloads. FastAPI `/api/v2` stores queryable evidence and original JSONB in PostgreSQL. Public signup does not grant researcher access.

**Staging inputs are required:** deployment domains, approved research information, and a connected Android phone for real Google/background validation. The checked-in app deliberately displays setup pending until public service configuration is supplied. A one-GiB London pilot runs the bounded public UDP service and a private HTTP API connected to Supabase with verified database TLS. The Google provider is enabled and the research schema is ready; public HTTPS, the dashboard, account-deletion credentials and real participant sign-in/upload validation remain pending.

## Crowdsourced satellite network measurements on moving platforms

An Android capstone for measuring network performance during flights and other mobility scenarios. We ship Android this semester and develop shared React Native/TypeScript code for a later iPhone release. The research contribution is an offline-first measurement pipeline, reliability evaluation and a real or simulated mobility dataset.

The semester milestones are in the [full semester plan](docs/semester-plan.md). The [packet-engine update](docs/packet-engine.md) records the subsequently requested packet-level methods and replaces the earlier HTTP-first collection defaults.

## Understand the collected data

Start with the [measurement guide](docs/measurements/guide.md), [column dictionary](docs/measurements/columns.md), and [library versus native audit](docs/measurements/comparison.md). Generate six readable measurement CSVs and sanity-check reports from a saved JSON export:

```sh
npm run measurements:analyze -- --input /path/to/session.json --out /path/to/new-analysis-directory
```

## Architecture

**Cross-platform by default; use React Native libraries for operating-system integration.**

```text
React Native CLI + TypeScript (no Expo)
  UI / shared session controller / packet probes + optional HTTP
    → react-native-background-actions (platform background execution)
    → OP-SQLite in WAL mode (local source of truth)
    → account-owned deferred sync (closed sessions; foreground + Android Headless JS)
    → authenticated FastAPI → Supabase PostgreSQL / JSONB → private Next.js dashboard
```

Session orchestration, scheduling, HTTP probes and persistence logic run in TypeScript. The background-actions library owns its native foreground service; there is no custom Kotlin measurement service. Thin Android bridges expose the pinned icmpenguin ping/traceroute library and optional SpeedChecker SDK. TCP and UDP echo use React Native socket libraries. Scheduling, result interpretation, storage and UI stay in TypeScript. See [the library comparison](docs/library-packet-comparison.md).

Keep probe definitions, HTTP RTT/download/upload logic, configuration, data models, database schema, API client and sync orchestration shared. Platform permissions and background execution remain isolated. iOS will reuse this application code, but its background execution and release configuration must be validated separately; continuous locked-phone measurement is not established on iOS. The library documents the distinction in its [background execution guidance](https://github.com/Rapsssito/react-native-background-actions#readme).

Android uses a declared `specialUse` foreground service for user-started research measurement, with foreground-service, notification and wake-lock permissions. The service type is supplied both in the manifest and library options. Play Store distribution requires review of this use case; see [Android service types](https://developer.android.com/develop/background-work/services/fgs/service-types). The pinned library version is installed through npm without local native patches.

## Collection implementation: controlled measurements, context, export and sync

New UI sessions default to **packet measurements**: ten-sample ICMP bursts and UDP traceroute to `google.com`. TCP connects to `https://google.com` (port 443); controlled UDP and optional HTTP use build-time study endpoints. Participants do not enter URLs or shared tokens. Android ICMP and traceroute use icmpenguin; TCP and UDP echo use their React Native libraries. Available reply bytes and raw callbacks are retained; kernel TCP_INFO is unavailable in this build. HTTP is opt-in. React Native/TypeScript still owns the UI, scheduling, interpretation, storage and exports.

Enable **HTTP measurements** for controlled RTT/download/upload or loaded latency. Transfer sizes remain editable from 1 byte to 100 MiB per direction (defaults: 1 MiB download, 256 KiB upload), within the session budget. Old saved configurations preserve their original schedules. Tests run serially except explicit loaded-latency transfers; missed intervals are logged and skipped.
Downloads larger than 8 MiB use the existing filesystem library to stream into a temporary cache file, avoiding React Native full-body/base64 memory copies. These results use method `http_download_to_file`, including disk-write time; smaller downloads retain `http_full_transaction`. Native transfer completion is awaited before cleanup or the next probe.

**ICMP, TCP, UDP and traceroute** retain available library results, failures and raw output. ICMP header fields are decoded from actual returned bytes and replies are checked against the requested sequence/payload. Library-classified traceroute errors retain their original labels; unavailable ICMP type/code fields remain empty. TCP retains endpoint metadata and application counters, with callback timing that includes resolution. Controlled UDP echo retains datagram bytes and requires a reachable server. These are active-probe observations, not full IP packet capture. See [methods, limits and comparison](docs/library-packet-comparison.md).

**Participant session safeguards** default to ten minutes, a 100 MiB planned-payload allowance, and stopping at or below 15% battery when unplugged. The configurable session allowance supports up to 16 GiB for long experiments; the per-probe maximum remains 100 MiB. Attempts reserve their full payload allowance, including failures and cancellations. This is not a carrier-data counter: headers, retransmissions and context/sync traffic are outside the allowance. The first exhausted limit ends the session and records its reason. Existing session configurations are normalized when resumed.

**Context snapshots** record network type, connectivity, available Wi-Fi details, battery percentage, charging state and server-observed public IP/ASN. They are collected at session start, about once a minute and after network changes, between probes. Location permission for Wi-Fi details is optional and requested only by the dedicated button; denied/unavailable values stay null. The controlled context pipeline does not collect GPS coordinates. The separately consented SpeedChecker free SDK requires location and shares data with its vendor. ASN enrichment requires a server-side database; local USB requests correctly have no public IP/ASN. Third-party NetInfo reachability polling is disabled. Packet-only sessions skip HTTP context requests, leaving public IP/ASN null. When enabled, context requests can warm the probe connection and are outside its timed interval.

**OP-SQLite** remains the local source of truth. Schema version 3 adds account ownership and upload state without deleting existing records, enables WAL/foreign keys, and serializes transactions. An attempt is committed before its network request. Results and sync queue entries are committed together. On foreground recovery, old active sessions and unfinished attempts become interrupted; background upload initialization does not close an active session; recovery never restarts collection automatically. Resume creates a new linked session.

**Export CSV / Export JSON** is available for every saved session. Format-4 CSVs omit custom-only kernel/socket columns: 70 measurement columns and 64 sample columns. CSV shares a bundle of measurement, individual sample, event and network-context tables, together with the full saved JSON and a field guide. The eight-file bundle includes `packets.jsonl` for available decoded/native observations and `library-callbacks.jsonl` for retained library requests and callbacks, alongside per-probe CSV fields and bounded reference logs. Buffer scopes distinguish application payloads and ICMP messages; historical native observations remain preserved in JSON. Exports include all rows beyond the visible history page and preserve failures and missing values. See [export fields and computer-side conversion](docs/packet-exports.md) and [Linux mechanisms, library justification and related papers](docs/research/packet-measurement-review.md). Exports use consistent repository reads; a live SQLite database is never copied. Spreadsheet formula characters are escaped in CSV. Stable cache files are shared through the OS share sheet.

**Automatic account uploads** run after collection stops, on app opening, when connectivity changes, and during Android background opportunities. Wi-Fi is the default. The reusable service shares the collection activity gate, checks persisted active sessions, uses bounded versioned batches, persists retry backoff, and refreshes credentials before sending. Expired login leaves records pending. A manifest registers expected IDs/versions first; the server marks complete only after reconciliation. Historical ownerless experiments remain local/exportable, and cannot enter another account's queue.

Supabase validates authentication; FastAPI enforces ownership and team roles. PostgreSQL tables retain original JSONB plus indexed measurement/sample fields. The dashboard refreshes every 15 seconds while visible and knows only what has arrived. Background retry timing is opportunistic; force-stopped Android apps retry only after reopening. See the [setup and device acceptance instructions](docs/skymeasure/setup.md).

**Developer-only M-Lab NDT7 reference tests** (retained in the legacy collector, outside the participant onboarding flow) use the pinned official browser client inside React Native WebView. They require explicit consent, run separately from scheduled collection/sync, cancel when the app leaves the foreground, and save download/upload results through the existing history/export/sync pipeline. A reported 50 MiB per direction triggers a best-effort stop; buffered traffic can exceed it. See [reference-test methods and validation](docs/reference-tests.md). Public-service physical-phone validation remains pending.

**Traceroute** uses pinned `icmpenguin` 1.0.0-rc.3 on this comparison branch; its complete library results are retained. Partial results and all exposed library fields are preserved; missing kernel fields are not reconstructed. **SpeedChecker** SDK 4.2.299 is available in an opt-in Android build with consent before initialization, foreground cancellation and separate saved reference results. See [setup, methods and remaining physical tests](docs/native-adapters.md). See [library evaluation and methodology](docs/library-evaluation.md). Our shared application logic remains TypeScript; native libraries provide OS integration. iOS is not validated.

The [custom-payload phone experiment](docs/experiments/2026-09-28-custom-payloads.md) verified three 5 MiB downloads and three 2 MiB uploads, exact saved byte counts, automatic session completion and successful sync.

## Code organization

- `src/sessions/`: configuration, lifecycle state machine and serialized operations.
- `src/background/`: background-actions adapter and task-start acknowledgement.
- `src/measurements/`: HTTP/ICMP adapters, schedules, safeguards and structured results.
- `src/storage/`: OP-SQLite adapter, schema, transactional repository and recovery.
- `src/components/SessionSettings.tsx`, `SessionHistory.tsx`: configuration and saved history.
- `src/services/measurement.ts`, `App.tsx`: composition, permissions and controls.
- `src/network/`: NetInfo and battery context collection.
- `src/reference/`: separate NDT7 and SpeedChecker reference-test flows.
- `android/app/src/main/java/com/labpracticeapp/diagnostics/`: Thin Android library bridges.
- `android/app/src/speedchecker/`: opt-in vendor SDK adapter and manifest overlay.
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

M3 is an experimental gate: an active notification alone does not prove that TypeScript probes keep executing. Validate actual timestamps and results. If the library-backed approach fails, resolve the background architecture before flight collection. The explicitly requested native packet adapter supplies OS socket evidence; it does not replace the shared background/session controller.

Planned initial schedule: connectivity every 15–30 seconds, RTT every 60 seconds, download/upload every five minutes, metadata on change plus periodic snapshots, public IP/ASN at session start and network changes, optional low-frequency location, and sync independently when connectivity is suitable.

SQLite persists measurements before upload attempts; the local backend acknowledges ingestion batches. The deployment stack is FastAPI in Docker on DigitalOcean, Supabase PostgreSQL, and a Vercel researcher dashboard; TimescaleDB is not required. The initial probe host is in London (`lon1`), replacing the originally planned Frankfurt host. Its private API connects to the London Supabase project through a dedicated database role and private `skymeasure` schema. Public authenticated uploads and the dashboard still await HTTPS/deployment and real-account validation. Probes use controlled HTTP endpoints; HTTP RTT is an application-layer measurement, not ICMP latency. GPS and SSID availability must not block collection.

Before a flight, prove the entire ground pipeline: start → background probes → local persistence → network loss and failure records → reconnect → idempotent sync → analysis. iOS release, additional probe regions, raw DNS, advanced provider classification, a public dataset interface are later work. The private researcher dashboard is implemented in `dashboard/`. Optional Android traceroute and reference-test adapters are now implemented; field validation remains open. Participant signup uses Google through Supabase; third-party speed-test reference flows remain developer tools.

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

The following legacy collector procedure applies to the earlier technical screen; use the SkyMeasure setup guide for the new participant build. To test HTTP, first enable **HTTP measurements**. Leave the URL at `http://127.0.0.1:8000`, and tap **Start session**. View the session in **Saved sessions** to see RTT, download and upload results. Background or lock the phone, reopen it and refresh history. Stop the server to verify persisted failure results. **Stop session** aborts any in-flight probe, saves its cancellation and ends the session.

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

- The packet engine passed all nine native checks on the physical Galaxy A34. A [two-minute Google-target phone run](docs/experiments/2026-10-03-google-phone.md) received 20/20 ICMP replies, connected TCP twice and reached Google at traceroute hop 10 with original ICMP type/code values preserved. All records synced and raw exports were verified. Long-run/locked-screen and satellite-path validation remain pending. See [current validation details](docs/packet-engine.md).

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
- These bounded emulator checks support the implementation; the physical-device endurance checklist above is still open. Backend synchronization was added in the later increment below.


### Testing the new features

1. Install the rebuilt release APK with `adb install -r` to retain existing data. Migration is automatic.
2. Start the updated backend and reconnect `adb reverse tcp:8000 tcp:8000`.
3. For a short test, set maximum duration to one minute. Optionally enter `127.0.0.1` as an explicitly local ICMP adapter test. The session should stop automatically, record its reason, and retain results/context.
4. Export CSV and JSON from that session using the phone share sheet. Check that JSON includes configuration/events/snapshots.
5. On the historical developer UI (not the participant app), with `CAPSTONE_LOCAL_DEV=1` and collection stopped, use `http://127.0.0.1:8000` in Sync server URL and tap Sync now. Up to 50 records are acknowledged per batch; repeat or enable automatic retries to drain the queue.
6. Stop the server, sync another completed session, restart the server, and wait for backoff before retrying. Confirm the server retains one record per installation/type/ID.
7. For actual-network ICMP/public-IP tests, use a reachable remote probe server. USB/loopback results cannot validate those network paths. Physical-phone endurance and iOS validation remain open.

### Export/context/ICMP/sync validation — 2026-09-26

- TypeScript, ESLint and 72 Jest tests pass; 16 backend tests pass. Android release assembly passes with the newly pinned native libraries.
- Existing emulator sessions from schema version 1 remain visible after the schema version 2 upgrade. Automated migration tests also verify record preservation and recovery.
- Two one-minute emulator sessions ended automatically with `session_limit: duration` events. The ICMP-enabled session saved HTTP RTT, download, upload and one successful local ICMP sample (native RTT and TTL), plus Wi-Fi/battery/charging context.
- Native Android share sheets opened with `session.json` and `session.csv` attachments. Automated export tests cover quoting and complete history beyond 50 rows.
- Emulator to FastAPI ingestion: 41 records acknowledged (5 sessions, 17 measurements, 16 events, 3 snapshots), verified in the server SQLite database; pending count became zero.
- Loopback ICMP and USB HTTP validate implementation only. Actual-network comparison, physical-phone endurance with the new dependencies, optional Wi-Fi details across manufacturers, remote ASN enrichment and iOS validation remain open.
