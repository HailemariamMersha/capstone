# Optional network diagnostics

Android is the validation target. Measurement logic is TypeScript and the socket libraries support Android/iOS; iOS and physical Android validation remain separate acceptance checks.

Enable these in **Session settings → Optional diagnostics** before starting a session. All are off by default. They use the existing lifecycle, SQLite history, exports, sync, and duration/battery/payload limits. An attempt reserves its planned payload before network activity. Tests run serially, except for intentional latency/transfer overlap inside loaded-latency tests.

| Result type | Schedule | Meaning and payload allowance |
| --- | --- | --- |
| `icmp_burst` | RTT interval, replaces the single ping | Ten 64-byte echo requests, sequential, 250 ms between completed attempts; up to 2 seconds native timeout per sample plus the adapter watchdog. Reserves 1,280 bytes for request/reply payloads. |
| `tcp_connect` | RTT interval | Connects to the HTTP server hostname and port (80/443 if omitted), then closes without application data. Measures resolution + connection + native/JS dispatch; **not isolated SYN RTT or TLS time**. Reserves zero application bytes; handshake packets still consume network data. |
| `udp_echo` | Every five minutes | Twenty 128-byte requests, spaced 250 ms after each send callback, to an explicit IPv4 address/port. Waits up to 3 seconds after the final send. Reserves 5,120 bytes for requests/replies. |
| `loaded_download` / `loaded_upload` | Each every five minutes | Three baseline HTTP latency samples, then one selected-size transfer with up to twenty concurrent HTTP latency probes, spaced 250 ms after each probe. Reserves the selected transfer size plus 92 bytes for latency responses. These are additional transfers. |

The budget excludes headers, DNS, handshakes, retransmissions, context, and sync. Failed/cancelled attempts keep their full reservation. UDP/ICMP diagnostic `transferredBytes` remains null because delivery of all sent traffic is not confirmed. Existing single-ping and HTTP accounting stays unchanged for comparability.

## Results and interpretation

History displays median RTT, nearest-rank p95, and **mean absolute difference between consecutive successful RTT samples**. The last statistic does not bridge a missing sample, is not one-way delay variation, and is null without two adjacent replies. Small sample counts are diagnostic observations, not precise population estimates.

JSON and CSV include a `details` object with protocol version, raw samples, sequence numbers, timestamps, failures, and summaries. CSV serializes it into one quoted cell. Existing JSON storage needs no schema reset or migration. These details travel through the existing sync pipeline.

- **ICMP:** The primary value is median native RTT. Non-response percentage requires a complete burst containing only replies/timeouts. Cancellation/native errors leave the statistic null. Filtering/rate limiting can cause missing replies.
- **UDP:** Replies must match the destination IP/port, the complete 128-byte request, its attempt nonce, and sequence number. Duplicates do not increase the reply count; arrivals below the highest previously received sequence count as reordered. Loss is `(confirmed sends − unique replies) / confirmed sends`, only after a complete burst and reply window. Cancelled/broken sockets produce no loss estimate. No replies may mean filtering or an unavailable server. This is round-trip loss; no direction is inferred. RTT includes native/JS callback overhead.
- **Loaded latency:** Only requests completed entirely during the load enter the loaded summary. Short transfers with no complete overlapping reply report `invalid_response`, retaining the load result and baseline samples. This is bounded-transfer latency, not proof of sustained saturation. Embedded load throughput is Mbps; the outer value is milliseconds. In-flight latency requests are cancelled when the load ends.
- **Movement:** Existing context snapshots/network-change events remain available. A burst can straddle a network change; it is not guaranteed to represent a single route.

## Physical Android testing

Install the release build using the README instructions. Connect the Mac and phone to the same Wi-Fi for UDP; `adb reverse` forwards TCP only. The release build permits cleartext HTTP only for `localhost`, `127.0.0.1`, and the emulator alias `10.0.2.2`. For a USB-connected physical phone, run from the repository root:

```bash
adb reverse tcp:8000 tcp:8000
backend/.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

In a second terminal, start UDP. Replace the example address with the **phone's Wi-Fi IPv4 address**; `/32` permits just that source:

```bash
backend/.venv/bin/python -m backend.udp_echo --host 0.0.0.0 --port 9876 --allow 192.168.1.23/32
```

Use `http://127.0.0.1:8000` for both the probe and sync server URLs. Use the **Mac's Wi-Fi IPv4 address** only for the UDP host, for example `192.168.1.10`, port `9876`. Allow incoming UDP connections in the Mac firewall if prompted. Enter the desired ICMP target independently. This setup tests HTTP/TCP over USB and UDP over Wi-Fi, so their latency values do not represent the same network path. To compare protocols over Wi-Fi, use a reachable HTTPS probe endpoint with a trusted certificate; a plain HTTP URL at the Mac's LAN address is blocked in this release. Start a one-minute session with optional tests enabled, inspect history, export JSON, and sync after collection stops. A larger download gives the loaded test more time, but a fast LAN may still produce too few samples.

