# Packet observations and library justification

Reviewed 29 September 2026. This is the working methods brief for next week's review. Implementation evidence comes from the pinned dependencies and our saved phone results; related projects are methodological references, not proof that our app is correct.

## What we have already demonstrated

The Android app has scheduled ICMP bursts, UDP traceroute, controlled UDP echo, TCP connection timing, HTTP RTT/throughput/loaded latency, device/network context, SQLite persistence, exports and acknowledged sync. M-Lab NDT7 and SpeedChecker are separate reference flows. React Native/TypeScript owns orchestration, storage and analysis; platform libraries and two small Android bridges supply native operations. iOS has not been validated.

The 28 September session collected 76 measurements over 17 minutes 42 seconds before an explicit stop: 180/180 ICMP replies, two traces reaching the destination at hop 12, 16 successful 50 MiB transfers, and four UDP bursts without replies. It was not an hour-long endurance success, and the HTTP transfers used USB forwarding, not a satellite link. See [the verified experiment](../experiments/2026-09-28-hour-all-diagnostics.md).

## How traceroute worked in our run

No routers or hop servers were simulated. The phone sent UDP probes toward `1.1.1.1` over its internet connection. `TracerouteModule.kt` selects `TraceStrategy.Stepped`, three probes per hop, a 20-hop ceiling, sequential ports starting at 33434, 32-byte probes, a one-second per-probe timeout and a 45-second overall deadline.

