# Validating SkyMeasure with standard network tools

The baseline script runs SkyMeasure's measurements from a computer on the phone's Wi-Fi, using established terminal tools. Comparing its results with the phone's shows whether the app's numbers are plausible.

This page covers what the script does, how to run it, which tools it uses and why, and how its results are compared with the app's. For rollout and deployment checks, see the separate [SkyMeasure validation](https://github.com/HailemariamMersha/capstone/blob/feature/skymeasure-participant-dashboard/docs/skymeasure/validation.md).

**Paired ground results, 27 November 2026:** a three-hour macOS reference beside the phone produced 46 conservatively matched UDP rounds, with mean burst median RTTs of 286.5 ms on the phone and 206.1 ms on the Mac. ICMP/TCP destination IPs differed, so they have no eligible agreement pairs. See the [graph, complete results and limitations](https://github.com/HailemariamMersha/capstone/blob/feature/skymeasure-participant-dashboard/docs/skymeasure/paired-validation-2026-11-27.md). This is an initial cross-device comparison; same-device/packet-level accuracy validation remains pending.

**Paper-suite update, 25 November 2026:** the default harness now imports the shared paper registry and runs five trace targets, five identical-object CDN fetches and resolver discovery. Controlled pairs remain only in explicit historical test policies. See [the exact schedule and HTTP semantics](paper-suite.md).

**Validation update, 25 November 2026:** simultaneous phone/computer runs now use **light probes only on the computer**. Full paper-suite reference runs are separate. Comparison differences require the same verified destination IP, protocol and TCP/UDP port. Exclusions are saved individually. Every finished run automatically saves readable CSVs, sanity checks, a report and an integrity manifest; an open segment is checkpointed during collection.

**Historical status, 23 November 2026:** two 20-minute baselines had been collected over real Wi-Fi to the lab server: see [First results](#first-results-23-november-2026). At that date, no run beside a phone had been done, so those runs provide no same-time differences or accuracy figures. See [What has been tested](#what-has-been-tested) for the updated status.

## What the script does

Standalone mode follows the app's probe schedule and replaces the phone's measurement libraries with terminal tools. Paired mode runs ICMP, UDP and TCP on the computer; it deliberately omits its paper jobs, extra controls and M-Lab so a second heavy benchmark does not compete with the phone. Only measurement and context traffic is sent: results stay on the computer, except that M-Lab publishes its own if you request that test in standalone mode.

Times with a plus sign count from when probing begins.

| When | What happens |
| --- | --- |
| First 60 s, standalone only | Assumed qualification delay based on two historical 21 November trips. This does not exercise the detector or predict every phone's qualification time |
| Every 60 s | ICMP burst from +1 s, UDP burst from +10 s, TCP connection from +20 s |
| +1, +3, +5, +7, +9 min of each round | Five traceroute targets, rotated |
| +30 s of each round | NextDNS resolver discovery |
| +4, +6, +8, +10, +12 min of each round | Five CDN object fetches, rotated |
| +1 to +3 min, once | M-Lab NDT7 download and upload, only if requested |
| Controlled pairs | Disabled in new paper-suite runs; retained in historical fixtures |
| Every 60 s | Public address and provider (ASN) lookup |
| Every 15 min from launch | Upload gap: the segment closes and probing stops for 22 s |

The table describes standalone mode. As in the app, probes run one at a time, late slots are skipped rather than replayed, and heavy tests are kept 60 s apart. The 22 s gap is the median of 53 historical upload pauses, not an actual upload. Use `--upload-pause 25s` for a reference run with the current 25 s live-upload allowance; actual phone pauses can be shorter or slip within the boundary grace. The simulator does not claim identical execution times.

Probe intervals, tolerances, transfer sizes and timeouts, data allowances and sample counts are imported from the app's source (`src/trips/` and `src/measurements/`), so changes there carry over. The rest is copied: **repeat any change to the loop in `src/trips/runtime.ts` in `scripts/baseline/schedule.mjs`, and any change to ICMP, UDP or traceroute settings in `tools.mjs` or `udp_burst.py`.**

Not simulated: the ASN detector, real uploads, battery rules and Wi-Fi switching.

## Tools selected, and why

A tool had to be widely used, send the same kind of traffic as the app, run without root, and give results for individual probes rather than only a summary.

| Measurement | App library | Baseline tool | Why this tool | Why not the alternatives |
| --- | --- | --- | --- | --- |
| ICMP echo | `icmpenguin` | `ping` (iputils on Linux) | The standard reference for echo time. Sends the same 64-byte payload and TTL | `fping` and a single `ping -c 10` send on their own timer. The app waits for each reply, then pauses 250 ms, so the script runs one `ping -c 1` per echo |
| Traceroute | `icmpenguin` | `traceroute` | Matches the configured IPv4 UDP method: destination ports starting at 33434, 20 hops, three probes per hop, 1 s wait, 60-byte IP packets (32-byte probe plus 28-byte IP/UDP headers) | `mtr` is built around repeated rounds, while the app makes one pass |
| TCP connection | `react-native-tcp-socket` | `curl` | Reports name lookup and connection times separately. Already on most systems | `hping3` needs root. `tcping` tools are less common and vary between versions |
| CDN object timing | OkHttp through a thin Android adapter | `curl` | Fetches the same 89,501-byte object from the five registered providers, checks its SHA-256, and records DNS/TCP/TLS/first-byte/body/total phases | A generic speed test does not measure the same object or callback scopes |
| Resolver discovery | OkHttp through the same adapter | `curl` | Uses an independent random hostname under `test.nextdns.io`; preserves unavailable resolver results | A plain resolver query cannot reproduce the service's egress-resolver observation |
| Historical controlled download and upload | RNFS, React Native `fetch` | `curl` | Retained in old policies and fixtures only | Not scheduled in new default runs |
| M-Lab NDT7 | `ndt7-client-android` (patched) | `ndt7-client` | M-Lab's official command-line client, same protocol | Other speed tests use different servers and methods |
| UDP echo | `react-native-udp` | `udp_burst.py` | **Not a standard tool.** See below | `nping`, `socat` and `iperf3` do not produce the app's numbered, paced packets and match the replies |
| Packet capture, optional | None | `tcpdump` | Independent record of when packets left and arrived | – |
| Clock and VPN checks | Android APIs | `timedatectl`, `ip route` | Standard system tools | – |

**UDP.** The lab server answers only its own 128-byte format, with a run ID and packet number, so no common tool can talk to it unmodified. The script uses a short Python program with ordinary sockets. Because it was written for this project, it is the weakest independent reference here: check it with `--pcap`.

**macOS** is also supported, with its own `ping`, `traceroute`, `sntp` and `route`. Linux is the reference platform.

<details>
<summary>Exact commands</summary>

```sh
# ICMP, ten times per burst with 250 ms after each
ping -4 -n -c 1 -s 64 -t 64 -W 2 google.com                  # Linux
ping -n -c 1 -i 0.1 -s 64 -m 64 -W 2000 google.com           # macOS

# Traceroute (macOS omits -4 and -N 1)
traceroute -4 -N 1 -n -m 20 -q 3 -w 1 -p 33434 google.com 60

# TCP: the connection time is read before TLS begins
curl -q -4 -sS --noproxy '*' --http1.1 -I -o /dev/null \
  --connect-timeout 10 --max-time 10 -w '%{json}' https://google.com

# One CDN example; the harness repeats this for the five registered URLs.
curl -q --ipv4 --http1.1 --noproxy '*' --silent --show-error \
  --max-time 90 --max-filesize 524288 -H 'Accept-Encoding: identity' \
  -D headers -o body -w '%{json}' \
  https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js

# Resolver discovery: the harness generates a fresh 32-hex-character nonce.
curl -q --ipv4 --http1.1 --noproxy '*' --silent --show-error \
  --max-time 20 --max-filesize 16384 -H 'Accept-Encoding: identity' \
  -D headers -o body -w '%{json}' "https://$NONCE.test.nextdns.io/"

# UDP, 20 packets of 128 bytes, 250 ms apart, up to 3 s for replies
python3 scripts/baseline/udp_burst.py --host $UDP_HOST --port 9876 --nonce $ID

# M-Lab
ndt7-client -format=json
```

On macOS, `ping` adds its 1 s send interval to the wait, so a lost echo took 3 s instead of the app's 2 s. `-i 0.1` brings it to 2.1 s.

`-q` is the first curl argument, so local `.curlrc` settings cannot add redirects, retries or other request changes. Hostname traceroutes first resolve and pin IPv4, with a 20 s resolution limit inside the same 45 s overall attempt deadline. Process termination can add up to two seconds of kill grace; the actual elapsed duration is retained. Cancellation interrupts the wait for resolution; the OS resolver itself may finish later. Raw evidence records the lookup and traceroute separately. Standalone preflight checks routing to all five trace targets, all five CDN hosts, the resolver-discovery host, Google and the probe server. Paired preflight checks only its enabled Google/lab targets and does not require traceroute. These are observations at preflight, not a guarantee that routes remain unchanged.
</details>

## Running it

You need Node 22.13 or later and Python 3. No npm install is required.

1. Install the tools.
   - **Linux:** `sudo apt install iputils-ping traceroute curl python3`
   - **macOS:** nothing to install.
   - **M-Lab, optional:** `go install github.com/m-lab/ndt7-client-go/cmd/ndt7-client@v0.10.1`, with `~/go/bin` on your `PATH`. Set `NDT7_CLIENT_VERSION=v0.10.1` so the version is recorded.
2. Put `SKYMEASURE_PROBE_URL` and `SKYMEASURE_UDP_IPV4` in `.env.skymeasure.local`. Other keys in that file are ignored.
3. Join the phone's Wi-Fi and **turn off any VPN**. The script refuses to start if a VPN carries any target, as the app does.
4. Check, then run:

```sh
npm run baseline:run -- --check           # checks only
npm run baseline:run -- --duration 20m --upload-pause 25s  # full suite, phone stopped
npm run baseline:run -- --help            # all options
npm run baseline:test                     # automated tests
npm run baseline:lint                     # Node ESM lint checks (npm dependencies required)
```

Ctrl+C stops and saves.

### Beside a phone

Start the trip on the phone and note the time it begins collecting. Within two minutes, run:

```sh
npm run baseline:run -- --duration 1h --upload-pause 25s \
  --phone-qualified-at 2026-11-25T14:03:20+04:00
```

Replace the example with the phone's actual qualification timestamp. An ISO timestamp with an offset or `Z` avoids timezone ambiguity; `HH:MM:SS` uses the computer's local date/time.

This mode shifts **ICMP/UDP/TCP by 30 s** and omits the computer's traceroutes, resolver discovery, CDN fetches, extra controls and M-Lab. It rejects `--accept-mlab` rather than silently ignoring it. A fixed shift cannot safely interleave two CDN requests that can each last 90 s. Run the full suite on the computer with the phone stopped as a separate experiment. Its heavy-test observations remain useful per-target references, but non-simultaneous medians do not establish app accuracy.

The phone can still run its own heavy tests. The comparison excludes an observation whose execution interval overlaps the other device's CDN, controlled transfer or M-Lab test. This reduces a known source of interference; it does not promise an unloaded link or detect unrelated traffic. For packet-level timing, capture the phone at a controlled Wi-Fi gateway.

### Options that need care

- `--accept-mlab` publishes your public IP address and results through M-Lab. Earlier pairs used 251–306 MiB.
- `--pcap` needs root. It captures all ICMP, UDP to the lab server, and UDP traceroute packets. The filter can include other traffic matching those protocols; use a researcher-controlled reference computer and keep the capture private.
- `--allow-vpn` is for testing the script. Its results are marked not comparable.

### Output

Files go to `build/baseline/<run>/`, which Git ignores. The runner uses owner-only directory/file permissions. **They contain IP addresses, so keep them private.**

| File | Contents |
| --- | --- |
| `segment-NNN.json` | Results in the phone's export format, marked `linux_baseline`. Works with `npm run measurements:analyze` |
| `control.json` | Extra router and lab-server probes that the app does not run |
| `run.json` | Recording/final status, configuration, tool versions, initial route/clock context, Git revision, dirty-source indication, source-file SHA-256 fingerprints, warnings and helper/capture status |
| `baseline.json` | All closed session exports in one file; accepted directly by `baseline:compare` |
| `summary.json` | Counts and per-protocol summaries, with failures separated from interruptions; paper phases remain grouped by target |
| `report.md` | Start here: UTC collection interval, run mode, protocol counts, target-specific paper results, sanity totals and links |
| `raw/<measurement-id>.json` | Command arguments, stdout, stderr, duration and exit/cancellation state. `measurement.raw.request.outputFile` links to it. The existing process-output guard is recorded through byte counts and truncation flags when triggered |
| `journal.jsonl` | Append-only measurements, events, network context and segment open/close records |
| `active-segment.json` | Atomic checkpoint updated while a segment is open; removed after its closed export is written |
| `trailing-events.json` | Events between segments or after final close, when present |
| `analysis/icmp.csv`, `udp.csv`, `tcp.csv`, `traceroute.csv` | One retained probe/connection/hop sample per row, across all segments |
| `analysis/cdn.csv`, `dns.csv`, `http.csv`, `http-latency-samples.csv` | Focused paper/HTTP views. Files for unscheduled methods contain headers only |
| `analysis/sanity-checks.json` | All segment audits, with separate error/warning/unavailable totals and original JSON pointers |
| `analysis/column-dictionary.md` | Generated definitions, datatypes, units, formulas and blank-value meanings for the CSVs |
| `analysis/records.csv` | One parent measurement per row, linking its session/measurement ID, aggregate JSON pointer, closed segment filename, raw command filename, library/version, scheduling timestamps and outcome |
| `manifest.json` | Relative file paths, lengths and SHA-256 fingerprints after finalisation; includes `probes.pcap` if requested |

Raw JSON is authoritative. CSVs reuse the existing measurement dictionary and preserve parent/sample identifiers; repeated parent values must not be summed. In combined run CSVs, `recordPath` points into `baseline.json` (for example `/sessions/1/measurements/3/details/samples/0`); the audit for each segment retains pointers relative to that segment's own JSON file. `records.csv` is an index, not a second set of measurements: all its fields are strings except unavailable blanks; timestamps are ISO UTC, IDs match original records, paths are relative to the run directory and `outcome` uses the existing success/failure/interrupted/unavailable classification. Zero remains zero; unavailable values remain blank. Nanosecond timestamps remain decimal strings in the original JSON.

The runner and comparison refuse nonempty output directories. `run.json` distinguishes `recording`, `complete`, `stopped` and `error`; Ctrl+C stops and finalises retained evidence. A process kill can leave `recording` plus the last active checkpoint and journal. Do not call that a completed run. A missing manifest means finalisation did not finish (historical runs also lack one). Analyse an active checkpoint into a separate folder if needed:

```sh
npm run measurements:analyze -- --input build/baseline/RUN/active-segment.json \
  --out build/baseline/RUN-recovery
npm run baseline:verify -- --input build/baseline/RUN
```

Verification detects changed, missing and unexpected files. Hashes detect accidental changes; they are not a cryptographic signature proving who collected the data. Keep the original run intact and put new comparisons/plots in sibling folders. `tcpdump` is stopped before hashing its capture. A local capture observes the reference computer, not the phone. No automatic result upload occurs.

Never send these to the participant ingestion API. On the dashboard, baselines should be a separate source.

## How the values compare with the app's

Both sides use the same formulas for median, 95th percentile and successive difference, because the script imports them from the app. That makes results comparable but cannot reveal an error in the formulas. `measurements:analyze` recomputes them separately.

| Measurement | App value | Baseline value | Comparable? |
| --- | --- | --- | --- |
| ICMP | Median time reported by the library for ten echoes | Median of ten `ping` times | **Yes**, for the same Google address. The phone sends more slowly: a median of 379 ms between sends in saved exports |
| ICMP and UDP loss | Probes with no reply in time | Same | **Yes**, over enough probes |
| UDP | Median time from send call to JavaScript callback | Median time around ordinary socket calls | **Yes**. A consistent gap points to app and library overhead |
| TCP | Name lookup, connection, and app overhead | Name lookup and connection | **Mostly**. A cached name on one device changes the value. The baseline also stores the handshake alone, which the app cannot separate |
| Traceroute | Hops to the destination | Same | **Partly**. Compare hop count and reachability. Labels differ, and routes can differ between devices |
| Transfers | Bytes over total time | Same | **Yes**, but only one pair an hour, so treat as individual observations |
| NDT7 | Client bytes down, server-received bytes up | Same | **Partly**. M-Lab may choose a different server, and there is one pair per run |
| Scheduling | Planned against actual start | Same | **Yes**. It shows Android delays |

All baseline probes use IPv4, as did every ICMP target and traceroute in the saved exports checked. Google can resolve to different addresses on each device, so the address is recorded.

### The extra probes

**Router.** Ten pings a minute to the local router show whether packets are already being lost before they leave the local network. Preflight turns this probe off if the router does not answer pings.

**Lab server.** The app sends ICMP and TCP to Google but UDP and transfers to the lab server. Its UDP median has been about 286 ms on long trips, but that alone cannot show whether UDP is slow or the server is far away. The baseline therefore also sends ICMP and TCP to the lab.

All extra probes run only when they cannot delay an app probe, and are stored separately.

| Pattern | Likely meaning |
| --- | --- |
| Phone UDP, baseline UDP and lab ICMP all similar | The delay is the path to the server |
| Only phone UDP is high | Suspect the phone's UDP library or callback timing |
| Both UDP values high, lab ICMP and TCP low | Suspect UDP handling on the path or server |
| Loss to the router similar to loss elsewhere | Suspect the Wi-Fi or the computer |
| Router clean, loss elsewhere | The loss is beyond the router |

Routers may give pings to themselves low priority, so loss at the router alone does not prove a Wi-Fi fault.

### The comparison report

```sh
npm run baseline:compare -- --phone export.json \
  --baseline build/baseline/RUN --out build/baseline/RUN-report
```

`--phone` accepts files or folders and can be repeated. The report contains:

1. **Whether the runs can be compared:** time overlap, public address, provider, Google addresses, VPN, Wi-Fi and clock. Public addresses are compared but not printed in the Markdown report; private saved input JSON still contains them.
2. **Totals:** success, loss with a 95% interval, median and 95th percentile.
3. **Same-minute differences:** each eligible phone result is matched once with the nearest baseline result within 45 s **with the same verified destination IP, protocol and TCP/UDP port**. The report gives the median of phone minus baseline, the middle half, and limits of agreement (mean ± 1.96 standard deviations). Unknown destinations, bursts spanning multiple IPs, unavailable values, failed/interrupted attempts, invalid timing, known network/VPN/clock mismatches and other-device heavy overlaps are excluded. No eligible pairs means null statistics, not zero error.
4. **UDP path and packet loss tables**, transfer phases and scheduling delays.

Positive differences mean the phone's value was larger. Results interrupted by a clock gap are excluded from timing.

The comparison folder contains `comparison.md`, `comparison.json`, `paired.csv` (one accepted pair with both IDs, timestamps and difference in ms), `excluded.csv` (one excluded source measurement with its reason), `inputs.json` (the parsed sessions actually used, source paths/hashes, controls, environment and baseline status/integrity) and its own `manifest.json`. A baseline with a final manifest is verified before comparison; changed/missing files stop the command. Historical or unfinished folders without manifests remain usable with an explicit warning. Raw terminal command files remain in the identified baseline run directory. Retain both folders. The same session exported twice is counted once; contradictory copies are rejected rather than silently picking one. Unknown clock/network context remains an explicit limitation even when destination-matched descriptive pairs can be formed.

The report sets no pass or fail limits. **Decide the acceptable difference for each measurement before reading the results.**

### Limits

- The computer has a different Wi-Fi radio, system and position. Agreement is a cross-check, not proof of the phone's accuracy. Disagreement does not by itself show an app fault.
- In paired runs the light probes are about 30 s apart. Short changes in the network appear as differences, and slow probes can still overlap. Full-suite computer tests run separately; do not present those medians as simultaneous agreement.
- Loss intervals assume independent probes. Real losses cluster, so the true uncertainty is wider.
- Nothing here tests flight detection or in-flight conditions.
- For packet-level accuracy, capture the phone's own traffic at a gateway.

## First results, 23 November 2026

**Conditions:** two 20-minute solo runs from a Mac (macOS, not Linux) on Wi-Fi with no VPN, AS5384 (Etisalat), without M-Lab. Times are Dubai time. Run 1 was 13:01–13:21, before the router probe existed. Run 2 was 13:40–14:00. Each completed with two segments, one transfer pair and one 22.0 s upload gap. The clock was within 0.5 s, `measurements:analyze` found no errors, and no timing was rejected.

**Background traffic:** these were unpaired development runs, not controlled unloaded baselines. The second run overlapped this same Mac’s lab-server backup downloads during approximately 13:40–13:53 Dubai time. Backend maintenance/deployment activity also occurred during development. No gateway capture or server-load record isolates those effects. Keep the observations, but repeat with other transfers stopped (or explicitly accounted for) before attributing loss/throughput differences to the app or path.

| Measurement | Run 1 | Run 2 |
| --- | --- | --- |
| *Extra:* router, answered / loss | not run | 160/160, 0% (0–2.34) |
| ICMP to Google, answered / loss | 168/180, 6.67% (3.85–11.29) | 152/180, 15.56% (10.99–21.56) |
| UDP to lab, answered / loss | 333/360, 7.50% (5.21–10.69) | 306/360, 15.00% (11.68–19.06) |
| *Extra:* ICMP to lab, answered / loss | 155/170, 8.82% (5.42–14.05) | 143/160, 10.62% (6.74–16.36) |
| *Extra:* router, median / p95 | not run | 5.0 / 44.8 ms |
| ICMP to Google, median / p95 | 30.2 / 105.8 ms | 30.8 / 106.3 ms |
| UDP to lab, median / p95 | 219.0 / 293.6 ms | 219.1 / 290.9 ms |
| *Extra:* ICMP to lab, median / p95 | 260.7 / 277.0 ms | 257.1 / 275.5 ms |
| TCP to Google, median / p95 | 33.8 / 384.2 ms, 18/18 | 34.7 / 348.1 ms, 18/18 |
| *Extra:* TCP handshake to lab, median | 222.9 ms, 18/18 | 266.1 ms, 18/18 |
| Traceroute to Google | 2/2, 10 hops each | 2/2, 11 and 10 hops |
| Controlled download | Timed out at 90 s with 4,959,760 of 5,000,000 bytes, 0.44 Mbps | Timed out at 90 s with 1,507,328 bytes, 0.13 Mbps |
| Controlled upload | 1.33 Mbps | 3.03 Mbps |

Loss shows the 95% interval in brackets. All 18 ICMP and 18 UDP bursts succeeded in each run. Each download overran one minute, so one ICMP, one UDP and one TCP slot were skipped; the app does the same.

### Against the phone's 21 November trips

The phone figures come from the saved exports of the two trips in the [21 November report](https://github.com/HailemariamMersha/capstone/blob/feature/skymeasure-participant-dashboard/docs/skymeasure/collector-validation-2026-11-21.md). The public address and provider match, but **the runs are two days apart and reached different Google addresses**, so this is context rather than a comparison of accuracy.

| | Baseline, run 1 / run 2 | Phone, 10 min | Phone, 11.3 h overnight |
| --- | --- | --- | --- |
| ICMP median | 30.2 / 30.8 ms | 20.0 ms | 34.3 ms |
| ICMP loss | 6.67% / 15.56% | 0% | 1.48% |
| UDP median | 219.0 / 219.1 ms | 208.8 ms | 286.6 ms |
| UDP loss | 7.50% / 15.00% | 0% | 3.31% |
| TCP median | 33.8 / 34.7 ms | 26.0 ms | 43.1 ms |
| Traceroute | 10 / 10 and 11 hops | 10 hops | 10 hops median |
| Controlled download | Both timed out | 3.33 Mbps | 0/2 completed |
| Controlled upload | 1.33 / 3.03 Mbps | 3.56 Mbps | 1/3 completed, 1.15 Mbps |

### What this shows

1. **The lab path itself has substantial RTT.** Baseline UDP, ICMP and TCP to the lab took roughly 200 ms or more without using the phone libraries, while Google answered around 30 ms. This supports a destination/path contribution; it does not quantify the phone’s own overhead or establish what fraction of its delay is caused by the path.
2. **Recorded outcomes vary.** The two unpaired runs used different Google addresses, and the second had documented concurrent backup traffic. Their differences cannot be assigned to intrinsic path changes alone.
3. **Router and external non-response differ.** In run 2 the router answered 160/160 probes while external tests saw non-response. The probes ran at different instants and routers can treat ICMP differently. This motivates more controlled checks; it does not locate the loss or rule out Wi-Fi effects.
4. **Non-response occurred for both ICMP and UDP.** ICMP-specific filtering alone does not explain all recorded missing replies; protocol, path and load effects remain possible.
5. **Slow fixed-size transfers also occurred with curl.** Both downloads timed out after early response headers. This establishes that the symptom can occur outside the app; it does not identify the bottleneck or prove the app has no additional overhead.

### What the 23 November runs do not show

- **Phone accuracy.** Nothing was measured at the same time on both devices. Any delay added by the phone's UDP library is still unmeasured.
- **Where beyond the router packets are lost, or why.** The router probe ran about 20 s after the Google burst each minute, not at the same instant. The router's replies reached 93 ms, so the local network adds some delay even without loss.
- **Whether the phone saw the same loss.** Its lower loss was on other days. Only a run beside the phone can tell whether the two devices differ.
- **Why transfers are slow.** One possibility is that long delay and packet loss limit a single TCP connection. Server load was not measured, and two pairs are too few to conclude.
- **Why the path takes 200 ms or more.** The [location clues](https://github.com/HailemariamMersha/capstone/blob/feature/skymeasure-participant-dashboard/docs/skymeasure/lab-migration.md#location-update--23-november-2026) suggest Ashburn but do not confirm the facility. If that inference is correct, approximately 11,300 km to Dubai implies a straight-fibre lower bound near 113 ms RTT. Actual cable routing, queueing and server processing were not isolated; these observations cannot partition the measured delay into those components.

## What has been tested

| Check | Result |
| --- | --- |
| Automated baseline tests, 25 November | 44 of 44 pass, including endpoint/exclusion rules, deadlines, paired scope, checkpoint recovery, private outputs, integrity checks and the comparison CLI |
| Export and paper-suite regression tests, 25 November | 28 of 28 pass across three suites |
| Node ESM lint, 25 November | `npm run baseline:lint` passes |
| Schedule against the 11 h 17 min 56 s overnight phone trip | Exact match: 675 ICMP, UDP and TCP, 46 traceroutes, 46 segments, with that trip's two 90 s download timeouts included |
| 17-minute run with local copies of the servers | Completed, with one transfer pair and one 22.0 s gap |
| Export format | `measurements:analyze` found no errors in the segments of the local run or either live run |
| Non-overlapping phone exports, 23 November | Reports produced; each warned that the runs did not overlap and reached different Google addresses |
| Paired phone/macOS ground comparison, 27 November | Three-hour reference; 46 conservative UDP pairs, phone mean burst median RTT +80.4 ms above Mac. No eligible ICMP/TCP pairs because destination IPs differed. [Report and graph](https://github.com/HailemariamMersha/capstone/blob/feature/skymeasure-participant-dashboard/docs/skymeasure/paired-validation-2026-11-27.md) |
| VPN check | Correctly refused to start |
| Two 20-minute live runs on macOS over Wi-Fi | Completed; every measurement type except M-Lab ran. The second included the router probe |
| Linux | **Not tested.** Output parsing was checked only against sample text written for the tests |
| Computer-side M-Lab and `--pcap` | **Not tested**; the phone completed its own M-Lab pair during the paired run |

The schedule match shows that the timing is reproduced. It says nothing about measurement accuracy.

**Next:** repeat with identical fixed IPv4 targets for ICMP/TCP, then isolate the UDP timing difference with a same-phone reference or gateway packet capture and documented power settings. A Linux reference remains useful, but a cross-device difference alone cannot quantify library overhead.
