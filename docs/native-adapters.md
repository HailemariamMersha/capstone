# Android traceroute and SpeedChecker adapters

A native adapter is a small platform bridge: TypeScript calls an Android library and receives structured results. The UI, scheduling, interpretation, SQLite, export and sync remain shared React Native code. These two Android bridges are the explicitly requested exception to the original library-only plan. Future iOS support requires equivalent adapters; the rest of the application remains reusable.

## Packet probes and traceroute

The base Android build now includes our small C++ Linux-socket engine, called through `PacketProbeModule`. It replaces both the old Android shell-ping path and `icmpenguin`; **icmpenguin is no longer installed**. TypeScript still owns schedules, interpretation, persistence and export. The JNI implementation is auditable in this repository and captures our own active probe socket results. See [packet methods, limits and tests](packet-engine.md).

Traceroute sends three 32-byte UDP datagrams per hop, beginning at destination port 33434, with TTL/hop-limit 1–20, a one-second probe timeout and a 45-second trace deadline. Ports advance with sequence; this is not Paris traceroute. The resolved numeric destination stays fixed for the trace. Cancellation preserves completed/partial observations and waits for socket cleanup. DNS resolution is bounded at the bridge, though a platform resolver can linger on its single isolated thread.

Results preserve the kernel's extended error fields before interpreting ICMP type/code. An actual destination Port Unreachable or exact echoed payload confirms arrival; silence or intermediate errors do not. Default payload reservation remains 3,840 bytes (20 × 3 × 32 × 2), a planning allowance excluding protocol overhead. The configuration permits 1–30 hops. USB forwarding cannot forward UDP traceroute.

Seven new packet-engine tests pass on the Android API 36.1 emulator. The September 28 physical-phone results below used the **previous** engine and do not validate this replacement.

## SpeedChecker

