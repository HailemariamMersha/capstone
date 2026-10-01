# Android packet measurement engine

New sessions started from the app default to ICMP bursts and UDP traceroute targeting `google.com`. TCP remains opt-in, with a separate **TCP target URL** defaulting to `https://google.com` (port 443, without HTTP or TLS traffic). The controlled HTTP server remains `http://127.0.0.1:8000`; UDP echo requires an explicitly configured server. Resumed sessions keep their saved targets; historical sessions without `tcpServerUrl` use their saved HTTP endpoint for TCP. HTTP measurements are opt-in. The scheduled packet tests use actual Android/Linux sockets, not `fetch`; packet-only context collection does not contact the HTTP context endpoint. Export and deferred sync work as before. Older saved configurations without `httpEnabled` retain their original HTTP schedule.

The shared React Native/TypeScript layer still owns configuration, schedules, interpretation, UI, storage and exports. A thin Kotlin bridge calls the repository-owned C++ engine because JavaScript socket wrappers do not expose Linux ancillary messages and error queues. No custom background service was added. Android uses this engine for ICMP, UDP and TCP; existing React Native ping/TCP/UDP packages remain for non-Android fallbacks. iOS adapters and builds remain unvalidated. The former `icmpenguin` engine has been removed.

## Methods and retained evidence

| Test | Mechanism | Evidence retained |
| --- | --- | --- |
| ICMP | Connected unprivileged `SOCK_DGRAM` ICMP/ICMPv6 socket; 64-byte echo payload | Returned ICMP header and payload hex, actual type/code/checksum/identifier/sequence, matching kernel-assigned identifier + sequence + payload, source, reply TTL/hop-limit, monotonic elapsed time, kernel receive timestamp when supplied |
| UDP traceroute | Connected UDP socket per probe, outgoing TTL/hop-limit increases, `IP_RECVERR` / `IPV6_RECVERR`, `recvmsg(MSG_ERRQUEUE)` | Original extended-error errno/origin/type/code/info/data, offender, quoted payload, ancillary control-message hex, receive flags, per-hop/per-sequence outcomes |
| Controlled UDP echo | 20 sequential 128-byte `CPSUDP1` datagrams with exact echoed-payload matching | Confirmed send bytes, send/receive payload hex and endpoint, matched/unmatched socket observations, errors, timeouts; loss calculated only for a complete run of confirmed sends with reply/timeout outcomes |
| TCP | Nonblocking `connect`, `poll` and `getsockopt(TCP_INFO)` | Connect duration excluding DNS, supported kernel RTT/variance, retransmissions, congestion window, state and before/after returned struct bytes |
| HTTP | Optional existing controlled transactions/transfers | Application-layer transaction latency and throughput, recorded separately |
| NDT7 / SpeedChecker | Separate consented reference flows | Bounded raw worker/listener logs, including NDT7 server messages with TCP telemetry when supplied, and available SDK metrics; no SDK-internal packet capture |

