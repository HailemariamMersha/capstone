# Five-hour Android diagnostic experiment — 3 October 2026

Status at this report: **running; final results and completion are not yet verified**. The Samsung Galaxy A34 (SM-A346E, Android 13) is running the SDK-enabled release from commit `9e30095`. Installation preserved existing phone data. The change allowing a 16 GiB session budget passed all 158 Jest tests, TypeScript checking, lint, and the Android release build before installation.

## Session and configuration

- Session ID: `54f378c88981a7a7a630904e4b8469ae`.
- Started: **3 October 2026, 12:26:50 Asia/Dubai**, from the phone UI rounded to seconds (`2026-10-03T08:26:50Z`).
- Expected duration limit: **17:26:50 Asia/Dubai** (`2026-10-03T13:26:50Z`), five hours after starting. This is an expected end time, not an observed stop.
- Transfer size: **50 MiB = 52,428,800 bytes in each direction**, including each loaded-latency transfer.
- Payload budget: **16,384 MiB = 16 GiB**. Nominal transfer payload is 12,000 MiB (approximately 11.72 GiB) if all 60 five-minute cycles execute, plus small probes. This is not a measurement of carrier usage or wire bytes.
- HTTP timeout: 120 seconds. Battery cutoff: 15% when unplugged. The phone was charging at 100% during setup.

| Measurement | Target/path | Schedule |
| --- | --- | --- |
| HTTP RTT | Controlled Mac server through USB forwarding | Every minute |
| HTTP download and upload | Controlled Mac server through USB forwarding | 50 MiB each, every five minutes |
| ICMP | `google.com`, phone Wi-Fi internet path | Ten-probe bursts every minute |
| TCP connect and kernel telemetry | `google.com:443`, phone Wi-Fi internet path | Every minute |
| UDP echo | Controlled Mac server on the shared Wi-Fi network, port 9876 | Twenty 128-byte samples every five minutes |
| Loaded HTTP latency | Controlled Mac server through USB forwarding | Separate 50 MiB download and upload loads every five minutes |
| UDP traceroute with ICMP responses | `google.com`, phone Wi-Fi internet path | At start and every 15 minutes; up to 20 hops, three probes per hop, 45-second deadline |

Network and battery context, measurement attempts, failures, and the raw observations supported by each adapter are saved alongside results. NDT7 and SpeedChecker are separate consented foreground reference tests and are **not part of this scheduled session**.

## Initial observations

The controlled UDP preflight returned the exact 128-byte payload before starting. At 302 seconds elapsed, the phone displayed **running**, **24 saved measurements**, and five TypeScript heartbeats. The read-only observer confirmed that the Android background measurement service was present. HTTP server logs showed successful responses for 50 MiB download requests and upload requests during this session.

These observations confirm initial collection activity. They do not establish that every probe succeeded, that every upload delivered its configured byte count, or that the five-hour session completed. Those claims require inspection of the saved measurement records.

## Paths, monitoring, and interpretation

The phone's HTTP endpoint is `http://127.0.0.1:8000`, forwarded over ADB USB to the Mac's local server on port 8001. HTTP throughput and loaded latency therefore characterize this local app/USB/server setup, **not internet or satellite throughput**. ICMP, TCP, and traceroute use the phone's Wi-Fi internet connection. Controlled UDP echo uses the shared Wi-Fi LAN. The loaded HTTP traffic does not load the same path as the Google probes.

The Mac's sleep prevention was renewed for five hours and 15 minutes around the start. The HTTP server, UDP server, and USB connection must remain available. The app was visible during initial verification; this does not yet establish locked-screen endurance.

Private supporting telemetry is stored in the ignored directory `backend/data/experiments/2026-10-03-five-hour/`: `run.json` contains setup metadata, `status.json` contains the latest observer sample, and `observer.jsonl` contains minute-by-minute service presence and HTTP response counts. The observer is read-only, stops approximately two minutes after the expected end, and does not stop, restart, sync, or export the session. HTTP counts are filtered by request timestamps and are supporting evidence, not a substitute for phone records. Final measurement data remains in the phone's SQLite database until the closed session is synchronized.

## Completion checks still pending

1. Read the saved session's actual stop time and reason; verify whether it reached the duration limit.
2. Synchronize the closed session and verify server acknowledgements without removing older data.
3. Export the format-3 bundle: `session.json`, `measurements.csv`, `samples.csv`, `packets.jsonl`, `events.csv`, `network-context.csv`, and `README.txt`.
4. Compare saved counts, failures, gaps, byte counts, and raw probe observations with the configured schedule. Account for deadlines and scheduler delays; nominal counts are not guaranteed counts.
5. Report ICMP loss and latency, traceroute response types and arrival rates, TCP connect/kernel telemetry, UDP results, and HTTP/loaded-latency results separately by network path. Check raw-data truncation indicators and unfinished attempts before drawing reliability conclusions.
