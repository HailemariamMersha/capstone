# Android traceroute and SpeedChecker adapters

A native adapter is a small platform bridge: TypeScript calls an Android library and receives structured results. The UI, scheduling, interpretation, SQLite, export and sync remain shared React Native code. These two Android bridges are the explicitly requested exception to the original library-only plan. Future iOS support requires equivalent adapters; the rest of the application remains reusable.

## Traceroute

The base Android build includes `me.impa:icmpenguin:1.0.0-rc.3`. Its prebuilt native library implements UDP probing and ICMP error handling; this project does not implement raw sockets. The Kotlin compiler is pinned to 2.3.0, including the Gradle plugin dependency, for the library's Kotlin metadata. The newer rc.4 requires Android API 37; rc.3 fits this project's API 36 build. Upstream is marked unmaintained, so this dependency needs continued compatibility review. [Upstream source](https://github.com/impalex/icmpenguin).

Enter a hostname or IP in **Traceroute target** before starting a scheduled session. Blank disables it. A trace runs in the serial scheduler at session start and every 15 minutes: 20 hops, three 32-byte UDP probes per hop, sequential destination ports starting at 33434, and a one-second probe timeout. The native coroutine has a 45-second deadline. Blocking OS DNS resolution or native teardown can delay cancellation beyond that deadline; the scheduler waits for cleanup before advancing.

The session reserves 3,840 payload bytes per default trace (20 × 3 × 32 × 2). This is a planning allowance, not measured wire usage: ICMP headers, encapsulation and other protocol overhead differ from an echo response. Actual transferred bytes remain null. The configuration API permits 1–30 hops; the UI uses 20.

Each result retains hop, sequence, destination address, responding address, result kind, available RTT, ICMP type/code, and library-reported payload/overhead. A destination reply or destination port-unreachable confirms arrival. Intermediate errors, silence, cancellation and hop-limit exhaustion retain partial observations and do not fabricate a successful route. The library's generic ICMP-error variant does not expose elapsed time, so those hop RTTs remain null. `route.complete` means native iteration ended normally; `route.reached` separately indicates arrival.

Saved history displays hop samples; JSON/CSV exports and sync preserve the full `route` object. `127.0.0.1` checks the phone itself. USB forwarding does not forward traceroute. Real-path validation needs a reachable remote target, and routers may filter or rate-limit replies. A missing hop does not prove a broken link.

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

A separate reference session and three attempts are committed before SDK traffic: `speedchecker_latency`, `speedchecker_download` and `speedchecker_upload`. Results store SDK ping in ms, download/upload in Mbps, available server hostname, raw SDK transfer counters and jitter, SDK version and termination/cleanup status. Missing or invalid metrics remain failures. SDK jitter is retained as SDK-reported metadata, not equated to the controlled UDP successive-RTT statistic. All three `durationMs` values describe the whole reference run, not individual phases.

The API labels transfer counters megabytes. Raw `downloadMb` / `uploadMb` are retained, and `transferredBytes` converts them using decimal MB (1,000,000 bytes). These are SDK observations, not independent packet counters. The 50 MB reservation on each throughput row represents the combined 100 MB planning threshold; it is not a per-direction limit. Partial speeds are retained only as metadata on failed runs. History, export and sync use the same repository as other measurements. Reference sessions cannot be resumed as scheduled sessions.

## Validation and remaining acceptance

TypeScript, lint and 121 app tests pass, including real SQLite persistence/export/sync of both new result types, cancellation, consent-before-traffic and activity exclusion. The default build compiles without vendor credentials. The SDK-enabled Android release build and all three instrumentation tests passed on the API 36.1 ARM64 emulator: real UDP loopback with a subsequent run after cleanup, cancellation and invalid parameters, and rejection of SpeedChecker without consent. The installed app also displayed the traceroute setting and SpeedChecker panel with consent off and Start disabled. No public speed test was started.

To build and run the native checks on an attached emulator or phone, with vendor repository configuration supplied:

```bash
cd android
./gradlew :app:assembleRelease :app:assembleReleaseAndroidTest -PenableSpeedChecker=true
adb install -r app/build/outputs/apk/release/app-release.apk
adb install -r app/build/outputs/apk/androidTest/release/app-release-androidTest.apk
adb shell am instrument -w com.labpracticeapp.test/androidx.test.runner.AndroidJUnitRunner
```

Physical-phone multi-hop traceroute, a consented public SpeedChecker run, interruption during an actual SDK transfer, data-use observations, and iOS adapters remain acceptance work. Compilation and loopback tests do not establish satellite-path accuracy or public-service success.
