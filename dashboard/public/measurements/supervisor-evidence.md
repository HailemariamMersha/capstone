# Sharing per-test evidence with a supervisor

The offline packager turns an existing phone export and its corresponding Mac reference run into self-contained JSON files. It preserves the recorded technical detail, including failed and interrupted tests. It does not launch probes, repeat M-Lab, modify the phone or alter the original datasets.

## Build the bundle

Use the complete session/trip JSON export from the researcher dashboard, not copied dashboard table rows or an aggregate comparison report. The readable dashboard deliberately omits some raw fields. The Mac input is a completed baseline run directory with its original raw command files and integrity manifest.

```sh
npm run baseline:package -- \
  --app /path/to/complete-trip.json \
  --mac /path/to/sealed-baseline-run \
  --out build/supervisor-evidence/review-01 \
  --minimum-repeats 15

npm run baseline:verify -- --input build/supervisor-evidence/review-01
```

The output directory must be new or empty and separate from the inputs. The command creates that directory plus the sibling archive `build/supervisor-evidence/review-01.zip`. Existing archives are never overwritten. Send the ZIP privately; the receiver needs no application installation or original paths on your computer.

## Files

| App / Mac files | Contents |
| --- | --- |
| `traceroute_app.json`, `traceroute_mac.json` | Every complete or partial trace, configured/resolved target, hop/probe samples, RTTs, timeouts, destination reachability and raw library/command evidence |
| `icmp_app.json`, `icmp_mac.json` | Every echo measurement/burst, individual probe outcomes, timing and retained callbacks/output |
| `udp_app.json`, `udp_mac.json` | Every echo burst, individual datagram observations and all retained raw evidence |
| `tcp_app.json`, `tcp_mac.json` | Every connection attempt, duration, socket/endpoint observations and available callbacks/output |
| `cdn_app.json`, `cdn_mac.json` | All providers, phase timings, status, byte counts, body hashes and retained response headers |
| `resolver_app.json`, `resolver_mac.json` | Resolver discovery results, configured/observed resolver fields, request phases and retained evidence |
| `mlab_app.json`, `mlab_mac.json` | Both download/upload records, counters, elapsed time, outcomes and available library messages/terminal output |
| `other_app.json`, `other_mac.json` | Created only when additional measurement types exist; unfamiliar observations are not discarded |
| `repetitions.json` | Counts and shortfalls per configured target and device, with actual resolved-IP counts |
| `README.md` | Bundle-specific inventory, interpretation and repetition table |
| `redactions.json` | Paths and reasons for identity/authentication redactions; never the removed values |
| `manifest.json` | Source fingerprints and output byte lengths/SHA-256 hashes |

Every standard test family has an app and a Mac file, even when it has no observations. An empty measurement array means no evidence was recorded, not a zero metric.

Each test file uses this structure:

```json
{
  "schemaVersion": 1,
  "source": "app",
  "test": "traceroute",
  "metadata": {},
  "measurements": [],
  "commandOutputs": {}
}
```

`measurements` retains the stored technical record and unfamiliar fields. `metadata.sessions` contains the relevant session configuration and technical snapshots; `metadata.origins` connects each original measurement ID to its parent session. Collection intervals, library/tool versions and evidence-availability counts are included.

For Mac records, `raw.request.outputFile` is preserved as a provenance key. Look up that key inside the same file's `commandOutputs` object to read the command arguments, stdout, stderr, exit status, timing and capture limits. A command shared by the two M-Lab directions is embedded once in `mlab_mac.json`.

## What counts toward fifteen

The default target is fifteen completed executions **per configured target and device**, not fifteen packets, hops or CSV rows. The package includes all original measurements, including those beyond fifteen.

- One ICMP burst or UDP burst counts once, regardless of its sample count.
- One traceroute to one destination counts once. Each registered destination is counted separately.
- Each CDN provider is counted separately. Resolver-discovery nonce hostnames belong to the same NextDNS test configuration.
- A terminal failure, including a timeout, counts as a completed attempt and remains visibly failed. Cancelled/interrupted and unavailable outcomes are separate and do not count as completed.
- M-Lab counts linked download/upload pairs against the automatic-server-selection profile. It uses a recorded run identifier, shared Mac command reference or shared execution/scheduled slot within the same session; it never pairs arbitrary direction records just to reach the target. Missing, interrupted or ambiguous pairs remain documented.

`remaining` is the shortfall to the chosen minimum. These counts do not claim fifteen statistically independent observations, fifteen successful results or fifteen verified matching-IP comparisons. Actual resolved-IP counts remain separate: two devices requesting the same hostname can reach different servers.

A burst using multiple resolved destinations still counts as one execution. Its destination breakdown can count that burst once against each observed IP; mixed and unknown destination counts are explicit. Intermediate traceroute hop addresses are not counted as destination addresses.

## Detail and limits

Traceroute samples are in `route.samples`; echo/connection samples are normally in `details.samples`. Retained library callbacks are in `raw`, including any sample-level raw objects. CDN/resolver fields are in `paper`; M-Lab counters are in `reference`. See the [measurement guide](guide.md) and [column dictionary](columns.md) for units and calculations.

JSON field names describe the record. They are distinct from HTTP or network packet headers. HTTP response headers were allowlisted at collection time. Complete IP/TCP/UDP wire headers, discarded HTTP bodies and unrecorded kernel timestamps cannot be reconstructed; the packager preserves packet fields that were actually collected.

Nulls and missing fields remain unavailable. Zero remains zero. Decimal timestamp strings remain strings. Original `outputCapture`, `droppedCallbacks` and unavailable markers are retained; packaging cannot recover truncated output. A traceroute library's `complete` stop reason does not imply `route.reached`.

## Privacy and integrity

Keep the directory and ZIP outside Git. The generated files have private permissions. They retain technical addresses, Wi-Fi context and exact times, so they are **private research evidence**, not an anonymized public dataset.

Account/payment/flight fields are excluded; recognized authentication secrets are masked even inside URL parameters, JSON command output and header text. `redactions.json` identifies affected paths. Its `~json`/`~jsonl` markers describe JSON embedded inside strings. Original source files remain unchanged.

The packager verifies the sealed Mac run before reading referenced raw commands, confines command references to that run and refuses missing/unsafe evidence. It rejects duplicate/conflicting measurement evidence rather than inflating repetition counts. The final manifest covers every sharing file except itself; the ZIP contains those exact files and the manifest. Hashes detect changes, not collector authenticity.

This command packages existing evidence only. Use the [validation guide](validation.md) to plan further experiments after reviewing the shortfalls.
