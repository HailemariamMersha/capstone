# library-smoke measurement audit

Measurements: **12**; samples: **99**; context snapshots: **3**; events: **13**.
Duration: 120.184 seconds. Errors: **0**; warnings: **48**; unavailable checks: **22**.

See [column meanings and types](../columns.md). Full findings and JSON pointers are in the locally generated `sanity-checks.json`; sanitized aggregate counts are in [evidence.json](evidence.json). Source JSON remains authoritative.

| Measurement | Attempts | Successful attempts | Probe samples | Samples with response time |
| --- | ---: | ---: | ---: | ---: |
| http_rtt | 2 | 2 | 0 | 0 |
| icmp_burst | 2 | 2 | 20 | 20 |
| download | 1 | 1 | 0 | 0 |
| upload | 1 | 1 | 0 | 0 |
| tcp_connect | 2 | 2 | 2 | 2 |
| traceroute | 1 | 1 | 30 | 27 |
| udp_echo | 1 | 0 | 20 | 0 |
| loaded_download | 1 | 1 | 5 | 5 |
| loaded_upload | 1 | 1 | 16 | 16 |

## Findings

| Severity | Check | Occurrences | Interpretation |
| --- | --- | ---: | --- |
| unavailable | monotonic_elapsed | 20 | No compatible monotonic send/receive pair; realtime and monotonic clocks are never subtracted. |
| warning | historical_target_alias | 20 | Historical ICMP library responderAddress repeats configured remote; focused responder is blank because actual source was not exposed. |
| warning | ambiguous_trace_label | 27 | Library error class does not establish original ICMP type/code; retain classification without inferring it. |
| warning | udp_no_replies | 1 | No matching UDP echoes: RTT unavailable; filtering, route or server failure is not evidence of a missing library capability. |
| unavailable | kernel_tcp_info | 2 | No handset TCP_INFO on this record; callback connect time cannot replace kernel RTT. |

## Field availability

Counts are non-null rows, not inferred capabilities. Zero rows means this measurement was not collected. Key fields are shown here; sanity-checks.json contains counts for every column.

| File | Rows | Non-null values for key fields |
| --- | ---: | --- |
| icmp.csv | 20 | rttMs: 20; payloadBytes: 20; responderAddress: 0; icmpType: 20; receivedSocketBytes: 20 |
| tcp.csv | 2 | connectDurationMs: 2; kernelRttMs: 0; congestionWindowSegments: 0 |
| traceroute.csv | 30 | rttMs: 27; responderAddress: 27; icmpType: 0; payloadBytes: 30 |
| udp.csv | 20 | rttMs: 0; payloadBytes: 20; receivedSocketBytes: 0 |
| http.csv | 6 | httpLatencyMs: 4; transferDurationMs: 4; throughputMbps: 4 |
| http-latency-samples.csv | 27 | httpLatencyMs: 27 |

## Interpretation limits

- Availability counts describe retained evidence, not support guarantees. Empty values are never converted to zero.
- HTTP over a USB-forwarded local endpoint does not measure satellite/internet throughput.
- Connect timing, kernel RTT, ICMP RTT and HTTP latency have different scopes.
- No full IP/TCP capture or congestion-window time series during a transfer is collected.
- Single-run evidence cannot establish library/native superiority; use matched conditions for an endurance comparison.
