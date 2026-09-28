# Probe-level exports

Export format **2** keeps the saved JSON as the source of truth and supplies convenient CSV projections. This does not change the SQLite schema: optional raw fields live inside existing measurement JSON. Old sessions still export; missing historical values are not backfilled from current library versions or invented.

## Files

Use **Export CSV** on a saved session to share all six files together:

| File | Granularity / contents |
| --- | --- |
| `session.json` | Complete saved session/configuration, measurements, events and context, plus `exportFormatVersion: 2` |
| `measurements.csv` | One row per attempt, including failures; flat summaries, context, embedded load-transfer values and the complete `rawRecordJson` |
| `samples.csv` | One row per stored diagnostic sample, baseline HTTP sample or traceroute probe; includes missing replies and errors |
| `events.csv` | Session lifecycle, schedule gaps, failures and other saved events, including details/raw JSON |
| `network-context.csv` | Context observations, their IDs/timestamps, connectivity, Wi-Fi and battery fields, plus full raw JSON |
| `README.txt` | Units, missing-value and interpretation rules |

**Export JSON** shares only `session.json`. All rows are exported, independently of the history screen's pagination. No live SQLite files are copied. The files use stable cache names and are replaced by subsequent exports.

From an existing app JSON export on a computer:

```sh
node --experimental-strip-types scripts/export-session.mjs /path/to/session.json /path/to/output-directory
```

Use a Node version supporting TypeScript type stripping (the development environment uses Node 26). The CLI uses the same serializer as the phone. It writes derived files only; it does not contact a server or run probes.

## Sample dictionary

| Columns | Meaning |
| --- | --- |
| `sessionId`, `measurementId`, `measurementType`, `method` | Join keys and measurement method |
| `sampleGroup` | `probe`, `baseline`, or `traceroute`; HTTP baseline/loaded samples are transactions, not individual packets |
| `sequence` | Sample index supplied by our app/library, **not necessarily the ICMP header sequence**. Each Android single-ping process may reset its own header sequence. |
| `measurementScheduledAt`, `measurementTimestamp`, `sampleTimestamp` | Scheduled/start wall-clock timestamps where stored; they are not kernel transmit timestamps |
| `observedAtMs` | Native traceroute callback wall-clock time in Unix milliseconds, when available |
| `targetHost`, `targetPort`, `remote`, `responderAddress` | Configured target, resolved library destination and actual reported responder; unavailable endpoint fields remain blank |
| `hop`, `probeTtl`, `replyTtl` | Outgoing traceroute hop limit versus TTL reported on a reply; never substitute one for the other |
| `rttMs`, `durationMs`, `elapsedUsec` | Library/application RTT, total sample operation duration where recorded, and native microsecond measurement where supplied |
| `outcome`, `errorType`, `errorMessage` | Preserve timeout/error outcomes; a missing reply does not establish an internet outage |
| `icmpType`, `icmpCode`, `errno`, `errorInfo`, `nativeVariant` | Only values exposed by the library; absent original ICMP fields stay blank |
| `probeBytes`, `overheadBytes` | Configured/reported probe size and library-reported overhead; not total carrier traffic |
| `library`, `libraryVersion`, `rawSource` | Collection provenance where recorded |
| `networkSnapshotId` and context columns | Context associated with the parent measurement; a burst's samples share this snapshot rather than implying a fresh RF reading per packet |
| `nativeStatus`, `nativeRttMs`, `nativeReplyTtl`, `rawStdout`, `rawStderr` | Last supplied ping callback values/text, including native failure sentinels; all callbacks remain in raw JSON |
| `replyDataBase64` | Traceroute reply payload bytes where exposed by the native result; not an entire IP packet |
| `rawSampleJson` | Complete stored sample, including unknown future fields |

`measurements.csv` adds reply counts, median/p95, successive RTT differences, sent/duplicate/reordered counts, non-response/loss percentages, destination-reached/hop information and load-transfer bytes/speed. `rawRecordJson` preserves every saved measurement field, including callback arrays and extensions that have no flat column. The full session JSON also preserves all configuration and events.

## What “raw” means here

- **ICMP:** Callback fields (`rtt`, `ttl`, numeric `status`, `isEnded`) are retained verbatim, with application callback time and elapsed duration. The reproducible `ping-react-native+2.1.1.patch` additionally exposes Android command stdout/stderr when available. It reads through blank lines so command summaries are retained. Text line endings are normalized by the reader; this is not byte-for-byte packet capture. Some cancellation/native timeout paths may return no text. The JavaScript deadline cannot recreate native output it never received.
- **Traceroute:** The bridge retains every public field of the pinned `ProbeResult` variant: variant name, sequence, remote, sizes, offender, microsecond elapsed time, reply TTL/data (Base64), error number/type/code/info or error string as applicable. The entire bridge response is saved before validation, including invalid responses. Specialized `HostUnreachable`/`ConnectionRefused` variants lack original ICMP type/code; no values are inferred from their names.
- **UDP:** The raw observation log stores send requests with payload Base64, send confirmations and correlated replies with source endpoint, payload, duplicate/reordered indicators and callback times. Unrelated/nonmatching datagrams are not included. A 256-callback cap bounds duplicate storms and records `droppedCallbacks`; this is explicitly not an unlimited capture. The sample CSV retains every attempted sequence's outcome.
- **TCP:** The connection request and terminal callback outcome are saved. These remain application callback observations, not TCP segment headers or SYN/SYN-ACK timestamps.
- **HTTP and reference SDKs:** Existing measurements, nested latency samples and available reference metrics are preserved. This change does not add HTTP packet capture or a complete raw callback stream for SpeedChecker/NDT7.

Blank CSV fields mean missing/not applicable. Numeric zero and boolean false remain explicit. CSV quoting preserves commas, quotes and multiline text. Potential spreadsheet formulas receive an apostrophe prefix; JSON preserves the original string. A spreadsheet may impose its own cell-size limit, so retain `session.json` even when using the CSVs for analysis.

## Verification status

Automated tests exercise raw callback retention, failure preservation, invalid traceroute responses, CSV round trips with multiline output, zero-versus-missing values, sample grouping and legacy records. Android compilation checks the native bridge and ping patch. A real export reconstructed from the synchronized September 28 session contains 76 measurement rows, 456 diagnostic sample rows (180 ICMP and 72 traceroute samples), 34 events and 14 context observations. Python’s CSV reader verified row structure and the full JSON was compared with its source. These historical records have no retroactive command output.

New physical-device capture and multi-file sharing still require validation on the rebuilt app; an older installed APK cannot provide the new raw fields.

For interpretation and library choices, see [the packet-measurement review](research/packet-measurement-review.md).
