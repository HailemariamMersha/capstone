# Crowdsourced Satellite Network Measurements on Moving Platforms

An Android capstone for collecting network performance data during flights and other mobility scenarios. The research contribution is an offline-first measurement infrastructure, a reliability evaluation, and a real or simulated mobility dataset.

## Architecture and scope

```text
React Native CLI + TypeScript UI (no Expo)
  → Kotlin native module
  → Android foreground measurement service
  → SQLite (OP-SQLite for RN access, WAL mode)
  → WorkManager deferred sync
  → FastAPI
  → PostgreSQL + TimescaleDB
  → Python/pandas analysis
```

Kotlin owns measurement execution independently of the JavaScript lifecycle. SQLite will be the local source of truth: persist every measurement before upload. Kotlin will write measurements, connectivity events, debug logs and sync-queue entries; React Native will handle session setup, settings, manual metadata and local history. Full records will be read from SQLite, not streamed through bridge events.

The MVP uses controlled HTTP RTT, download and upload probes, DNS-inclusive connection timing, connectivity gaps, and backend public-IP/ASN context. Manual flight/provider details and available WiFi metadata provide context; GPS is optional supporting evidence. HTTP RTT is an application-layer metric, not ICMP latency.

Planned backend: FastAPI in Docker on Fly.io, one region initially, with session creation, measurement/event batch ingestion, ping/download/upload probes, client-IP and config endpoints. Planned local tables: sessions, measurements, connectivity_events, sync_queue, device_info, debug_logs, user_settings and probe_config.

No Expo, Firebase primary storage, AsyncStorage measurement storage, third-party speed-test SDKs, required ICMP/traceroute, iOS implementation, complex login or real-time dashboard in the MVP. Multi-region probes, raw DNS timing, provider classification and public dataset publication are stretch goals.

## Milestones

| Milestone | Deliverable and acceptance | Target |
| --- | --- | --- |
| 1 — Native bridge proof | Start/stop Kotlin foreground service, persistent notification, status events and recovery of live status after reopening; 10–30 minute phone-lock test | Weeks 1–3 with M2 |
| 2 — Local data truth | SQLite/WAL, Kotlin test rows every 60 seconds, RN history, persistence and concurrent-access checks | Weeks 1–3 |
| 3 — Core probes | Native HTTP RTT every 60 seconds, controlled throughput, connection timing, failure/gap logs, minimal FastAPI probe server; multi-hour ground run | Weeks 4–6 |
| 4 — Backend and sync | PostgreSQL/TimescaleDB, durable queue, WorkManager retry, idempotent ingestion, single-region deployment | Weeks 7–9 |
| 5 — Context and reliability | Manual metadata, available WiFi/IP/ASN, optional location; fake-flight harness | Weeks 10–12 |
| 6 — Data collection | At least one flight dataset, or a controlled unstable-network/mobile fallback, through the entire pipeline | Weeks 12–13 |
| 7 — Analysis and report | Reproducible notebook with RTT, throughput and gaps; design, evaluation and limitations | Weeks 14–15 |

The fake-flight harness will cover phone lock, activity removal, process termination, WiFi toggling, airplane mode, backend outage/delay/failure, constrained bandwidth, reconnect, retry and duplicate prevention. Prove bridge and storage first; pass ground tests before relying on flight access.

## Current implementation: Milestone 1

The active app is TypeScript with Start, Stop and Refresh status controls. A Kotlin native module starts a native Android service with an ongoing notification, an open-app action and a Stop action. A native heartbeat provides a liveness check; it is not a network probe. Status comes from native process memory, including session ID, start time, elapsed duration and heartbeat count. UI reopening and JS reload query the existing service instead of starting another session.

The earlier JS/CSV prototype has been retired. No probes, SQLite, backend or synchronization are implemented yet. Application ID remains `com.labpracticeapp` to preserve the existing Android scaffold.

### Bridge contract

```ts
startSession(config: MeasurementConfig): Promise<string> // resolves when foreground startup succeeds
stopSession(): Promise<void> // resolves after service shutdown; safe when already stopped
getServiceStatus(): Promise<ServiceStatus>
```

