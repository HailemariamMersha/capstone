# Library evaluation — 2026-09-26

The attached proposal is an evaluation shortlist. HTTP probes remain the controlled research baseline. The following assessment uses the actual published npm packages and their native source, not download counts or an assumption that advertised platform support guarantees compatibility.

| Candidate | Decision | Evidence and scope |
| --- | --- | --- |
| `ping-react-native` 2.1.1 | Integrated as optional ICMP | TurboModule support; Android implementation invokes `/system/bin/ping` with an argument array. One 64-byte payload sample per RTT interval; native RTT and TTL stored separately from adapter duration. Explicit host required. |
| `@react-native-community/netinfo` 12.0.1 | Integrated | Network-change subscription and connection snapshots. Third-party HTTP reachability polling disabled; missing metadata remains null. |
| `react-native-device-info` 15.0.2 | Integrated | Battery level and charging state only; no hardware identifier collection. |
| `@dr.pogodin/react-native-fs` 2.40.3 + `react-native-share` 12.3.1 | Integrated | UTF-8 CSV/JSON generated from the repository and shared as files. Cache filenames are bounded. |
| `react-native-mtr` 1.1.1 | Rejected for this release after source inspection | Published Gradle build uses `jcenter()`, AGP 3.2.1, and no namespace. Traceroute loads `tracepath`; no corresponding native library was found in the package inspected. This does not meet the current RN/Android integration gate. A different traceroute implementation was added in the follow-up below. |
| `@speedchecker/react-native-plugin` 1.0.4 | Deferred after source inspection | Published Gradle uses `jcenter()`, no namespace, fixed SDK settings and an additional vendor Maven repository. The wrapper also needs license initialization review. No project license/configuration or validated integration is available. It is not linked or executed by this release. |

Primary sources: [ICMP](https://github.com/RakaDoank/ping-react-native), [NetInfo](https://github.com/react-native-netinfo/react-native-netinfo), [Device Info](https://github.com/react-native-device-info/react-native-device-info), [MTR](https://github.com/bashen1/react-native-mtr), [SpeedChecker](https://github.com/speedchecker/react_plugin).

## Measurement constraints

- ICMP and HTTP should target the same remote host for a meaningful comparison. HTTP may resolve to a different address behind DNS load balancing; the current records do not establish identical routes or isolate TLS/server overhead by subtraction.
- ICMP does not pass through `adb reverse`. A target of `127.0.0.1` tests the phone itself. An emulator loopback check validates the adapter only.
- ICMP failure can mean filtering or rate limiting. It is not proof of total internet failure, and a small sample is not a packet-loss estimate.
- Throughput stays single-request HTTP with explicit payload size; both download and upload now accept user-entered MiB values, rounded to whole bytes, from 1 byte through 100 MiB. Existing defaults are preserved so prior runs remain comparable. Payload units are binary MiB, not decimal MB.
- Context calls occur outside the timed probe, before measurement, and can warm the HTTP connection. Context lookups have a three-second deadline; unavailable IP/ASN data does not stop collection.
- A commercial reference test must be separately labeled and run outside collection, with SDK/server/version/units and byte usage recorded. Enabling it requires resolving the concrete build and initialization blockers above. No experimental SDK results have been fabricated or merged into HTTP results.

## WebFM ideas implemented

Session export; battery/network context; payload, duration and battery safeguards; persistent records with versioned server acknowledgements and backoff. No FM hardware, SMS, GPS polling or device-specific native measurement code was copied.

The sync server in this increment uses durable SQLite for local end-to-end validation. PostgreSQL/TimescaleDB deployment and background uploads while the UI is closed remain future work; this is not a declaration that all M6 acceptance criteria are complete.

## Follow-up: focused diagnostic libraries

`react-native-tcp-socket` 6.4.3 and `react-native-udp` 4.1.7 are integrated with reproducible Android namespace patches. Release builds and an API 36.1 emulator session passed. The session captured ten ICMP loopback replies, a TCP connection to the local server, twenty matching UDP echoes, and one fully overlapping HTTP latency reply in each load direction. All eight measurements and their raw diagnostic details were saved and synced, with sixteen total records acknowledged. These local values establish integration only. Physical Android subsequently passed HTTP/TCP/loaded-latency integration checks; ICMP/UDP to the Mac received no replies and still need a reachable peer network. See the dated physical follow-up in the diagnostic guide. iOS remains untested.

[Diagnostic methodology, diagnostic methods, and phone-testing commands](diagnostics.md) supersede the earlier shortlist for these capabilities. No custom Kotlin/Java measurement implementation was added.

## Follow-up: NDT7 reference tests — 2026-09-28

`@m-lab/ndt7` 0.1.5 and `react-native-webview` 14.0.1 are integrated for separate, foreground-only reference runs. The official client and workers are bundled locally. Consent, cancellation, timeout/close validation, approximate byte thresholds, saved results, exports and sync are implemented. Physical public-service and iOS validation remain pending. [Reference-test guide](reference-tests.md) documents NDT7 methodology.

## Follow-up: Android adapters — 2026-09-28

The requested adapter exception now integrates `icmpenguin` 1.0.0-rc.3 for scheduled UDP traceroute and optionally `com.speedchecker:android-sdk:4.2.299` for consented reference tests. The rejected `react-native-mtr` and deferred SpeedChecker npm wrapper remain uninstalled. Kotlin 2.3.0 supports the traceroute dependency while retaining Android API 36. SDK initialization is behind native consent, permission and foreground checks; passive manifest entrypoints are removed. [Native-adapter guide](native-adapters.md) describes build credentials, methods, tests and remaining public-service/physical-phone acceptance.