The optional bridge directly integrates Android SDK **4.2.299**. The old React Native npm wrapper is not installed: it initialized the SDK before the app could collect consent. The new bridge makes no SDK calls when registered. It requires explicit consent, foreground state, precise location permission and system Location enabled before initialization. [Official SDK setup](https://github.com/speedchecker/speedchecker-sdk-android), [SDK API](https://github.com/speedchecker/speedchecker-sdk-android/wiki/API-documentation).

This integration uses the vendor's free mode, with location and device/network information shared with SpeedChecker and its clients. The separate **SpeedChecker reference test** panel explains this and links the [vendor privacy policy](https://www.speedchecker.com/privacy-policy.html). Consent is off initially and resets after starting. Permission denial is saved as failed attempts. No public test starts automatically.

The SDK is excluded from the default build. To include it, obtain repository access from the vendor's documented setup and supply either these environment variables or the equivalent `speedCheckerMavenUsername` / `speedCheckerMavenPassword` properties in your user-level Gradle configuration. Do not commit credentials.

```bash
# Set SPEEDCHECKER_MAVEN_USERNAME and SPEEDCHECKER_MAVEN_PASSWORD privately first.
cd android
./gradlew :app:assembleRelease -PenableSpeedChecker=true
adb install -r app/build/outputs/apk/release/app-release.apk
```

Vendor repository downloads are restricted to the SDK and its `com.github.heremaps` dependency group. SDK passive service, boot/update/alarm/geofence receivers and associated boot/Wi-Fi-changing permissions are removed by a manifest overlay. Passive/background measurement flags are disabled before SDK initialization. The existing release network security configuration remains in force; this integration does not enable arbitrary cleartext HTTP. A vendor server requiring blocked cleartext can fail and needs separate investigation.

Stop scheduled collection and sync, read the disclosure, consent, and tap **Start SpeedChecker reference test**. Keep the app visible. Cancel or background the app to request interruption. A 90-second native deadline and a combined **100 MB** SDK-reported transfer threshold also request interruption. These are best-effort controls, not a hard carrier-data cap. Reporting delays and in-flight traffic can overshoot. If a terminal SDK callback does not confirm cleanup within five seconds of interruption, the activity gate remains closed until app restart. An independent JavaScript watchdog handles missing native responses.

Listener callback arguments and selected final public result fields are retained with timestamps, bounded to 256 callbacks / 262,144 serialized characters and an explicit dropped count. Vendor-internal packets are unavailable.

A separate reference session and three attempts are committed before SDK traffic: `speedchecker_latency`, `speedchecker_download` and `speedchecker_upload`. Results store SDK ping in ms, download/upload in Mbps, available server hostname, raw SDK transfer counters and jitter, SDK version and termination/cleanup status. Missing or invalid metrics remain failures. SDK jitter is retained as SDK-reported metadata, not equated to the controlled UDP successive-RTT statistic. All three `durationMs` values describe the whole reference run, not individual phases.

The API labels transfer counters megabytes. Raw `downloadMb` / `uploadMb` are retained, and `transferredBytes` converts them using decimal MB (1,000,000 bytes). These are SDK observations, not independent packet counters. The 50 MB reservation on each throughput row represents the combined 100 MB planning threshold; it is not a per-direction limit. Partial speeds are retained only as metadata on failed runs. History, export and sync use the same repository as other measurements. Reference sessions cannot be resumed as scheduled sessions.

## Historical adapter validation and remaining acceptance

TypeScript, lint and 121 app tests pass, including real SQLite persistence/export/sync of both new result types, cancellation, consent-before-traffic and activity exclusion. The default build compiles without vendor credentials. The SDK-enabled Android release build and all three instrumentation tests passed on the API 36.1 ARM64 emulator: real UDP loopback with a subsequent run after cleanup, cancellation and invalid parameters, and rejection of SpeedChecker without consent. The installed app also displayed the traceroute setting and SpeedChecker panel with consent off and Start disabled. No public speed test was started.

To build and run the native checks on an attached emulator or phone, with vendor repository configuration supplied:

```bash
cd android
./gradlew :app:assembleRelease :app:assembleReleaseAndroidTest -PenableSpeedChecker=true
adb install -r app/build/outputs/apk/release/app-release.apk
adb install -r app/build/outputs/apk/androidTest/release/app-release-androidTest.apk
adb shell am instrument -w com.labpracticeapp.test/androidx.test.runner.AndroidJUnitRunner
```

Repeated physical-network traceroutes, a consented public SpeedChecker run, interruption during an actual SDK transfer, data-use observations, and iOS adapters remain acceptance work. Compilation and loopback tests do not establish satellite-path accuracy or public-service success.


### Physical Android follow-up — 28 September 2026

The SDK-enabled release was installed on a Samsung Galaxy A34 (SM-A346E, Android 13), preserving saved app data. All three native instrumentation checks passed on the phone: UDP loopback and subsequent-run cleanup, cancellation/invalid limits, and SpeedChecker rejection without consent.

A one-minute scheduled session ran from 13:02:16 to 13:03:16 UTC. UDP traceroute to `1.1.1.1` reached the destination at hop 12 in approximately 4.51 seconds and retained 36 observations: 31 library-classified `host_unreachable` replies, four timeouts and one destination `port_unreachable`. The destination reply RTT was 110.861 ms. These per-probe paths can vary; this is not proof that every probe followed a single fixed 12-hop route.

The library's `HostUnreachable` variant does not retain the original ICMP type/code. Its name must not be interpreted as proof that each responding router is unreachable or that the path failed: this successful run contains those intermediate replies. We preserve its classification and available RTT without inventing an ICMP type.

The same session passed HTTP RTT, 1 MiB download and 256 KiB upload through USB forwarding to the Mac. Those HTTP values establish app integration, not internet throughput. The session stopped at its one-minute duration limit. All 12 session/measurement/event/snapshot records were acknowledged by the local backend; the phone showed zero pending records. The existing backend records remained intact, increasing from 3,502 to 3,514.
