# Annotated rows from the saved experiments

These are selected numeric observations from the October 7 custom one-hour run and October 8 library smoke run. They are **not synthetic performance results**. IDs and endpoint/network identifiers are omitted; values below are rounded for reading. The private original JSON remains unchanged. Each locally generated focused CSV supplies `recordPath` to find the full source record.

## ICMP: a sample is not the burst summary

| Column / source | Custom first sample | Library first sample | Interpretation |
| --- | ---: | ---: | --- |
| Application `sequence` | 0 | 0 | Position in the burst. |
| `rttMs` | 8.747 | 10.008 | This individual echo response time. |
| Outer sample `durationMs` | 40.495 | 137.797 | Broader call duration, including additional overhead. |
| Payload bytes | 64 | 64 | Same configured echo payload size. |
| Received ICMP bytes | 72 | 72 | Eight-byte ICMP echo header plus payload; outer IP header is absent. |
| Received type/code | 0 / 0 | 0 / 0 | Actual decoded IPv4 echo-reply header. |
| `icmpSequence` | 0 | 1 | Header sequence differs from the app sequence in the library case. |
| Parent burst median | 16.945 ms | 16.103 ms | Summary across ten samples, not this first row. |

The native legacy `probeBytes` cell is blank; `packet.payloadBytes=64` supplies the focused value. The library's actual returned message length is 72, while `raw.request.packetSize=64` names the payload. Neither should be described simply as “packet size” without its scope.

The library record has actual returned ICMP bytes, but its historical responder address is only the configured remote. The analyzer flags and suppresses that address in the focused view. It does not discard the valid received bytes.

## A missing reply is a row, not zero latency

One custom ICMP sample at application sequence 3 has `errorType=timeout` and `rttMs=null`. Its burst and the overall experiment still retain that failed sample. Across the run there were 599 replies from 600 ICMP probes: aggregate non-response was approximately 0.167%.

The library smoke test's UDP burst has twenty sample rows, each with a timeout and blank RTT, plus twenty send-request and twenty send-confirmation callbacks. `sentCount=20`, `lossPercent=100`, and median/p95 are null. A send confirmation means the local operation accepted the send; it does not prove arrival at the echo server. This experiment cannot validate UDP RTT or jitter. It also cannot establish that the library lacks those capabilities.

## Traceroute: read the hop, response and type separately

| Column | Custom first hop probe | Library first hop probe |
| --- | --- | --- |
| `hop` | 1 | 1 |
| `sequence` | 0 | 0 |
| `rttMs` | 15.698 | 2.130 |
| `outcome` | `time_exceeded` | `host_unreachable` |
| `icmpType`, `icmpCode` | 11, 0 | blank, blank |
| `nativeVariant` | blank | `HostUnreachable` |
| Probe payload | 32 bytes | 32 bytes |
| Whole route result | reached at hop 11 | reached at hop 10 |

The native row contains the original IPv4 Time Exceeded code from the error queue. The library row supplies a responder and time but an ambiguous class label; inventing `icmpType=3` from `HostUnreachable` would be wrong. Both rows contribute useful path observations. RTT at hop 1 is a round trip to that responder, not an isolated first-link propagation delay. Do not subtract consecutive-hop RTTs as reliable link latencies.

## TCP: three different durations

The native first connection has **21.047 ms** connection time, **27.551 ms** outer operation duration, and **20.414 ms** kernel smoothed RTT. Its window is **10 segments**, sender MSS is **1,238 bytes**, and total retransmissions are **0**.

The library first connection takes **27.192 ms**, including resolution and callback overhead, and reports local/remote endpoints. Its kernel RTT, congestion window and retransmission fields are blank because the wrapper does not expose `TCP_INFO`. Zero application bytes written/read do not mean the TCP handshake used zero wire bytes. The [TCP appendix](tcp-info.md) explains every retained native kernel field.

## HTTP: use the bytes and duration of the transfer

| Column | Custom first standalone download | Library first standalone download |
| --- | ---: | ---: |
| `transferredBytes` | 52,428,800 | 52,428,800 |
| `transferDurationMs` | 1,618.633 | 1,690.852 |
| `throughputMbps` | 259.126 | 248.059 |

For the custom row: `8 × 52,428,800 / (1,618.632923 × 1000) ≈ 259.126 Mbit/s`. These HTTP transfers used the local USB-forwarded probe service. They are not measurements of Google's download speed or satellite throughput.

The first library loaded download has baseline median **58.855 ms**, during-transfer median **68.108 ms**, and **5** overlapping latency samples. Its embedded transfer took **1,622.022 ms** at **258.585 Mbit/s**. The outer loaded operation took **1,802.431 ms**. Using that outer duration to recompute transfer throughput would mix different timing scopes.
