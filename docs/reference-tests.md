# Optional M-Lab NDT7 reference test

The app integrates `@m-lab/ndt7` **0.1.5** through `react-native-webview` **14.0.1**. The official browser client performs discovery and its unmodified download/upload workers generate traffic. A small browser coordinator handles cancellation, timeouts, result validation and communication with shared TypeScript code. No custom Kotlin/Java measurement logic was added.

## Running a reference test

1. Install the release APK and stop scheduled collection/sync.
2. Open **M-Lab NDT7 reference test**. Read the linked [M-Lab data policy](https://www.measurementlab.net/privacy/). Public M-Lab testing collects your public IP and publishes measurement data.
3. Accept the disclosure, then tap **Start NDT7 reference test**. Consent resets after each start; there is no automatic reference testing.
4. Keep the app visible. Cancel explicitly or leave/lock the app to stop the test. Each direction normally runs for approximately ten seconds after connection; discovery/handshakes add time.
5. Inspect the separate reference entry in **Saved sessions**, export CSV/JSON, or synchronize it with the existing backend.

This test connects directly to public M-Lab servers over HTTPS/WSS. USB `adb reverse` and the controlled HTTP server settings do not change its destination. It measures the phone's current internet path, which is a satellite path only when that is how the phone reaches the internet.

## Data use and interpretation

A reported **50 MiB per direction** triggers termination of the entire reference run. This is a best-effort threshold, **not a hard carrier-data cap**: worker reporting intervals, WebSocket queues, in-flight bytes, transport headers and retransmissions can increase actual consumption. The upstream upload implementation can buffer substantial data. Threshold stops are incomplete/failed results with partial counters, not successful reference speeds. Use controlled fixed-payload HTTP probes when strict planned payload sizes matter.

The two result types are `ndt7_download` and `ndt7_upload`, with method `ndt7_webview_reference`. Download Mbps uses the last client byte/time sample; upload Mbps uses the last server-received byte/time sample. Server `AppInfo.ElapsedTime` is converted from microseconds. Client upload queueing alone does not establish delivered throughput. Byte/time observations come from the pinned client and are not a carrier-data counter; the client download counter can include textual telemetry. The last reported sample can precede closure.

The separate `reference` object stores library/version, speed source, stop reason, threshold, last client/server byte counts and the elapsed seconds used for speed. It survives JSON, CSV and sync. `transferredBytes` is the last client sample and can underestimate actual traffic. `requestedBytes` reserves the threshold for each direction; in this reference mode that reservation does not guarantee an upper bound. `durationMs` is the last available client measurement interval (server interval fallback), not discovery or whole-run wall time.

A successful direction requires an opened socket, a clean close and positive finite byte/time measurements. Connection timeout, abnormal close, missing server upload telemetry, cancellation and malformed messages remain failures. The browser coordinator uses 10-second connection and 12-second connected-phase watchdogs, a 45-second overall watchdog, and an independent 50-second React Native watchdog. Browser-process loss is recorded as an interruption. The native UI destroys the WebView before awaiting final database writes.

## Persistence and isolation

A reference session and both planned attempts are committed before discovery or measurement traffic. The existing repository recovers unfinished attempts after process death and retains the results/queue. An unstarted upload can therefore appear as interrupted/cancelled when the run stops early. Reference sessions cannot be resumed through the scheduled measurement engine; a new run requires fresh consent.

The shared activity gate excludes simultaneous collection, reference testing and sync. Reference tests run only while visible and do not start an Android background service. M-Lab destination URLs are restricted to secure service hosts; discovery access tokens and complete discovery URLs are not stored in exported records. Only the selected hostname is retained. No remote JavaScript/CDN code is loaded. The bundled upstream license is retained in `src/reference/ndt7Assets.json`.

## Reproducibility and validation

`npm ci` regenerates locally bundled client/worker sources from pinned npm packages. After editing the browser coordinator, run `npm run reference:bundle`. The generated asset is committed for review and offline builds.

```bash
npm run reference:bundle
npm run typecheck
npm run lint
npm test -- --runInBand --watchman=false
npm run reference:test-browser
cd android
./gradlew :app:assembleRelease --console=plain
```

The optional browser smoke test uses headless Chrome with real bundled workers and fake local sockets, with network connections blocked. It requires Chrome; set `CHROME_BINARY` for another installation path. It does not contact M-Lab or publish data.

Validation on 28 September 2026 passed: 107 app tests, TypeScript, lint, Android release compilation, and the offline Chromium smoke test using the actual bundled workers. The API 36.1 emulator installed the release while preserving saved data and displayed the reference panel with consent off and Start disabled. No public M-Lab test was started.

Unit/integration checks cover consent before discovery, foreground cancellation (including during database initialization), malformed telemetry, abnormal close, watchdogs, threshold termination, activity exclusion, upload receiver accounting, export/sync and interrupted-attempt recovery. A successful public M-Lab run on a physical Android phone and iOS validation remain separate acceptance checks; neither should be inferred from mocks or compilation.

## Other candidates

- **Traceroute:** remains unintegrated. `react-native-mtr`'s inspected release lacks the native `tracepath` bundle it tries to load and uses an obsolete Android build configuration. The alternative Android `icmpenguin` library needs a new React Native bridge and is marked unmaintained. Implementing that alternative changes the current no-custom-native-measurement-code scope. A server-side traceroute would measure a different direction/path and is not a substitute for phone-originated hops.
- **SpeedChecker:** remains unintegrated. The [vendor's free mode](https://github.com/speedchecker/react_plugin) requires location permission and sharing data with SpeedChecker and its clients; paid configuration changes those requirements. The published 1.0.4 Android wrapper also initializes the SDK in its native module `initialize()` method, before `startTest()`. Its JavaScript license setter only assigns a field after initialization; it does not reinitialize the SDK. A JavaScript-only consent checkbox therefore does not establish consent-gated SDK initialization. Runtime adapter changes, Android build compatibility work and a selected vendor/license/privacy configuration are still needed. Adding NDT7 does not initialize SpeedChecker or request its permissions.
- **Cloudflare:** its loaded-latency methodology is already represented by our controlled HTTP tests. The browser engine is not installed. Integrating a second public speed-test engine is a separate reference-provider decision, not necessary to enable the measurements already implemented.

Primary references: [official NDT7 client](https://github.com/m-lab/ndt7-js), [protocol specification](https://github.com/m-lab/ndt-server/blob/main/spec/ndt7-protocol.md), [React Native WebView](https://github.com/react-native-webview/react-native-webview).
