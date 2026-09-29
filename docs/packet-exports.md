# Probe-level exports

Export format **3** keeps the saved JSON as the source of truth and supplies convenient CSV projections. This does not change the SQLite schema: optional raw fields live inside existing measurement JSON. Old sessions still export; missing historical values are not backfilled from current library versions or invented.

## Files

Use **Export CSV** on a saved session to share all seven files together:

| File | Granularity / contents |
| --- | --- |
| `session.json` | Complete saved session/configuration, measurements, events and context, plus `exportFormatVersion: 3` |
| `measurements.csv` | One row per attempt, including failures; flat summaries, context, embedded load-transfer values and the complete `rawRecordJson` |
| `samples.csv` | One row per stored diagnostic sample, baseline HTTP sample or traceroute probe; includes missing replies and errors |
| `packets.jsonl` | One full native packet-probe object per line, with session/measurement/sequence/hop keys; historical records without packet fields produce no lines |
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
| `sampleGroup` | `probe`, `baseline`, `traceroute`, or `reference_callback`; HTTP baseline/loaded samples are transactions, not individual packets |
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

New Android sessions use the [native packet engine](packet-engine.md). The complete object returned by the adapter is stored in `packet`, without discarding unknown fields. Each burst/trace sample has its own object. `packets.jsonl` keeps observations and ancillary messages nested under their probe, including timeouts and errors. `session.json` remains authoritative for the entire session.

- **ICMP:** Received ICMP message bytes, actual header type/code/checksum/identifier/sequence, payload, endpoint, TTL/hop-limit and timestamps where supplied. The send buffer precedes the kernel's identifier/checksum updates; it is explicitly labelled, not represented as captured wire bytes.
- **Traceroute:** Original `sock_extended_err` errno/origin/type/code/info/data and offender, socket-associated quoted payload, TTL and timing. Only origins ICMP/ICMP6 populate ICMP fields. Intermediate Time Exceeded differs from Destination Unreachable. This is UDP traceroute, not Paris traceroute.
- **UDP:** Exact send/received application payload hex and raw normal/error-queue observations. New native probes are sequential and do not estimate burst reordering/duplicates. Socket data omits outer IP/UDP headers.
- **TCP:** Native connect duration plus before/after `TCP_INFO` including the returned struct bytes and supported parsed fields. Kernel smoothed RTT is distinct from connect duration. No TCP segments are captured.
- **Reference tests:** NDT7 worker callbacks retain the original server message (including server-side TCP telemetry when provided); SpeedChecker listener callbacks retain primitive arguments and selected final public result fields. These are SDK observations, not handset packet captures or undocumented SDK internals. Each log is bounded to 256 callbacks and 262,144 serialized characters per direction/run, with `droppedCallbacks` reported.
- **Historical/fallback results:** Prior shell-ping stdout/stderr, icmpenguin variants and JavaScript UDP/TCP callback logs remain exportable. Their missing packet fields stay blank; new captures cannot reconstruct old records.

Additional packet columns include `packetOutcome`, `ipVersion`, local/remote endpoints, `icmpIdentifier`, `icmpSequence`, `icmpChecksum`, `socketErrno`, `errorOrigin`, raw buffer scopes/hex, received flags, `tcpKernelRttUs`, retransmissions, congestion window and `packetRawJson`. Nanosecond timestamps are decimal strings: import them as **text** in spreadsheets to avoid precision loss. Monotonic timestamps and kernel realtime timestamps use different clocks and must not be subtracted from each other. Buffers and ancillary data have explicit truncation indicators; excess observations have `droppedObservations`.

Blank CSV fields mean missing/not applicable. Numeric zero and boolean false remain explicit. CSV quoting preserves commas, quotes and multiline text. Potential spreadsheet formulas receive an apostrophe prefix; JSON preserves the original string. A spreadsheet may impose its own cell-size limit, so retain `session.json` even when using the CSVs for analysis.

## Verification status

Automated tests exercise raw callback retention, failure preservation, invalid traceroute responses, CSV round trips with multiline output, zero-versus-missing values, sample grouping and legacy records. Android compilation checks the native bridge and ping patch. A real export reconstructed from the synchronized September 28 session contains 76 measurement rows, 456 diagnostic sample rows (180 ICMP and 72 traceroute samples), 34 events and 14 context observations. Python’s CSV reader verified row structure and the full JSON was compared with its source. These historical records have no retroactive command output.

Seven real loopback native tests pass on the Android 16/API 36.1 emulator, including IPv4/IPv6 ICMP and error queues, UDP echo/timeout, TCP_INFO, cancellation and bridge cleanup. New physical-device packet collection and multi-file sharing still require validation on the rebuilt app; an older installed APK cannot provide the new raw fields.

For interpretation and library choices, see [the packet-measurement review](research/packet-measurement-review.md).