Traceroute varies the outgoing IP TTL. A router that exhausts it may send ICMP Time Exceeded; reaching a closed UDP port can produce ICMP Port Unreachable. Our app counts a port-unreachable result as destination arrival only when its responding address matches the resolved destination. These mechanisms are documented by the [Linux traceroute manual](https://man7.org/linux/man-pages/man8/traceroute.8.html). The separate Mac UDP echo server is unrelated to traceroute and is not a hop on the traced path.

A hop RTT includes the outward path and return of that hop's response. It is not the latency of the link between adjacent routers. Silent routers remain timeout observations. Varying ports can select different load-balanced paths, so our results are observations at each TTL, not a guaranteed single physical route. [Paris traceroute](https://github.com/libparistraceroute/libparistraceroute) is a useful reference for preserving flow identity; we have not implemented Paris semantics.

## Linux tools versus an ordinary Android app

| Tool / mechanism | What it can expose | Our Android position |
| --- | --- | --- |
| Linux `ping` / ICMP echo | Reply address, ICMP sequence, reply TTL, payload size, RTT and command diagnostics | The pinned Android ping wrapper actually starts `/system/bin/ping`, then parses text. Our patch preserves stdout/stderr in addition to the callback fields. Binary headers and kernel timestamps are not supplied. |
| UDP traceroute with TTL and the socket error queue | Responses from routers, extended errors and the original datagram context | `icmpenguin` supplies typed results via native code. We retain all exposed variant fields. Some variants discard original ICMP type/code before our bridge sees them. |
| TCP connect / `ss -ti` / `TCP_INFO` | Connection success; Linux TCP instrumentation can also expose RTT estimates, retransmissions and congestion state | Our TCP socket library supplies connection callbacks, not SYN packet timing or `TCP_INFO`. Do not equate connection duration to a packet RTT. |
| UDP socket echo | Application payload, sender address/port, correlated replies, duplicates and elapsed time | Available for our own controlled traffic. The socket API does not expose full IP/UDP headers or incoming ICMP error messages. |
| `tcpdump` / libpcap | Captured packet bytes and headers at a capture point | Not implemented on the phone. A privileged Linux capture at a controlled server is a validation instrument, not equivalent to observing all packets at the handset. |
| Android `VpnService` | IP packets routed through an app-created virtual interface | A possible separate capture architecture, requiring a VPN setup and traffic forwarding. It changes the measurement path and is not a transparent replacement for these libraries. |

Sources: [iputils](https://github.com/iputils/iputils), [ping manual](https://man7.org/linux/man-pages/man8/ping.8.html), [Linux error-queue documentation](https://man7.org/linux/man-pages/man2/recvmsg.2.html), [raw-socket privilege requirements](https://man7.org/linux/man-pages/man7/raw.7.html), [Android VPN guide](https://developer.android.com/develop/connectivity/vpn). Raw sockets normally require `CAP_NET_RAW`; successful datagram-based diagnostics do not imply unrestricted packet capture access.

A useful next native change is to preserve `sock_extended_err` fields (`ee_origin`, `ee_type`, `ee_code`, `ee_errno`, `ee_info`, `ee_data`), offender address and quoted datagram before the library maps them into specialized errors. This requires inspecting/changing the native engine, not adding CSV columns. It remains unimplemented. Unknown fields must remain null; do not reconstruct an ICMP code from `HostUnreachable` or assume an ICMP message exists for every packet.

## Why each dependency exists

These are our engineering judgments, grounded in the pinned APIs and observed results. They are not claims that every dependency was validated by a research paper.

| Dependency | Defensible role | Limitation / validation needed |
| --- | --- | --- |
| `ping-react-native` 2.1.1 | Actual ICMP echo measurement on the physical Android phone; existing cross-platform API | Android wraps a command and uses regex parsing. The patch retains native text so parser mistakes can be audited. Need controlled success, silence, unreachable-host and locale/output tests. |
| `icmpenguin` 1.0.0-rc.3 | UDP traceroute with native sockets, per-probe outcomes and cancellation | Android-only bridge; two successful traces are limited evidence. Upstream explicitly says it is unmaintained. Retain a pinned experimental dependency while evaluating a maintained fork or replacement; do not claim production support. |
| `react-native-udp` 4.1.7 + `buffer` 6.0.3 | Controlled, correlated datagrams with exact application payload bytes | Zero-reply campus run did not validate successful UDP echo. Need a reachable controlled endpoint. No packet headers or one-way timing. |
| `react-native-tcp-socket` 6.4.3 | Connection success/time independently of HTTP | Includes resolver and callback overhead; cannot diagnose TCP retransmission or congestion windows. |
| React Native `fetch` | Application transaction RTT and bounded uploads/small downloads | HTTP is still useful for user experience, but is explicitly an application-layer metric. It is not ICMP RTT or a packet capture. |
| `@dr.pogodin/react-native-fs` 2.40.3 | Streaming large downloads without full-body heap copies; writing export files | Download timing includes file writes; filesystem use does not provide TCP packet telemetry. |
| `@m-lab/ndt7` 0.1.5 + `react-native-webview` 14.0.1 | Official browser reference test in a supported browser context | Separate consented adaptive test; not fixed-size probes. Existing persisted data is selected reference metrics, not a complete history of every SDK callback. |
| SpeedChecker Android SDK 4.2.299 | Separate vendor reference for comparison | Vendor SDK output and service are less transparent than our controlled probes. Consent and foreground execution remain required; no claim of raw packet visibility. |
| `react-native-background-actions` 4.1.0 | Foreground execution of scheduled work | Notification alone proves nothing about samples. Full locked-screen endurance and start-time accuracy remain unproven. |
| `@op-engineering/op-sqlite` 18.2.3 | Durable attempts, raw observations, context and queued sync | Store failures and raw data as well as summary values; verify export and sync completeness. |
| NetInfo 12.0.1 / DeviceInfo 15.0.2 | Context needed to interpret measurements | Available network/battery fields are not modem RF telemetry or verified satellite identity. |
| `react-native-share` 12.3.1 | Transfer the export files through the OS share sheet | Delivery mechanism only; recipient apps may handle multiple files differently. |
| React 19.2.3 / React Native 0.84.1 / TypeScript | Shared application UI, orchestration and typed measurement models | Native capabilities differ across Android and iOS. `react-native-safe-area-context` handles UI insets, not measurements. |
| FastAPI / Uvicorn / Pydantic | Controlled transfer endpoints and validated ingestion | Server placement, CPU, transport path and limits affect results. Server timing cannot substitute for handset packet timestamps. |

The maintenance finding is visible in [icmpenguin's own README](https://github.com/impalex/icmpenguin). The ping wrapper's [source repository](https://github.com/RakaDoank/ping-react-native) and installed Android source explain its command-based implementation. Existing [library evaluation](../library-evaluation.md) and [native adapter notes](../native-adapters.md) provide the earlier choices; this review adds packet-observability and maintenance constraints.

## Related papers and repositories

| Paper / project | Verified repository | What we can learn | Boundary |
| --- | --- | --- | --- |
| **Mobilyzer: An Open Platform for Controllable Mobile Network Measurements**, MobiSys 2015 ([paper](https://anikravesh.github.io/files/mobilyzer-mobisys15.pdf)) | [mobilyzer/Mobilyzer](https://github.com/mobilyzer/Mobilyzer), [MobiPerf](https://github.com/Mobiperf/MobiPerf) | Measurement isolation, scheduling/resource limits, multiple diagnostic types and structured results | Historical Android architecture, not a drop-in modern React Native dependency. |
| **WetLinks: a Large-Scale Longitudinal Starlink Dataset with Contiguous Weather Data**, TMA 2024 ([paper](https://arxiv.org/abs/2402.16448)) | [sys-uos/WetLinks](https://github.com/sys-uos/WetLinks) | Preserve raw ping/traceroute/throughput data separately from preprocessing; retain software metadata and feature descriptions | Its published dataset and analysis scripts do not prove phone-side collection compatibility. |
| **LENS: A LEO Satellite Network Measurement Dataset**, MMSys 2024 | [clarkzjw/LENS](https://github.com/clarkzjw/LENS) | Raw archives alongside processed CSV; ping/IRTT measurements and collection context | The repo identifies the paper snapshot as `c084c11`; newer pipeline contents differ. This is a dataset/testbed reference. |
| **LEO Satellite vs. Cellular Networks: Exploring the Potential for Synergistic Integration**, CoNEXT 2023 | [Starlink-Project/Satellite-vs-Cellular](https://github.com/Starlink-Project/Satellite-vs-Cellular) | Mobile comparison design, UDP ping, throughput, TCP-loss analysis and reproducible figures | The release provides datasets/tools/processed-data scripts; it is not evidence of a reusable RN collector. |
| **Paris traceroute tooling** (method reference) | [libparistraceroute/libparistraceroute](https://github.com/libparistraceroute/libparistraceroute) | Flow-aware probing and avoiding false route interpretations under load balancing | Linux/C reference, not an installed Android library. |

## Next-week deliverable and acceptance checks

Implemented in this change: expanded CSV bundle and full saved JSON, per-sample raw ping callbacks/text, complete exposed traceroute result variants, correlated UDP send/reply observations, and explicit provenance/unavailable fields. See [the export dictionary](../packet-exports.md).

Before presenting new phone data:

1. Install the rebuilt app and collect a short ICMP/traceroute session against a controlled target. Verify native stdout/stderr and traceroute raw fields survive phone storage, export and backend sync. Existing September 28 records cannot retroactively acquire these fields.
2. Collect successful replies, a controlled timeout and an unreachable response. Check outcomes against the command output and a Linux reference; do not turn unavailable fields into zero.
3. Obtain a successful controlled UDP echo and compare sent payloads, received payloads, source endpoint, duplicate/reordering counters and recorded timeouts.
4. Run Linux `ping -n -c 10 -s 64 TARGET` and `traceroute -n -q 3 -m 20 -w 1 TARGET` on the same access network. Retain stdout/stderr. These are reference experiments from a different device, so do not expect identical paths or RTTs.
5. For actual packet headers, capture only the controlled test traffic at a Linux endpoint/router under our control. Compare timestamps, ICMP type/code and matching identifiers at that capture point; record placement and clock limitations.
6. Complete an uninterrupted hour on the phone, first without large transfers and then with them. Compare schedule lateness, screen-locked behavior and sample counts. Our prior user-stopped run cannot satisfy this check.

The priority is reproducible observations and an honest field dictionary. Full arbitrary packet capture, complete ICMP headers for all traceroute variants, hardware timestamps, continuous SDK callback archives and iOS validation remain separate implementation work.