M1 accepts an empty `MeasurementConfig`; probe configuration is reserved for M3. Status states are `stopped`, `starting`, `running` and `stopping`. Repeated starts reuse the current session; starting during shutdown rejects. `MeasurementServiceStatusChanged` carries lightweight status snapshots. Start failures reject and expose an error in status. RN subscribes to events and refreshes on foreground entry; events are not durable storage.

The service uses `specialUse` with an explicit research-measurement subtype because user-initiated continuous network observation does not fit deferred data transfer. A Play Store release would require review of this declaration. See [Android service types](https://developer.android.com/develop/background-work/services/fgs/service-types). The native module uses RN's supported legacy-module interoperability layer with the existing New Architecture scaffold; see [RN 0.84 compatibility](https://reactnative.dev/blog/2026/02/11/react-native-0.84).

M1 uses `START_NOT_STICKY`: activity removal does not intentionally stop the service, but force-stop, Android's active-app Stop, process death and reboot end the in-memory session. A fresh process reports stopped, never a stale running flag. Durable recovery belongs to later persistence/reliability work. A foreground service is not a guarantee against OS/OEM termination, and heartbeat callbacks can pause during deep sleep; elapsed duration uses Android's monotonic clock. No wake lock or battery-exemption prompt is needed for this service-lifecycle proof.

Android 13+ notification permission is requested when starting. Denial does not prevent the service from running, but the app explains that the notification may be hidden. No location permissions are requested in M1.

## Development

Prerequisites: Node >=22.11, JDK 17, Android SDK/platform 36, build tools 36.0.0 and NDK 27.1.12297006. Configure `ANDROID_HOME` or an ignored `android/local.properties` with your SDK path.

```bash
npm ci
npm start
```

In another terminal, with an emulator or USB-debugging phone attached:

```bash
adb devices
adb reverse tcp:8081 tcp:8081
npm run android
```

Checks:

```bash
npm run typecheck
npm run lint
npm test -- --runInBand --watchman=false
cd android
./gradlew :app:assembleDebug
```

For endurance tests use a bundled build so Metro is not a dependency:

```bash
cd android
./gradlew :app:assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

The scaffold's release variant uses the debug signing key and is for local testing only.

## Milestone 1 device acceptance

1. Launch and verify stopped. Start: a session ID and running status appear, along with an ongoing notification when permitted. Repeated start requests must retain the session ID.
2. Lock the phone for 10 minutes, then repeat for 30 minutes. Reopen and refresh: verify the same session ID/start time, running status and elapsed duration. Record device/Android version, notification visibility and observations; heartbeat count alone is not an exact scheduling assertion.
3. Press Home, reopen, then remove the activity from Recents and reopen. Verify native status without creating a new session. Also reload JS in a debug build while running.
4. Stop from the app, then from the notification in a second session. Verify stopped status and notification removal. Repeated stop is harmless; a new start gets a new ID.
5. On Android 13+, test both granted and denied notification permission. Confirm the denial message and functioning controls. Test a service-start rejection and confirm the UI re-enables controls and displays the error.
6. Force-stop via Settings or `adb shell am force-stop com.labpracticeapp`, then reopen. Verify stopped status; M1 does not promise recovery after process death.

Use `adb shell dumpsys activity services com.labpracticeapp` to verify the native service and `adb logcat -s MeasurementService` to inspect native lifecycle/heartbeat logs. Automated UI tests do not establish phone-lock endurance; the physical-device checks above remain necessary.

### Validation recorded — 2026-09-14

- `npm run typecheck` and `npm run lint`: passed.
- Jest: 9 tests passed (status restoration, start/stop, native events, permission denial, startup failure, stale-query handling, listener cleanup, rapid taps and status-query retry).
- `:app:assembleRelease`: passed; bundled APK at `android/app/build/outputs/apk/release/app-release.apk`.
- Android API 36.1 ARM64 emulator: native foreground startup (`isForeground=true`), visible ongoing notification, native heartbeat during a roughly one-minute screen-off check, same session on reopen, notification Stop, app Stop, new IDs for new sessions, and stopped status after force-stop/relaunch all verified.
- Still pending: physical-device 10–30 minute lock endurance, confirmed task-removal behavior, JS-reload runtime check, and device/OEM variation. The emulator smoke test does not satisfy those endurance criteria.
