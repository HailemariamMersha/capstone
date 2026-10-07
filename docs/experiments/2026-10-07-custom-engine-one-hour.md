# One-hour Android experiment results — 7 October 2026

Session `9d426534d8f4e483b4cfb2982761e427` completed from 21:15:34 to 22:15:34 Asia/Dubai (17:15:34.124–18:15:34.304 UTC). Actual duration: 3,600.180 seconds. The saved stop reason is the duration limit, with zero unfinished probes. All 244 measurements were synchronized; the completion automation observed zero pending phone records, including the older backlog. This is the count at finalization, not a new live phone check.

## Results

| Measurement | Result |
| --- | --- |
| HTTP RTT | 60/60 successful; median 25.56 ms, nearest-rank p95 71.86 ms |
| ICMP to Google | 60 bursts, 599/600 individual replies; one timeout (0.17% non-response). Pooled reply median 16.975 ms, p95 52.963 ms |
| TCP to Google:443 | 60/60 connected; median native connect duration 13.95 ms. Median kernel RTT 12.66 ms; zero reported total retransmissions in all 60 short connections |
| Traceroute to Google | 4/4 reached the destination, at hops 11, 11, 10, 10. Across 126 probes: 105 ICMP Time Exceeded responses, nine Port Unreachable responses, and 12 timeouts |
| Controlled UDP echo | 0/240 replies across 12 bursts; all individual probes timed out. All recorded sends reported 128 socket bytes, but no valid RTT or jitter was obtained |
| Standalone HTTP download | 12/12 successful, each exactly 50 MiB; median 259.66 Mbps |
| Standalone HTTP upload | 12/12 successful, each exactly 50 MiB; median 92.03 Mbps |
| Loaded download latency | 12/12 successful; median of per-run RTT medians 58.83 ms; five or six fully overlapping replies per run |
| Loaded upload latency | 12/12 successful; median of per-run RTT medians 17.39 ms; 15 fully overlapping replies per run |

All 48 transfers, including the 24 loaded-latency transfers, confirmed exactly 52,428,800 bytes apiece. Combined confirmed transfer payload was 2,516,582,400 bytes (2,400 MiB / 2.34375 GiB), excluding small probes and protocol overhead.

## Libraries actually exercised

- `react-native-background-actions`: the session reached its one-hour duration limit; the service was present in all 58 observer samples between 21:18 and 22:15. This verifies this connected-phone run, not every Android background or locked-screen condition.
- React Native `fetch` and TypeScript: successful HTTP RTT, acknowledged uploads, and concurrent latency sampling.
- `@dr.pogodin/react-native-fs`: all 24 downloads, including loaded downloads, used `http_download_to_file` and confirmed 50 MiB. The session completed without an interruption event.
- Our `capstone-linux-sockets` Android adapter: ICMP, TCP, UDP echo, and traceroute. All 1,026 exported native probe records identify this engine. `ping-react-native`, `react-native-tcp-socket`, and `react-native-udp` are fallback dependencies and were not exercised by these Android probe paths. `icmpenguin` is no longer installed.
- `@react-native-community/netinfo`: 49 saved Wi-Fi snapshots, each with SSID, BSSID, and signal-strength fields. Public IP and ASN were unavailable through the local HTTP context endpoint.
- `react-native-device-info`: battery values ranged from 85% to 100%; 36 snapshots reported charging and 13 reported not charging. These are observed API states, not an independent check of cable state or energy consumption.
- `@op-engineering/op-sqlite`: 244 measurements, 99 events, and 49 context snapshots were persisted and synchronized.

NDT7 and SpeedChecker were not included.

## Limitations and follow-up

HTTP transfers and loaded latency used USB forwarding to the Mac. These throughput numbers characterize the local app/USB/server path, not internet or satellite capacity. Google probes used the phone's internet connection; UDP echo targeted the Mac over Wi-Fi. The loaded HTTP tests therefore do not establish latency under load on the Google path. The baseline/loaded results also do not establish a bufferbloat effect.

The UDP server logged no incoming datagrams. Setup found that the Mac routed replies toward the phone through a VPN interface; binding the server socket to Wi-Fi did not restore echo. The exact network cause remains unresolved. This run establishes failed echo on this path, not a defective UDP library or lack of Android UDP support: UDP traceroute successfully elicited ICMP responses.

There were 82 scheduling-delay events and zero reported skipped intervals. All nominal measurement counts were present, but start times were not uniformly spaced: the largest delay was approximately 110 seconds, and minute-scale probes sometimes started over 50 seconds late. The scheduler runs probes sequentially, and each unanswered 20-probe UDP burst occupied approximately 45 seconds in the first batch. The timing records should be retained when comparing measurements. Resolve the UDP path and reduce blocking from long diagnostics before drawing conclusions that depend on synchronized or evenly spaced samples.

## Export verification

The format-3 bundle contains 244 measurement CSV rows, 1,342 sample CSV rows, and 1,026 raw native probe JSONL records. Every exported native probe object was compared with its corresponding saved object and matched exactly. Measurement CSV IDs match the saved measurements. No native dropped-observation count or receive/control truncation flag was recorded. Raw observations cover our probe socket results, not full packet capture.

Files are in `export/`: `session.json`, `measurements.csv`, `samples.csv`, `packets.jsonl`, `events.csv`, `network-context.csv`, and `README.txt`. Supporting computed statistics are in `analysis.json`; the synchronized input is `source-session.json`.
