# custom-one-hour measurement audit

Measurements: **244**; samples: **1342**; context snapshots: **49**; events: **99**.
Duration: 3600.18 seconds. Errors: **0**; warnings: **852**; unavailable checks: **313**.

See [column meanings and types](../columns.md). Full findings and JSON pointers are in the locally generated `sanity-checks.json`; sanitized aggregate counts are in [evidence.json](evidence.json). Source JSON remains authoritative.

| Measurement | Attempts | Successful attempts | Probe samples | Samples with response time |
| --- | ---: | ---: | ---: | ---: |
| http_rtt | 60 | 60 | 0 | 0 |
| icmp_burst | 60 | 60 | 600 | 599 |
| download | 12 | 12 | 0 | 0 |
| upload | 12 | 12 | 0 | 0 |
| tcp_connect | 60 | 60 | 60 | 60 |
| traceroute | 4 | 4 | 126 | 114 |
| udp_echo | 12 | 0 | 240 | 0 |
| loaded_download | 12 | 12 | 64 | 64 |
| loaded_upload | 12 | 12 | 180 | 180 |

## Findings

| Severity | Check | Occurrences | Interpretation |
| --- | --- | ---: | --- |
| unavailable | monotonic_elapsed | 313 | No compatible monotonic send/receive pair; realtime and monotonic clocks are never subtracted. |
| warning | udp_no_replies | 12 | No matching UDP echoes: RTT unavailable; filtering, route or server failure is not evidence of a missing library capability. |
| warning | legacy_size_mapping_gap | 840 | Legacy probeBytes is blank; focused payloadBytes is recovered from packet.payloadBytes. |

## Field availability

Counts are non-null rows, not inferred capabilities. Zero rows means this measurement was not collected. Key fields are shown here; sanity-checks.json contains counts for every column.

| File | Rows | Non-null values for key fields |
| --- | ---: | --- |
| icmp.csv | 600 | rttMs: 599; payloadBytes: 600; responderAddress: 599; icmpType: 599; receivedSocketBytes: 599 |
| tcp.csv | 60 | connectDurationMs: 60; kernelRttMs: 60; congestionWindowSegments: 60 |
| traceroute.csv | 126 | rttMs: 114; responderAddress: 114; icmpType: 114; payloadBytes: 126 |
| udp.csv | 240 | rttMs: 0; payloadBytes: 240; receivedSocketBytes: 0 |
| http.csv | 108 | httpLatencyMs: 84; transferDurationMs: 48; throughputMbps: 48 |
| http-latency-samples.csv | 316 | httpLatencyMs: 316 |

## Interpretation limits

- Availability counts describe retained evidence, not support guarantees. Empty values are never converted to zero.
- HTTP over a USB-forwarded local endpoint does not measure satellite/internet throughput.
- Connect timing, kernel RTT, ICMP RTT and HTTP latency have different scopes.
- No full IP/TCP capture or congestion-window time series during a transfer is collected.
- Single-run evidence cannot establish library/native superiority; use matched conditions for an endurance comparison.
