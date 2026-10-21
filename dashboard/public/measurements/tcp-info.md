# Reading the native TCP_INFO snapshots

This appendix describes the **custom-engine baseline**, not the current TCP socket library's output. The custom engine calls `getsockopt(TCP_INFO)` on its own short-lived TCP probe socket before and after connection completion. `tcpInfoBefore` and `tcpInfoAfter` are objects inside `packet`. The wide CSV flattens only selected **after** fields. No snapshot here describes the HTTP download socket.

The bridge exports only fields that fit in the returned struct length. Missing means unavailable; zero is a recorded kernel value, although a zero RTT before connection may mean no estimate exists yet. JSON represents the following integer fields as numbers. Kernel state enums and bitmasks require Linux definitions, not numerical averaging.

## State and timers

These are kernel socket state variables, not application packet observations. Field widths and enum definitions are in the [Linux TCP UAPI](https://github.com/torvalds/linux/blob/v6.6/include/uapi/linux/tcp.h); retransmit/backoff/probe variables are described in [inet_connection_sock](https://github.com/torvalds/linux/blob/v6.6/include/net/inet_connection_sock.h).

| Field | Datatype / units | Interpretation |
| --- | --- | --- |
| `tcpi_state` | uint8 enum | TCP state; e.g. 1 established, 2 SYN-sent. |
| `tcpi_ca_state` | uint8 enum | Congestion-control state: 0 open, 1 disorder, 2 CWR, 3 recovery, 4 loss. |
| `tcpi_retransmits` | uint8 count | Current retransmission retry count; not lifetime retransmitted segments. |
| `tcpi_probes` | uint8 count | Unanswered keepalive/window probes. |
| `tcpi_backoff` | uint8 exponent | Retransmission timeout backoff state. |
| `tcpi_options` | uint8 bitmask | Negotiated TCP features; decode with `TCPI_OPT_*`. Not the option bytes themselves. |
| `tcpi_rto` | uint32 microseconds | Current retransmission timeout. |
| `tcpi_ato` | uint32 microseconds | Delayed-ACK timeout estimate. |

## Sizes, counts and windows

Interpretations follow the [Linux TCP socket structure](https://github.com/torvalds/linux/blob/v6.6/include/linux/tcp.h). These describe the sender's state, not a captured sequence of segments. A field retained for ABI compatibility may have little meaning on a particular kernel.

| Field | Datatype / units | Interpretation |
| --- | --- | --- |
| `tcpi_snd_mss` | uint32 bytes | Current sender maximum segment payload size. |
| `tcpi_rcv_mss` | uint32 bytes | Receiver's observed/estimated segment size. |
| `tcpi_unacked` | uint32 segments | Outstanding unacknowledged segments. |
| `tcpi_sacked` | uint32 segments | Selectively acknowledged outstanding segments. |
| `tcpi_lost` | uint32 segments | Outstanding segments marked lost. |
| `tcpi_retrans` | uint32 segments | Retransmitted segments currently outstanding. |
| `tcpi_fackets` | uint32 segments | Legacy forward-ACK accounting; kernel dependent/obsolete. |
| `tcpi_pmtu` | uint32 bytes | Cached path MTU; includes IP-level overhead. |
| `tcpi_snd_ssthresh` | uint32 segments | Slow-start threshold; very large values can represent an effectively unlimited threshold. |
| `tcpi_snd_cwnd` | uint32 segments | Sender congestion window at this instant. |
| `tcpi_advmss` | uint32 bytes | MSS advertised by the local endpoint. |
| `tcpi_reordering` | uint32 segments | Kernel reordering tolerance/estimate; not a measured count of reordered datagrams. |
| `tcpi_rcv_space` | uint32 bytes | Receive-space estimate used for receive-buffer tuning; not the peer's current advertised window. |
| `tcpi_total_retrans` | uint32 segments | Cumulative retransmitted segments on this socket. |

## RTT estimates

The [Linux `tcp_get_info` implementation](https://kernel.googlesource.com/pub/scm/linux/kernel/git/torvalds/linux/+/906dde0f355bd97c080c215811ae7db1137c4af8/net/ipv4/tcp.c) converts internal scaled estimators to microseconds. This is a source reference for semantics, not identification of the phone's exact kernel build. ABI decoding must follow the recorded device/kernel if additional raw struct fields are studied.

| Field | Datatype / units | Interpretation |
| --- | --- | --- |
| `tcpi_rtt` | uint32 microseconds | Smoothed RTT, exported from `srtt_us >> 3`. |
| `tcpi_rttvar` | uint32 microseconds | RTT variation estimate from `mdev_us >> 2`; **not variance in microseconds squared**. |
| `tcpi_rcv_rtt` | uint32 microseconds | Receive-side RTT estimate; can be zero when unavailable/uninitialized. |

The historical flat name `tcpRttVarianceUs` is retained for compatibility. The focused CSV calls its converted value `kernelRttVariationMs`.

## Serialization fields

These fields are produced by our baseline engine, not TCP network headers:

| Field | Datatype / units | Interpretation |
| --- | --- | --- |
| `returnedBytes` | nonnegative integer, bytes | Length returned by `getsockopt`; controls which parsed fields are safe to read. |
| `structHex` | hexadecimal string | Returned native struct bytes, bounded by our compiled struct size. ABI layout/endianness dependent; not a TCP packet. |
| `errno` | integer OS code | Present on a failed `getsockopt` instead of a usable snapshot. |

## Worked native example

The first saved custom TCP attempt reports:

| Quantity | Recorded value | Meaning |
| --- | ---: | --- |
| Native connection duration | 21.047 ms | Timed socket connection operation, excluding DNS. |
| Outer measurement duration | 27.551 ms | Broader application/adapter operation. |
| `tcpi_rtt` | 20,414 µs | Kernel RTT estimate = **20.414 ms**. |
| `tcpi_rttvar` | 10,207 µs | Kernel variation estimate = **10.207 ms**. |
| `tcpi_snd_cwnd` | 10 segments | Sender's current window. |
| `tcpi_snd_mss` | 1,238 bytes | Current sender MSS. |
| Derived window estimate | 12,380 bytes | `10 × 1,238`; not bytes actually in flight. |
| `tcpi_total_retrans` | 0 | No recorded retransmitted segments on this short connection. |

All 60 saved native connections had a 10-segment window and zero total retransmissions. This does not establish that an actual download experienced no congestion or loss. To study congestion dynamics, a future collector would need repeated telemetry on the **same socket carrying the load**, with timestamps, counters and transfer progress. Neither tested implementation currently supplies that experiment. A peer-advertised receive window, packet ACK/SACK evolution, and full TCP option/header sequences are also absent from the parsed dataset.
