# Ten-minute library-only phone experiment — 12 October 2026

The Samsung Galaxy A34 (Android 13) completed the requested ten-minute experiment using the existing libraries. **41/41 parent measurement attempts succeeded**, with **98/100 ICMP replies, 40/40 UDP echoes, 10/10 TCP connections**, and a traceroute reaching Google at hop 10. Successful parent attempts do not imply every individual probe replied.

## Configuration and build

- UTC interval: **2026-10-12 11:55:13.751–12:05:13.939**, or **15:55:13.751–16:05:13.939 Asia/Dubai**; duration **600.188 seconds**.
- Automatic stop reason: `duration`; zero unfinished probes. Configured allowance: **512 MiB**; reserved application allowance: **419,457,688 bytes**, excluding protocol overhead.
- HTTP RTT, ICMP bursts and TCP connections every 60 seconds. Standalone transfers, UDP bursts and loaded-latency tests every 300 seconds. Traceroute at startup, then every 900 seconds, so this run contains one route.
- **50 MiB per upload/download**. Eight transfers completed, including loaded tests: **400 MiB total application transfer payload**.
- ICMP/TCP/traceroute targets: Google. UDP: controlled echo service on the Mac's Wi-Fi address, port 9876. HTTP/sync: Mac loopback server through USB TCP forwarding.
- Installed APK SHA-256: `e20219bc47e7dce01f4dd48874eab3bdb739442bc53138a005eec39960e32b6b`, verified against the local release.
- The APK contains `libicmpenguin.so` and no `libcapstonepacket.so`. Thin Kotlin bridges expose icmpenguin; no application-owned socket engine was used.
- Export implementation commit: `8d1754e`. Export format **4** removes 14 custom-only columns from both wide CSVs: **70 measurement columns**, **64 sample columns**. The focused TCP CSV also omits kernel telemetry.

The app was backgrounded after startup and briefly reopened for status checks. Its foreground service remained active and stopped after completion. This is a ten-minute background integration test, not a locked-screen/Doze endurance test.

## Results

| Measurement / provider | Observed result |
| --- | --- |
| HTTP transaction latency — React Native fetch | 10/10 successful transactions; 14.618–31.387 ms. |
| ICMP — icmpenguin 1.0.0-rc.3 | Ten successful bursts; **98/100 replies**, two timeouts, pooled successful-reply median **17.121 ms**. Received echo bytes/header fields remain available in samples. |
| TCP — react-native-tcp-socket 6.4.3 | **10/10 connections**; median **21.671 ms**, including applicable resolution and callback overhead. |
| UDP — react-native-udp 4.1.7 | Two bursts, **40/40 exact matching 128-byte echoes**, 0% non-response in each burst. Pooled median **21.035 ms**. |
| Traceroute — icmpenguin 1.0.0-rc.3 | Destination reached at **hop 10**. Thirty probes: 26 library `host_unreachable`, one destination `port_unreachable`, three timeouts. |
| Download — RNFS 2.40.3 | Two standalone 50 MiB downloads: **268.109** and **252.808 Mbps**. |
| Upload — fetch + TypeScript | Two standalone 50 MiB uploads: **92.306** and **89.280 Mbps**. |
| Loaded download latency | Two successful 50 MiB transfers; five overlapping latency samples each. Median latency **59.052** and **59.111 ms**. |
| Loaded upload latency | Two successful 50 MiB transfers; fifteen overlapping latency samples each. Median latency **17.531** and **17.594 ms**. |
| NetInfo / device-info | Nine Wi-Fi context snapshots; battery 100%, charging reported false. |
| OP-SQLite / sync | 41 measurements, 19 events, nine snapshots and one session: **70 acknowledged records**, zero pending on the phone. |

Each UDP burst retained 20 send requests, 20 send confirmations and 20 matched replies, with no dropped callbacks. Every received payload exactly matched its recorded request for that sequence. Burst medians were 20.844 and 36.406 ms; p95 values were 38.353 and 195.977 ms. The second burst's greater variability is retained; callback timing includes app/bridge scheduling overhead.

Fourteen schedule-gap events recorded lateness up to **68.347 seconds**, with zero skipped intervals. All scheduled attempts completed, but this is not evidence of precise execution at every nominal scheduled time. Long transfer preparation/execution and serial scheduling can delay other probes.

## Export and consistency checks

- Eight export files and six focused CSVs plus reports were generated from the synchronized records using the same serializer as the phone.
- **232 sample rows**, **100 packet-observation JSONL records**, and **344 library request/callback JSONL records**. A packet-observation record may represent a timeout rather than a received packet.
- Every generated CSV header was checked: no removed custom-only columns remain. Received ICMP evidence and original raw records are retained.
- Analyzer: **zero errors**, **27 warnings**, **zero unavailable checks**. All warnings identify ambiguous traceroute library labels; they do not contradict destination arrival. Missing kernel telemetry is outside the current library-only CSV scope and is not reported as a library test failure.
- Export/analysis/share tests: **22 passed**. TypeScript, ESLint and the release build passed. The bundled serializer was checked for format 4 and the installed APK checksum matched.

Private original ingestion records, source JSON and detailed exports remain local under ignored storage:

```text
backend/data/experiments/2026-10-12-library-ten-minute/
  observer-metadata.json
  ingested-records.json
  source-session.json
  export/
  analysis/
```

The complete analysis envelope was reconstructed from acknowledged backend records. Measurement `state=complete` is added for the closed session, matching the phone export contract; the exact received payloads are preserved separately. No private raw dataset is committed.

## Interpretation

The existing library approach collected the intended basic performance measurements and available individual-probe evidence throughout this ten-minute run. The two ICMP timeouts and three traceroute timeouts are retained as observations, not hidden by successful parent summaries.

HTTP results describe the **local USB/server path**, not Internet or satellite throughput. UDP describes a controlled campus Wi-Fi route. Traceroute's original ICMP error type/code remain unavailable through the pinned library, so its class labels must not be treated as verified protocol error codes. Kernel statistics, complete TCP/IP packet capture and congestion-window evolution were not collected and are outside this experiment's scope. Optional NDT7 and SpeedChecker tests were not run.
