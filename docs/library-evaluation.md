# Library evaluation — 2026-09-26

The attached proposal is an evaluation shortlist. HTTP probes remain the controlled research baseline. The following assessment uses the actual published npm packages and their native source, not download counts or an assumption that advertised platform support guarantees compatibility.

| Candidate | Decision | Evidence and scope |
| --- | --- | --- |
| `ping-react-native` 2.1.1 | Integrated as optional ICMP | TurboModule support; Android implementation invokes `/system/bin/ping` with an argument array. One 64-byte payload sample per RTT interval; native RTT and TTL stored separately from adapter duration. Explicit host required. |
| `@react-native-community/netinfo` 12.0.1 | Integrated | Network-change subscription and connection snapshots. Third-party HTTP reachability polling disabled; missing metadata remains null. |
| `react-native-device-info` 15.0.2 | Integrated | Battery level and charging state only; no hardware identifier collection. |
| `@dr.pogodin/react-native-fs` 2.40.3 + `react-native-share` 12.3.1 | Integrated | UTF-8 CSV/JSON generated from the repository and shared as files. Cache filenames are bounded. |
| `react-native-mtr` 1.1.1 | Rejected for this release after source inspection | Published Gradle build uses `jcenter()`, AGP 3.2.1, and no namespace. Traceroute loads `tracepath`; no corresponding native library was found in the package inspected. This does not meet the current RN/Android integration gate. No traceroute capability is advertised in the app. |
| `@speedchecker/react-native-plugin` 1.0.4 | Deferred after source inspection | Published Gradle uses `jcenter()`, no namespace, fixed SDK settings and an additional vendor Maven repository. The wrapper also needs license initialization review. No project license/configuration or validated integration is available. It is not linked or executed by this release. |

Primary sources: [ICMP](https://github.com/RakaDoank/ping-react-native), [NetInfo](https://github.com/react-native-netinfo/react-native-netinfo), [Device Info](https://github.com/react-native-device-info/react-native-device-info), [MTR](https://github.com/bashen1/react-native-mtr), [SpeedChecker](https://github.com/speedchecker/react_plugin).

## Measurement constraints

- ICMP and HTTP should target the same remote host for a meaningful comparison. HTTP may resolve to a different address behind DNS load balancing; the current records do not establish identical routes or isolate TLS/server overhead by subtraction.
- ICMP does not pass through `adb reverse`. A target of `127.0.0.1` tests the phone itself. An emulator loopback check validates the adapter only.
- ICMP failure can mean filtering or rate limiting. It is not proof of total internet failure, and a small sample is not a packet-loss estimate.
- Throughput stays single-request HTTP with explicit payload size; 1/5/10 MiB download and 256 KiB/1 MiB upload are selectable. Existing defaults are preserved so prior runs remain comparable. Payload units are binary MiB, not decimal MB.
- Context calls occur outside the timed probe, before measurement, and can warm the HTTP connection. Context lookups have a three-second deadline; unavailable IP/ASN data does not stop collection.
- A commercial reference test must be separately labeled and run outside collection, with SDK/server/version/units and byte usage recorded. Enabling it requires resolving the concrete build and initialization blockers above. No experimental SDK results have been fabricated or merged into HTTP results.

## WebFM ideas implemented

Session export; battery/network context; payload, duration and battery safeguards; persistent records with versioned server acknowledgements and backoff. No FM hardware, SMS, GPS polling or device-specific native measurement code was copied.

The sync server in this increment uses durable SQLite for local end-to-end validation. PostgreSQL/TimescaleDB deployment and background uploads while the UI is closed remain future work; this is not a declaration that all M6 acceptance criteria are complete.
