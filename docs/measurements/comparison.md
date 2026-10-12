# Do we need custom native measurements?

**Libraries are sufficient for the basic performance dataset and some per-probe evidence. The tested custom engine is needed for the extra Linux telemetry our current library interfaces do not expose. Neither implementation currently measures congestion dynamics during an actual upload/download.** This conclusion is about the pinned implementations tested here, not every available networking library.

A native library already contains platform code. Our thin Kotlin adapters serialize calls/results from icmpenguin; our former C++ engine implements its own socket probes. The comparison is **maintaining our own measurement code versus reusing library implementations**, not JavaScript versus all native code.

## Requirements audit

The [semester plan](../semester-plan.md) originally centered on application performance, offline storage and synchronization. Later packet-level requirements add individual observations and Linux kernel details. Treat these as distinct research needs:

| Requirement | Current libraries/frameworks | Custom engine addition | Decision from current evidence |
| --- | --- | --- | --- |
| HTTP transaction latency and controlled throughput | Implemented and observed | Same shared HTTP path | Keep libraries/frameworks; interpret application timing and test path. |
| ICMP RTT, burst non-response and successive differences | Implemented; 20/20 smoke replies | 599/600 replies in longer baseline | Libraries supply these metrics; matched endurance/path testing still needed. |
| Actual ICMP echo header and payload | Returned by icmpenguin, decoded in TypeScript | Also retained natively | Libraries supply useful packet evidence; full IP capture is absent in both. |
| Observed ICMP reply source, kernel receive timestamp and request-identifier matching | Not exposed by current library path | Observed source, timestamp and stronger matching retained | Native addition justified if the research requires these fields. |
| Per-hop traceroute responder and response time | Implemented and observed | Implemented and observed | Library suffices for exploratory routes, subject to reply filtering and label limits. |
| Original traceroute ICMP type/code and Linux extended-error metadata | Missing/ambiguous in pinned library | Preserved from socket error queue | Native justified for defensible error classification. |
| TCP connection timing and endpoints | Implemented and observed | Narrower connect timer plus metadata | Libraries suffice for connection availability/latency, with clearly named timing scope. |
| Handset TCP kernel RTT, retransmissions and congestion window | Not exposed by current wrapper | Before/after snapshots collected | Native justified for socket kernel telemetry; snapshots alone do not explain congestion. |
| UDP echo RTT, loss and successive differences | Original smoke had no echoes; October 12 follow-up received 20/20 | Original native baseline had no received echoes | Library integration now validated on the controlled Wi-Fi path; matched native/long-run validation remains needed. |
| UDP payload and matching/reordering evidence | Payload callbacks; duplicate/reorder accounting in paced burst | Payloads/error queue; sequential probes do not estimate burst reordering | Different methods; do not equate their results. |
| Scheduling, persistence, context and sync | Shared framework/library implementation; saved outputs observed | Same shared infrastructure | Native packet code adds no separate evidence of scheduler/storage reliability. |
| Complete TCP/IP headers, all packets, ACK evolution and hardware timing | Not implemented | Not implemented | Would require a different collection design; no claim of full packet capture. |
| Congestion window during the measured transfer | Not implemented | Not implemented on HTTP load sockets | Future requirement: repeated telemetry on the socket carrying the load. |
| Satellite identity/handover, modem RF and validated flight mobility | Not established by these experiments | Not established | Wi-Fi/battery context cannot substitute; optional mobility/location requirements need separate collection/validation. |

## Libraries and why we use them

