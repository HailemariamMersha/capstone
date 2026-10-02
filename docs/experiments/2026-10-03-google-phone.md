# Physical Android packet experiment — 3 October 2026

The SDK-enabled release from commit `f72520e` was installed on the connected Samsung Galaxy A34 (SM-A346E, Android 13) using `adb install -r`. Saved phone and backend data were preserved. All nine instrumentation checks passed on the phone, including the real bundled app launch, ICMP/UDP IPv4 and IPv6 loopback behavior, TCP_INFO, cancellation/cleanup, and SpeedChecker consent rejection.

## Session

- ID: `0d4f1613fabafe5e414c9356674265a2`.
- Time: **02:36:41–02:38:41 on 3 October 2026, Asia/Dubai**. Stored UTC timestamps: `2026-10-02T22:36:40.959Z` through `2026-10-02T22:38:41.154Z` (120.195 seconds).
- Network: Wi-Fi; app remained visible. Phone was charging at the start, with 91% battery.
- Targets: ICMP and UDP traceroute `google.com`; TCP `https://google.com` (port 443, without HTTP/TLS). All saved probes resolved to `142.250.187.78` in this run.
- Configuration: two-minute duration, ten ICMP probes every 60 seconds, TCP every 60 seconds, one initial UDP traceroute with three probes per hop and a 20-hop maximum.
- HTTP transfers, controlled UDP echo, loaded latency, NDT7 and public SpeedChecker tests were not started.
- Automatic stop: duration limit; five completed measurements and no unfinished attempts. Reserved payload allowance was 6,400 bytes, which is not measured carrier usage.

## Results

| Measurement | Observed result |
| --- | --- |
| ICMP | Two bursts, **20/20 replies**; combined median **16.007 ms**, minimum 8.978 ms, maximum 20.167 ms |
| TCP | Two successful connections; native connect times **9.021 ms** and **12.427 ms** |
| TCP kernel telemetry | `tcpi_rtt` 8,187 and 11,618 microseconds; zero reported total retransmissions in both short connections; congestion window 10 segments |
| UDP traceroute | Destination reached at **hop 10**, 30 probes, approximately **3.409 seconds** |
| Trace ICMP evidence | **24 Time Exceeded replies (type 11/code 0)** and **3 destination Port Unreachable replies (type 3/code 3)** |
| Silent probes | All three probes at hop 6 timed out; later hops and the destination replied |

These were real router/destination responses, not simulated hops. Different responders occurred at some equal hop limits; this is conventional UDP traceroute with changing ports, so it does not establish one fixed path. A silent hop did not prevent reaching Google. The destination's UDP Port Unreachable responses are the expected arrival evidence, not failed TCP or ICMP-echo measurements.

## Persistence, sync and export verification

The experiment produced 14 durable backend records: one session, five measurements, five events and three context snapshots. The phone initially had 448 pending records, including 434 older records. Nine acknowledged sync batches uploaded all 448 through USB to the Mac's local FastAPI backend. Backend record count increased from 3,759 to 4,207; the phone displayed **zero pending records**. No existing backend records were removed.

USB forwarding was `tcp:8000` on the phone to local Mac port `8001`, used only for deferred sync in this experiment. ICMP, UDP traceroute and TCP to Google used the phone's Wi-Fi path.

The synchronized session was exported through the shared format-3 serializer into the ignored local directory `backend/data/exports/2026-10-03-google-phone/`. The bundle contains five measurement rows, **52 sample rows and 52 full native packet-probe JSONL records**, five event rows and three context rows. Every exported packet object was compared with its saved JSON. ICMP identifiers matched their socket identifiers, reply payloads matched sent payloads, and nanosecond timestamp strings survived unchanged. No recorded buffer truncation or dropped observations occurred. This verifies computer-side export from synchronized records; the phone's multi-file share-sheet delivery was not exercised.

Raw artifacts remain local and are not committed: `session.json`, `packets.jsonl`, `samples.csv`, `measurements.csv`, `events.csv`, `network-context.csv`, `README.txt`, the source session and native test output.

## Scope of the evidence

This establishes that the replacement engine works on this physical phone and access network, including real forwarding-router ICMP Time Exceeded responses. It does not establish satellite-network reliability, uninterrupted hour-long/locked-screen endurance, public IPv6 reachability, remote controlled UDP echo, public reference-SDK success, or full packet capture. The native IPv6 and UDP echo checks used loopback. TCP_INFO describes these short connections, not a throughput run.
