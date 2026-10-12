> **Current library-only CSVs (format 4):** CSV columns cover library observations, TypeScript summaries and application/context metadata. Custom socket timestamps, send buffers, Linux error-queue fields and handset TCP_INFO columns are omitted. Raw JSON still preserves saved records, including historical native sessions.

# Probe-level exports

Export format **4** keeps the saved JSON as the source of truth and supplies convenient CSV projections. This does not change the SQLite schema: optional raw fields live inside existing measurement JSON. Old sessions still export; missing historical values are not backfilled from current library versions or invented.

## Files

Use **Export CSV** on a saved session to share all eight files together:

| File | Granularity / contents |
| --- | --- |
| `session.json` | Complete saved session/configuration, measurements, events and context, plus `exportFormatVersion: 4` |
| `measurements.csv` | One row per attempt, including failures; flat summaries, context, embedded load-transfer values and the complete `rawRecordJson` |
| `samples.csv` | One row per stored diagnostic sample, baseline HTTP sample or traceroute probe; includes missing replies and errors |
| `packets.jsonl` | One retained library/native packet-probe object per line, with session/measurement/sequence/hop keys; historical records without packet fields produce no lines |
| `library-callbacks.jsonl` | Retained library requests and callbacks, unavailable declarations and dropped counts; not one line per network packet |
| `events.csv` | Session lifecycle, schedule gaps, failures and other saved events, including details/raw JSON |
| `network-context.csv` | Context observations, their IDs/timestamps, connectivity, Wi-Fi and battery fields, plus full raw JSON |
| `README.txt` | Units, missing-value and interpretation rules |

**Export JSON** shares only `session.json`. All rows are exported, independently of the history screen's pagination. No live SQLite files are copied. The files use stable cache names and are replaced by subsequent exports.

From an existing app JSON export on a computer:

```sh
node --experimental-strip-types scripts/export-session.mjs /path/to/session.json /path/to/output-directory
```

Use a Node version supporting TypeScript type stripping (the development environment uses Node 26). The CLI uses the same serializer as the phone. It writes derived files only; it does not contact a server or run probes.

## Complete dictionary and readable analysis

Start with the [measurement guide](measurements/guide.md), [every-column dictionary](measurements/columns.md), [annotated rows](measurements/examples.md), and [library/native requirements audit](measurements/comparison.md). The Mac analysis command produces six focused CSVs and sanity-check reports using the same library-focused column policy as the phone export.

```sh
npm run measurements:analyze -- --input /path/to/session.json --out /path/to/new-analysis-directory
```

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

## Current CSV scope and raw evidence

`measurements.csv` has **70 columns** and `samples.csv` has **64**. These include provenance, outcomes, summary statistics, context, and library-accessible received ICMP bytes/headers. Columns containing `native` in their name (for example `nativeVariant`) refer to a library's platform result, not our custom socket engine, and remain useful.

The following 14 custom-only columns were removed from both wide CSVs:

- `sendMonotonicNs`, `receiveMonotonicNs`, `kernelReceiveRealtimeNs`
- `sentSocketBytes`, `sendBufferScope`, `sendBufferHex`
- `socketErrno`, `errorOrigin`, `errorData`, `recvmsgFlags`
- `tcpKernelRttUs`, `tcpRttVarianceUs`, `tcpTotalRetransmissions`, `tcpCongestionWindowSegments`

Focused `tcp.csv` also omits kernel RTT, variation, retransmissions, congestion window and MSS columns. Focused `udp.csv` omits the custom send-syscall byte counter. This changes CSV headers, hence format 4. Consumers must use headers rather than column positions. Existing saved sessions are not migrated or deleted.

- **ICMP:** icmpenguin supplies received echo-message bytes and TTL/RTT; TypeScript decodes the actual ICMP header. Burst evidence is in individual samples rather than the parent row. The current library does not provide the observed reply source or full outer IP headers.
- **Traceroute:** retains per-hop library outcomes, responders and timings. Its original ICMP error type/code are not reliably exposed; ambiguous result labels remain explicit.
- **TCP:** retains connection callback timing, endpoints and application counters in raw callbacks. It supplies no handset TCP_INFO or TCP packet capture.
- **UDP:** retains sent/received application payloads, sender metadata and matching/reordering evidence in callbacks. These are datagram payloads, not full IP/UDP headers or native syscall buffers.
- **HTTP:** application transaction timing and transfer counts; no TCP kernel statistics.
- **Reference tests:** optional NDT7/SpeedChecker result fields remain available when those integrations are enabled and run. Their blank cells do not imply a custom-native requirement.

`session.json`, `packets.jsonl`, `library-callbacks.jsonl` and raw JSON cells preserve original saved evidence. Historical custom-engine records may still contain native fields inside JSON; removing CSV columns does not destroy that evidence. See the [archived engine description](packet-engine.md) and [TCP_INFO appendix](measurements/tcp-info.md) only when interpreting those older records. Current library runs do not collect those kernel values.

Blank CSV fields mean missing/not applicable. Numeric zero and boolean false remain explicit. CSV quoting preserves commas, quotes and multiline text. Potential spreadsheet formulas receive an apostrophe prefix; JSON preserves the original string. A spreadsheet may impose its own cell-size limit, so retain `session.json` even when using the CSVs for analysis.

## Verification status

Automated tests exercise raw callback retention, failure preservation, invalid traceroute responses, CSV round trips with multiline output, zero-versus-missing values, sample grouping and legacy records. Android compilation checks the native bridge and ping patch. A real export reconstructed from the synchronized September 28 session contains 76 measurement rows, 456 diagnostic sample rows (180 ICMP and 72 traceroute samples), 34 events and 14 context observations. Python’s CSV reader verified row structure and the full JSON was compared with its source. These historical records have no retroactive command output.

Seven real loopback native tests pass on the Android 16/API 36.1 emulator, including IPv4/IPv6 ICMP and error queues, UDP echo/timeout, TCP_INFO, cancellation and bridge cleanup. Physical-device packet collection was subsequently exercised in the [custom one-hour run](experiments/2026-10-07-custom-engine-one-hour.md) and [library smoke run](experiments/2026-10-08-library-smoke.md). Their different durations/methods do not establish comparative reliability.

For interpretation and library choices, see [the packet-measurement review](research/packet-measurement-review.md).
