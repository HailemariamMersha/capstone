# Library implementation: physical-phone verification — 8 October 2026

The library comparison build passed a two-minute session on the same Samsung Galaxy A34 (SM-A346E, Android 13) used for the custom-engine baseline. This is an integration check, not an equivalent one-hour endurance or performance comparison.

## Session and results

- Session: `db70cf133f172ec2e16e348198940571`.
- Time: **00:40:11–00:42:11 on 8 October 2026, Asia/Dubai**. Stored UTC: `2026-10-07T20:40:11.026Z` through `2026-10-07T20:42:11.210Z`.
- Duration: 120.184 seconds; automatic stop reason `duration`; zero unfinished probes.
- All scheduled diagnostic types enabled; Google ICMP/TCP/traceroute targets, controlled Mac UDP echo, and USB-forwarded HTTP. Download/upload sizes were 50 MiB, with loaded latency enabled and a 512 MiB session budget.
- **12 measurements, 13 events and three context snapshots** synchronized. The phone displayed zero pending records after sync. No existing phone data was cleared.

| Measurement | Observed result |
| --- | --- |
| ICMP (`icmpenguin`) | Two ten-probe bursts; **20/20 replies**, pooled median RTT **16.268 ms** |
| ICMP bytes | All 20 replies retained their full **72-byte ICMP message**, including type 0/code 0, checksum, identifier, sequence and 64-byte payload; sequence/payload checks passed |
| TCP (`react-native-tcp-socket`) | **2/2 connections**; callback durations 27.192 and 21.514 ms; local/remote endpoint metadata and zero application bytes read/written recorded |
| Traceroute (`icmpenguin`) | Destination reached at **hop 10**; 30 results: 26 `HostUnreachable` classifications, three timeouts and one destination `ConnectionRefused` |
| UDP echo (`react-native-udp`) | Twenty acknowledged sends and **0/20 replies**; timeout, no valid RTT/jitter; 40 raw send callbacks retained, zero dropped callbacks |
| HTTP | Both standalone RTT tests and all four 50 MiB transfers (standalone and loaded) succeeded |
| Loaded latency | Download and upload tests succeeded, with five and 16 overlapping replies respectively |

The traceroute classifications are the library's labels. Its specialized variants discard the original ICMP type/code, so `HostUnreachable` must not be presented as actual ICMP Destination Unreachable or used to infer that the successful route failed. The destination refusal is library-level arrival evidence; this build does not expose its original ICMP header. TCP durations include resolution and callback overhead, unlike the baseline's native connect duration.

UDP echo failed on the same controlled Wi-Fi path that failed with the custom engine. This does not identify a library defect. No incoming datagrams were logged by the Mac echo server during the earlier reachability checks; the route/VPN/access-network issue remains unresolved. HTTP transfer speeds remain USB/app/server measurements, not satellite/internet capacity.

## Raw-data checks and implementation identity

The release used `icmpenguin` 1.0.0-rc.3 for Android ICMP/traceroute, `react-native-tcp-socket` 6.4.3 and `react-native-udp` 4.1.7. The APK contained the upstream `libicmpenguin.so` and **no `libcapstonepacket.so`**. The application-owned C++ engine and JNI probe module are absent from this branch.

All **164 app tests**, TypeScript checking and lint passed; six physical Android instrumentation checks passed, including IPv4/IPv6 ICMP bytes, UDP traceroute loopback, cancellation/reuse, accurate error-origin labeling, app launch and SpeedChecker consent rejection. The SDK-enabled release built successfully. No public SpeedChecker or NDT7 test was started.

The smoke run used the code represented by `41eb99b`. Subsequent correction `9565498` removes a misleading `responderAddress` alias from ICMP observations: `icmpenguin` supplies the configured remote address, not an independently observed reply source. Archived smoke objects retain the original alias for provenance; treat it as target metadata, not source-address evidence. The corrected adapter declares observed source addresses unavailable; its targeted tests, TypeScript and lint passed. Historical records were not rewritten.

The exported bundle contains 12 measurement rows, **20 packet JSONL records** and **87 library request/callback JSONL rows**. Every exported packet object matched the saved source object exactly. The ICMP objects retain raw library reply bytes and callback fields; missing kernel timestamps and TCP_INFO are not synthesized.

Ignored local artifacts are under `backend/data/experiments/2026-10-08-library-smoke/`: `source-session.json`, `comparison.json`, and the eight-file `export/` bundle. The comparison tool ran against the October 7 custom baseline and explicitly reported configuration differences. The duration and payload allowance differ; no performance superiority is established.

## What this comparison establishes

Available libraries can provide useful packet evidence: actual ICMP reply headers and payloads, per-hop traceroute observations, UDP datagram bytes and TCP endpoint metadata. Our earlier claim that custom probing was necessary for any packet-level detail was too broad.

The custom engine retains additional fields these integrations do not expose: absolute kernel timestamps, TCP_INFO and consistently preserved traceroute ICMP error type/code. The next fair endurance comparison needs the same one-hour configuration and a working controlled UDP path. See [library choices, limitations and comparison commands](../library-packet-comparison.md).
