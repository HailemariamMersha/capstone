# Library packet measurement comparison

The custom Android socket implementation and its one-hour baseline are preserved on `experiment/custom-packet-engine` at `b6a6d33`. This branch, `experiment/library-packet-probes`, replaces its active measurement paths with available libraries. It removes the application-owned C++ engine, JNI entry points, and `CapstonePacketProbe` module. React Native, scheduling, storage, controlled HTTP tests and format-3 exports remain shared. Kotlin code here only bridges library calls, cancellation and result serialization; it does not create sockets or implement ping/traceroute.

## Selected libraries and evidence

| Measurement | Library | Retained observations | Unavailable or different |
| --- | --- | --- | --- |
| ICMP | `me.impa:icmpenguin:1.0.0-rc.3` | Original callback variant, configured remote address, sequence, microsecond RTT, TTL and returned bytes; TypeScript decodes type/code/checksum/identifier/sequence from the actual ICMP reply bytes | Absolute kernel timestamps, observed reply source address, kernel-assigned request identifier and complete IP capture are unavailable. Library RTT uses its wall-clock timing; the custom engine uses a monotonic clock. Matching checks reply type, sequence and payload; request identifier is not verified |
| UDP traceroute | Same pinned `icmpenguin` artifact | Every returned per-hop `ProbeResult` field, offender/remote addresses, available RTT and classification; partial traces retained | Specialized errors omit original ICMP type/code. Do not reinterpret `HostUnreachable` as proof that the route failed |
| TCP connect | `react-native-tcp-socket` 6.4.3 | Callback timing, available local/remote address/port/family, application byte counters and errors before cleanup | Timing includes DNS and bridge/callback overhead. No `TCP_INFO`, SYN-only timing, TCP headers or retransmission counters |
| UDP echo | `react-native-udp` 4.1.7 | Requested/acknowledged sends, matching and nonmatching datagrams, exact payload bytes, sender metadata, callback timings, duplicates/reordering and complete-burst loss | No IP/UDP headers, ICMP errors or kernel timestamps. Uses a paced burst with final grace period, whereas the custom engine waits for each reply sequentially |

The existing `ping-react-native` dependency remains the non-Android ICMP fallback. The Android comparison uses `icmpenguin` for its returned reply bytes. The TCP/UDP packages retain the previously documented build-compatibility patches; these do not introduce our custom packet engine. NDT7 and SpeedChecker remain separate consented reference flows.

### Source-level findings

- [icmpenguin rc.3 source](https://github.com/impalex/icmpenguin/tree/1.0.0-rc.3): `ProbeManager::init_packet_data` treats ICMP probe size as the complete ICMP message, despite ambiguous high-level documentation. We request **72 bytes: eight header bytes plus 64 payload bytes**, matching the custom engine's payload size. `Success.data` contains the bytes returned by `recvmsg`, including the ICMP header. The adapter preserves those bytes and only decodes them after receipt; it does not fabricate response packets.
- In the pinned `ProbeManager::read_data`, `err_type` is assigned **`ee_origin`**, not `ee_type`. `NetError.errType` must therefore remain a raw library field, never an exported ICMP type. The adapter also leaves normalized ICMP codes unavailable for those errors. This corrects the earlier bridge's interpretation; historical records are not rewritten.
- [Upstream maintenance notice](https://github.com/impalex/icmpenguin): the project is unmaintained. This is a pinned comparison candidate, not a claim of long-term production support. rc.3 fits the existing Android toolchain; the newer rc.4 is not silently substituted.
- [compscidr/icmp at d2d098f](https://github.com/compscidr/icmp/tree/d2d098f8ce091b8a6e6eaa4eae2689d9483dd497) was inspected as another candidate. Its public `PingResult.Success` exposes sequence, size, milliseconds and address, but not the parsed response object or raw reply bytes. The inspected `Icmp.ping(InetAddress, ...)` also contains unfinished socket-close handling. It was not integrated or tested in this app, and no broad claim that libraries cannot provide packet details follows from this review.

Library-maintained socket code is still native code. This branch tests reusing it instead of maintaining our own engine. React Native reuse does not validate iOS ping/traceroute support: those platform paths still require separate testing.

## Raw output and comparison

The existing seven export files remain available, with one additive file: **`library-callbacks.jsonl`**. It preserves library requests, callbacks, missing-field declarations and dropped counts, including individual ICMP-burst callbacks. `packets.jsonl` includes available decoded ICMP observations and historical custom-engine records. Do not expect it to contain TCP wire segments or unavailable traceroute headers. All callbacks also remain in authoritative `session.json` and nested CSV JSON fields.

UDP callback retention remains capped at 256 observations with an explicit dropped count; unrelated datagrams retain at most 2,048 bytes with a truncation flag. Matching 128-byte echoes are retained intact. No absent telemetry is replaced by zero or an inferred ICMP error code.

Compare two closed-session JSON exports with:

```sh
node scripts/compare-packet-engines.cjs custom-session.json library-session.json > comparison.json
```

The comparison separates measurement methods, identifies library/engine versions, reports success and sample counts, inventories retained packet fields, and reports configuration differences and scheduling delays. A lower count of available fields means less observability, not a measurement of zero.

For a matched one-hour comparison, keep the same phone, access network, targets, duration, intervals, 50 MiB transfer sizes, loaded-latency setting and payload allowance. Resolve the controlled UDP endpoint first and document whether HTTP is on the USB or internet path. Preserve all failures and delay events. Compare ICMP reply rates/bytes, route arrival rates and raw-field availability first; do not directly equate library TCP callback duration with custom native connect duration. Sequential experiments can encounter changed routes/load and do not establish causal performance superiority.

The custom October 7 run's 244 measurements and 1,026 native probe records are documented in [the baseline report](experiments/2026-10-07-custom-engine-one-hour.md). Its raw exports stay in ignored local storage. A short library smoke test establishes integration only; an equivalent one-hour run remains necessary for an endurance comparison.

## Physical verification

The [8 October phone smoke test](experiments/2026-10-08-library-smoke.md) completed all 12 scheduled measurements, synced and exported the results. ICMP returned 20/20 replies with actual header/payload bytes; traceroute reached Google; TCP and HTTP succeeded. UDP echo still timed out on the controlled Wi-Fi path. The short run does not replace a matched one-hour comparison.

## Measurement interpretation audit

The [requirements audit](measurements/comparison.md) separates basic metrics, per-probe evidence and native kernel telemetry. The [guide](measurements/guide.md) and [complete column dictionary](measurements/columns.md) explain row types, units, source limitations and offline sanity checks for both saved experiments.