Linux defines the distinction between queued errors, the original payload and ancillary metadata in [recvmsg(2)](https://man7.org/linux/man-pages/man2/recvmsg.2.html). See also [icmp(7)](https://man7.org/linux/man-pages/man7/icmp.7.html) and [tcp(7)](https://man7.org/linux/man-pages/man7/tcp.7.html). The collector preserves kernel values before TypeScript interprets them; it never reconstructs ICMP type/code from `errno`.

Traceroute sends three probes per hop, up to 20 hops by default (configuration maximum 30), with 32-byte payloads, destination ports beginning at 33434 and a one-second probe deadline. It resolves once to a numeric destination for subsequent probes. An ICMP Time Exceeded message is distinct from Port Unreachable; the latter confirms arrival only when the responder is the target. Exact echoed UDP payloads from the connected destination also establish arrival. A trace has a 45-second overall deadline and retains partial observations. This is conventional UDP traceroute, not flow-stable Paris traceroute. Each reply measures round-trip time to that responder, not one link's latency.

## What these fields do and do not mean

- `sendBufferHex` is the buffer submitted to the socket. For ICMP it precedes kernel assignment of identifier/checksum; `sendBufferScope` explicitly records this. It is not a captured outgoing packet.
- Normal ICMP receive buffers include the ICMP message. UDP buffers contain application payload. Error-queue receive buffers contain the original datagram's quoted payload and separately exposed error metadata. They do **not** contain the whole outer ICMP error/IP packet.
- `recvmsg` ancillary messages are saved with level, type and data hex. `dataTruncated`, `controlTruncated` and `droppedObservations` make collection limits visible. Configured receive/control buffers are 2,048/1,024 bytes; up to eight observations per probe are retained, plus the matched terminal response. Collection stops at the first matched terminal response, so late duplicates are not collected. New native UDP runs do not claim burst duplicate/reordering statistics.
- Monotonic timestamps and kernel realtime timestamps are decimal **strings** in nanoseconds. Keep them as text in spreadsheets; they exceed JavaScript's exact integer range. RTT uses one monotonic clock. Do not subtract realtime from monotonic values. These are software/socket observations, not hardware transmit timestamps.
- TCP `tcpi_rtt` / `tcpi_rttvar` use microseconds; `tcpi_snd_cwnd` is in segments. They are kernel estimates/counters for the short connection, not captured SYN/SYN-ACK packets or a throughput-run retransmission trace. Returned struct bytes depend on kernel/ABI; parsed fields are guarded by returned length.
- A missing ICMP message remains a timeout. Routers/firewalls can suppress replies. Working loopback tests do not prove reliable responses across a satellite/cellular path.
- The app observes its own active test sockets. Full PCAP, arbitrary apps' traffic, full IP/TCP headers and modem/RF telemetry are not implemented. A separate VPN or privileged capture system would require a different collection architecture and validation.

## Bounds, persistence and portability

The bridge allows one active probe. Sockets close before a result settles; cancellation is checked during 50 ms poll intervals. Native timeouts are bounded to 10 seconds. DNS resolution gets at most three seconds and shares the probe budget. A resolver that ignores interruption may linger, but it is isolated to one thread with no queued resolver jobs; subsequent resolution can fail explicitly rather than create more threads.

Each measurement/sample saves the complete native result in `packet`, including unknown fields. OP-SQLite commits it with the result and sync entry. Export format 3 supplies seven files, including `packets.jsonl`, detailed `samples.csv`, reference callback rows and full `session.json`. Legacy measurements are not relabelled or backfilled. See [field dictionary](packet-exports.md).

Sync targets 512 KiB batches and sends a larger single record intact. The backend accepts up to 8 MiB; larger records fail explicitly and remain local. The collector's bounded buffers/logs limit growth; neither sync nor export trims a record to make it fit. NDT7/SpeedChecker callback logs cap at 256 callbacks and 262,144 serialized characters per direction/run, with dropped counts. SpeedChecker's final callback includes the public fields currently used by the adapter, not an undocumented SDK object dump.

The engine has no additional third-party native networking dependency. The packet source lives in a JNI subdirectory so React Native retains its default `OnLoad` module registration; an actual bundled-app launch test guards this integration. It builds for the configured Android ABIs using NDK 27.1.12297006 and CMake 3.22.1. Maintaining this small engine is an explicit tradeoff for auditable fields; it still needs OEM/OS and physical-network validation. Historical library decisions and related-paper repositories are in [the research review](research/packet-measurement-review.md).

## Reproduce validation

```sh
npm run typecheck
npm run lint
npm test -- --runInBand --watchman=false
backend/.venv/bin/python -m pytest backend/tests -q
cd android
./gradlew :app:connectedReleaseAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.labpracticeapp.diagnostics.PacketEngineTest
```

Seven packet-engine tests passed on the Android 16/API 36.1 ARM64 emulator: IPv4 ICMP header/identifier/payload; actual IPv4 UDP Port Unreachable; IPv6 echo/error codes; UDP echo and timeout; TCP_INFO; cancellation/token reuse; repeated IPv6 probes through the React Native bridge. An SDK-enabled release also passed these plus consent rejection and a full React Native screen launch (nine instrumentation tests total, including a bundled app-launch regression check). No public SpeedChecker/NDT7 test was started. All 158 app tests and 24 backend tests pass, as do TypeScript, ESLint and the offline Chromium/NDT7 worker test. A real IPv6 loopback result was round-tripped through the CSV/JSON/JSONL exporter with its full native object and nanosecond timestamp unchanged (validation artifacts are kept under ignored `backend/data/exports/2026-09-29-native-loopback/`). App tests cover classification, no-HTTP scheduling, cancelled/invalid native responses, raw exports and large-record persistence/sync; backend tests verify records above 1 MiB persist intact and requests above 8 MiB are rejected.

No physical phone was connected during this implementation. Before collecting the next research dataset:

1. Build/install the bundled release on the phone (`./gradlew :app:assembleRelease`, then `adb install -r app/build/outputs/apk/release/app-release.apk`). Keep the defaults for ICMP/trace or select a controlled target; HTTP can stay off.
2. Collect a short run, stop, then export CSV to obtain the seven-file bundle. Inspect actual `icmpType`, `icmpCode`, identifier/sequence, payload scopes and timeout/error rows. Sync after stopping and compare complete JSON records.
3. Run the controlled UDP echo server on a reachable LAN address. Set the phone's UDP target/port; `adb reverse` cannot forward UDP/ICMP. Compare against a server-side capture of only this controlled traffic, documenting capture point and clock.
4. Compare with Linux `ping` and UDP traceroute on the same access network; paths/timings can differ between devices. Validate a real Time Exceeded response, filtered-hop timeout and destination response. Current native loopback tests cover destination ICMP errors; they do not exercise a real forwarding router.
5. Repeat cancellation, network loss, lock/background and a full uninterrupted hour. September 28 traces used the previous engine and do not validate this replacement.