Versions below come from the installed dependency declarations or collection provenance. [Source-level library findings](../library-packet-comparison.md#source-level-findings) explain the ICMP size semantics and error-origin limitation.

| Component | Version | Role and useful output | Missing evidence / justification |
| --- | --- | --- | --- |
| `icmpenguin` through Kotlin adapters | 1.0.0-rc.3 | Android echo bytes, RTT, TTL; traceroute probe results | Reuses an existing socket implementation. Pinned experimental candidate; upstream unmaintained, error variants omit needed original ICMP fields. |
| `ping-react-native` | 2.1.1 | Non-Android fallback dependency | Not the Android ICMP implementation in these runs; iOS validation remains pending. |
| `react-native-tcp-socket` | 6.4.3 | Connection callbacks, endpoints, application byte counters | Useful portable socket interface; no exposed handset TCP_INFO or TCP segments. |
| `react-native-udp` | 4.1.7 | Datagram payloads, send callbacks, sender metadata | Useful echo transport; no exposed IP/UDP headers, ICMP error queue or kernel timestamps. |
| React Native `fetch` + shared TypeScript | RN 0.84.1 | HTTP transaction latency, upload and concurrent latency tests | Appropriate application-level metrics; no underlying socket packet telemetry. |
| `@dr.pogodin/react-native-fs` | 2.40.3 | Streaming large HTTP downloads to file | Avoids loading large downloads into JS memory; reports application transfer data, not TCP behavior. |
| `react-native-background-actions` | 4.1.0 | Android foreground execution mechanism | Notification alone is insufficient evidence; inspect timestamps, saved counts and schedule-gap events. |
| `@react-native-community/netinfo` | 12.0.1 | Interface type/reachability and permitted Wi-Fi details | Context library, not satellite or packet telemetry. |
| `react-native-device-info` | 15.0.2 | Battery and charging context | Device context, not network performance. |
| `@op-engineering/op-sqlite` | 18.2.3 | Durable local measurement records | Preserves evidence; does not create measurements. |
| Optional `@m-lab/ndt7` through WebView | 0.1.5; WebView 14.0.1 | Client/server summaries and bounded worker callbacks | Not exercised in these sessions. Server TCP telemetry is not handset TCP_INFO. |
| Optional SpeedChecker Android SDK | 4.2.299, build-gated | SDK listener summaries and bounded callbacks | Not exercised in these sessions; requires its separate enabled build and consent flow. |

## What the saved evidence establishes

| Evidence | Custom one-hour run | Library smoke run |
| --- | ---: | ---: |
| Duration | 3,600.180 s | 120.184 s |
| Measurement rows | 244 | 12 |
| Sample rows, including HTTP baseline/loaded samples | 1,342 | 99 |
| Successful attempts | 232 | 11 |
| ICMP replies / probes | 599 / 600 | 20 / 20 |
| Successful TCP attempts | 60 / 60 | 2 / 2 |
| Traceroutes reaching destination | 4 / 4 | 1 / 1 |
| UDP replies / probes | 0 / 240 | 0 / 20 |
| Standalone + loaded HTTP transfers | 48 | 4 |
| Size per transfer | 50 MiB | 50 MiB |

The [custom audit](audits/custom-one-hour.md) and [library audit](audits/library-smoke.md) are generated from the saved JSON. Their aggregate [machine-readable evidence](audits/evidence.json) contains counts and findings without session/network identifiers. The source exports and full derived CSVs remain in ignored local storage.

The checks found no consistency errors under their documented scope. Native legacy sample projections omit payload size for 600 ICMP and 240 UDP samples; the focused views recover it from the saved packet object. The library smoke data contain 20 historical target/source aliases and 27 ambiguous traceroute error labels. These are interpretation warnings, not discarded measurements. Native packet receive timing is unavailable for timeouts and TCP's separate connect operation; the analyzer does not mix clocks to fill it in.

Both runs used the same local HTTP service over USB, while packet probes had their own targets. Duration, budget, scheduling behavior and probe methods differ. The native run had 82 schedule-gap events even though nominal measurement counts completed; an active foreground service is not proof of precise cadence. UDP had no matching echoes in either run, and the controlled route needs diagnosis. These experiments establish integration and retained field availability, not satellite performance or comparative long-run reliability.

## Recommendation

Keep the shared React Native orchestration, storage, context and HTTP collection. Use library ICMP and traceroute when the question only needs echo behavior and exploratory paths. Clearly expose their timing and source/error-field limitations.

Retain the custom baseline for research needing original Linux error metadata, kernel receive timing, or handset TCP_INFO. Before promoting it to the main implementation, require those fields to answer a specific research question and validate the extra maintenance cost on target Android devices. A small extension exposing exactly those fields may suffice; no conclusion here requires replacing every library.

For congestion research, first define a **same-socket transfer telemetry** experiment: a loaded flow, repeated TCP_INFO snapshots and progress timestamps. Neither branch currently fulfills that requirement. Full packet capture and flight/RF observations are separate gaps. After the UDP endpoint works, compare both branches under matched duration, targets, access path, transfer sizes and scheduling, preserving failures and collection limits. No new phone experiment was started as part of this offline audit.

## Subsequent UDP verification — 12 October

The [library-only follow-up](../experiments/2026-10-12-library-udp-phone.md) completed 12/12 attempts, including 20/20 matched UDP replies (median 18.103 ms, p95 178.300 ms). All 60 UDP send/request/reply callbacks were retained without drops. The separate echo service was started and allowed the phone’s current source address; Wi-Fi routing was working and no app code changed. This updates UDP capability evidence without changing the original two-run audit above. It is still a short integration test, with callback timing and a local Wi-Fi path.
