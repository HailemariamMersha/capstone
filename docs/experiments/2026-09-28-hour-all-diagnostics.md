# One-hour diagnostic experiment — 28 September 2026

**Status at launch: running; not a completed endurance result.**

The hour-long session started on the Samsung Galaxy A34 (SM-A346E, Android 13) at approximately **13:58:44 UTC / 17:58:44 Dubai time**. Its configured duration is 60 minutes, with planned automatic stop around **14:58:44 UTC / 18:58:44 Dubai time**. Completion, full sample counts and final sync still require verification after that time.

## Configuration

| Setting | Value |
| --- | --- |
| Download and upload | 50 MiB each (52,428,800 bytes), including loaded-latency transfers |
| Duration | 60 minutes |
| Probe timeout | 120 seconds |
| Session payload allowance | 3 GiB (3,072 MiB) |
| HTTP RTT, ICMP burst, TCP timing | Every 60 seconds |
| Standalone download/upload | Every 5 minutes |
| UDP burst and loaded download/upload latency | Every 5 minutes |
| UDP traceroute | Initially and every 15 minutes |
| Context | Initially, approximately every minute and on network changes |
| Battery cutoff | At or below 15% when unplugged; phone was charging at 100% at setup |

The schedule has an immediate initial batch. Work is serialized except for the intentional HTTP latency probes during loaded transfers. Large upload preparation and long probes can delay subsequent work; persisted schedule-gap records must be included in the analysis. Missed intervals are not replayed in a burst.

Standalone and loaded transfers together plan approximately 2,400 MiB (2.344 GiB) in the hour, plus small diagnostic payloads. The 3 GiB allowance leaves headroom. This is planned application payload, not a wire/carrier-data cap. The default session allowance remains 100 MiB; the configurable upper bound was raised to 10 GiB to permit this experiment.

## Paths and observable variables

- HTTP RTT, download/upload, TCP timing and loaded latency use `http://127.0.0.1:8000` through USB forwarding to the Mac's updated FastAPI server on port 8001. These are USB/app reliability observations, not internet or satellite throughput.
- ICMP bursts and traceroute target `1.1.1.1` over the phone's internet connection. The preflight confirmed both paths worked; their RTTs are not directly comparable with the USB HTTP path.
- UDP targets the existing controlled Mac service on its Wi-Fi address, port 9876. Both a direct 128-byte preflight and the app's full 20-packet burst received no replies. The hour run retains UDP non-response observations. These cannot distinguish network filtering from an unreachable server and provide no successful UDP RTT/jitter samples unless reachability changes.
- Network type/connectivity, available Wi-Fi identity/signal strength, battery level and charging status are collected. The preflight populated Wi-Fi and battery fields. Public IP/ASN remain null for the local USB endpoint; this run does not establish public network identity. GPS coordinates are not collected by this pipeline.
- ICMP/UDP raw samples support median/p95, reply/non-response counts and successive-RTT differences where enough valid adjacent samples exist. Traceroute preserves partial routes. Loaded tests preserve baseline and overlapping RTT samples plus the embedded throughput result.
- SpeedChecker and NDT7 are separate foreground, consented reference tests. They are not scheduled during this experiment and do not expose our fixed 50 MiB payload setting.

## Preflight and memory fix

The first 50 MiB preflight crashed during download. Android recorded an `OutOfMemoryError` in React Native's response-to-base64 conversion under a 256 MiB Java heap limit. Its interrupted session and attempt were recovered and synchronized; they were not deleted or counted as successful measurements.

Downloads larger than 8 MiB now use `@dr.pogodin/react-native-fs` to stream into a temporary cache file. The method is `http_download_to_file`, and its timing includes file writes. Smaller downloads retain `http_full_transaction`. The worker must settle before cleanup or another download; protocol headers, compression and byte count are checked. This change affects method comparability and must be retained in analysis metadata.

The corrected two-minute preflight ran from 13:54:37 to 13:56:37 UTC. It completed 12 measurement records: 11 successes and one UDP no-reply failure. Standalone download/upload and both loaded transfers each confirmed exactly 52,428,800 bytes. Both loaded tests retained valid overlapping latency replies. ICMP, TCP and traceroute succeeded. All preflight records synchronized before the hour run started.

TypeScript, lint, 139 app tests and the SDK-enabled release build passed after the fix. A local read-only observer records timestamped HTTP server activity in `/private/tmp/capstone-hour-observer.json`; this is supporting evidence of traffic, not proof of saved measurements or final session completion.

## Completion checks

Keep the Mac awake and the phone connected for the USB path. The app should stop automatically at the duration limit. Reopen it afterward and synchronize closed-session records until no acknowledgements remain pending. Verify this exact session is completed, inspect requested/confirmed byte counts, failures, missing intervals, context availability and the duration-limit event. Do not infer successful collection from a foreground notification alone.

The hour-long result remains pending until these checks are performed. This document does not claim physical-network capacity or one-hour background endurance has already passed.
