# SkyMeasure combined CSV

To select variables or observations before downloading, use the session dashboard's [filters and selectable columns](dashboard-filters.md). The complete combined export described here remains available separately.

Each row is an individual saved sample, or a standalone measurement when it has no samples. The saved ten-minute experiment produces 246 rows: 232 samples plus 14 standalone measurements. Baseline latency samples and timeouts are included.

- `row.kind`: `sample` or `measurement`.
- `session.id`: owning session's stable identifier.
- `measurement.*`: fields copied from the parent measurement. These repeat for every sample. Count **distinct measurement.id**, never sum repeated parent throughput, bytes, duration, or success values.
- `measurement.networkSnapshot.*`: context associated with the parent. Repetition does not mean a new battery/Wi-Fi reading for each packet.
- `measurement.details.*`: scalar burst summaries computed by the collector.
- `sample.ordinal`: zero-based unique ordinal within the parent measurement, across phases; not an ICMP sequence number.
- `sample.phase`: `probe`, `baseline`, or `hop`. A baseline is an HTTP transaction before a transfer; a hop is one traceroute probe.
- `measurement.details.summary.*` and `measurement.details.baselineSummary.*`: the collector's saved statistics, with the original definitions and units from the dictionary.
- `measurement.load.*`: the embedded HTTP transfer during a loaded-latency test. It is repeated parent data, not another transfer for each latency sample.
- `measurement.route.*`: traceroute completion, hop limit and library provenance.
- `measurement.*` / `sample.*` packet columns (`packetOutcome`, `probeTtl`, `replyTtl`, `responderAddress`, `icmpType`, `icmpCode`, `icmpIdentifier`, `icmpSequence`, `icmpChecksum`, `receivedSocketBytes`, and endpoints) are projected only when provided by that record. The projection is shared in `combinedPacketProjection` in the existing machine-readable dictionary. Byte dumps and kernel-only fields are excluded from these readable rows and stay in JSON.
- Other `sample.*` fields copy that observation, including sequence, hop, RTT in milliseconds, error classifications, and the library-provided address when available.

CSV prefixes disambiguate **measurement.value** (a burst summary, connection time, throughput, or route hop count, depending on measurement.type and measurement.unit) from **sample.rttMs** (an individual observation). A TCP connect duration includes connection establishment as measured by the library; it is not kernel RTT. HTTP RTT measures an HTTP transaction, not pure propagation delay. Throughput in Mbps uses transferred payload bytes × 8 / elapsed milliseconds / 1000. Loss percentage uses (sent − replies) / sent × 100. See the original dictionary for precise sample populations, medians, percentile interpolation, and successive-difference definitions.

Empty cells mean not supplied, not applicable, or unavailable following an unsuccessful probe. Zero is a measured value and is retained. Decimal-string nanosecond timestamps stay strings in JSON/CSV; import them as text in spreadsheet software. Spreadsheet formula prefixes are escaped on export. Raw nested callbacks and payload dumps remain in the separately downloadable JSON, avoiding giant duplicated CSV cells.

Traceroute `kind` labels are the library's classifications. Historical labels such as `port_unreachable` are not independent proof that ICMP type/code was observed. A target address copied into an old library result is not necessarily an observed reply source. UDP timeouts do not prove that react-native-udp cannot measure RTT.

Read the [measurement guide](measurements/guide.md), [column dictionary](measurements/columns.md), and [machine-readable dictionary](measurements/columns.json). Existing wide CSV exports and their definitions remain unchanged. Unknown future scalar fields appear by their raw JSON path; consult the collector version before assigning an interpretation to them. Original JSON preserves all fields, including future nested objects and arrays.