Check that the phone uses the correct date and time before collecting field data. Elapsed measurements use a monotonic clock, but record timestamps use the phone’s wall clock.

For satellite testing, connect the phone through the satellite terminal and use reachable remote HTTP/UDP servers. A Mac on the same LAN tests the LAN. USB forwarding and ICMP `127.0.0.1` are adapter checks, not satellite measurements.

For the emulator, local servers can bind `127.0.0.1`; use `10.0.2.2` as the app's HTTP/UDP destination. The default UDP service permits loopback sources. It accepts only protocol-v1 packets and limits replies globally to 100/second; reaching this limit can cause apparent loss. It has no public authentication mechanism: restrict source ranges/firewall access when deploying remotely. It does not store server-side per-packet records.

## Dependency and experiment status

- `react-native-tcp-socket` 6.4.3 and `react-native-udp` 4.1.7 use pinned `patch-package` patches moving the Android namespace from the manifest to Gradle. `npm ci` applies them via `postinstall`. No custom Kotlin/Java measurement logic was added. [TCP source](https://github.com/Rapsssito/react-native-tcp-socket), [UDP source](https://github.com/tradle/react-native-udp).
- Traceroute remains outside this release. The installed ping parser does not expose intermediate-hop errors; UDP's `setTTL()` is unimplemented. [icmpenguin](https://github.com/impalex/icmpenguin) exposes Android hop results but is marked unmaintained and needs a new RN wrapper. That path requires native-adapter work and physical-device validation; no runtime-impossibility claim is made.
- [M-Lab NDT7](https://github.com/m-lab/ndt7-js) is now integrated as a separate, explicitly consented WebView reference test. Public M-Lab testing publishes measurement data and collects the public IP. It is never part of scheduled diagnostics. See [reference-test methods, byte accounting and validation limits](reference-tests.md).
- [Cloudflare's engine](https://github.com/cloudflare/speedtest) informed the loaded-latency design. We did not install its browser engine or use its public measurement service.

Physical-phone endurance, remote satellite-path measurements, and iOS builds remain required before field deployment. Emulator/LAN success establishes integration, not real-world accuracy.

## Validation in this increment

Android release compilation and an API 36.1 emulator run passed. The one-minute session saved eight measurements: the three original HTTP tests, ten-sample ICMP, TCP connect, twenty-packet UDP echo, loaded download, and loaded upload. The local UDP test returned twenty unique replies; each loaded test retained one overlapping reply and correctly left successive RTT difference null. The session stopped at its duration limit. All sixteen session/measurement/event/snapshot records were acknowledged by an isolated backend SQLite database; the app displayed zero pending records. Existing sessions remained visible.

Validation passed: 86 app tests, 18 backend tests, TypeScript, lint, and the final Android release build. Automated tests cover missing/duplicate/wrong-source UDP replies, cancellation, TCP timeout, incomplete loaded overlap, burst statistics, durable budget reservation, exports/sync, and serial scheduling.

### Physical Android follow-up (27 September 2026)

The release APK was installed on a Samsung Galaxy A34 (SM-A346E, Android 13), preserving existing records. Two one-minute sessions each saved eight measurement results and stopped at the duration limit. A longer session saved 86 measurements and stopped when the next payload reservation would exceed the 100 MiB budget; all three sessions ended with zero unfinished probes.

HTTP RTT, download, upload, TCP connection timing, and loaded download/upload latency succeeded through USB forwarding. These results validate integration, not satellite or Wi-Fi performance. ICMP and UDP targeted the Mac's Wi-Fi address and received no replies: complete ICMP bursts timed out on all ten requests, and complete UDP bursts sent twenty packets with zero replies. A separate Android shell ping to the Mac also received no replies. The devices had different Wi-Fi subnets; the cause of the unreachable path was not established. Successful physical-phone ICMP/UDP validation still requires a reachable peer network.

All 3,502 queued records, including older sessions, were acknowledged by the local backend in normal sync batches. The app displayed zero pending records. The durable backend database at `backend/data/ingestion.sqlite` contained 5 sessions, 1,960 measurements, 1,516 events, and 21 snapshots. The phone's automatic date/time was enabled before these new sessions; older records retain their original timestamps.
