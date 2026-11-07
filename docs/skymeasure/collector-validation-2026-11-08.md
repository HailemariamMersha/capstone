# Collector reliability validation — 8 November 2026

These are ground diagnostics on a Samsung Galaxy A34 (SM-A346E), Android 13.
Unrestricted battery access was left enabled for the pilot app only after the
second check; collection was stopped. These tests do not validate flight
detection, GEO connectivity, all Android power
states or performance on other devices. M-Lab was explicitly disabled in the
researcher shadow controls; no M-Lab result was published by these tests.

## Automated checks

The app's complete regression suite passed 265 tests across 37 suites after the
collector changes. A focused regression specifically exercises pipelined UDP with
600 ms simulated RTT: three packets are sent before the first echo can arrive,
and all twenty replies complete in 5.35 seconds. This is a deterministic socket
simulation, not a shaped physical network.

TypeScript passed. The backend suite passed 44 tests, with one optional
PostgreSQL policy check skipped locally. Read-only hosted PostgreSQL checks
confirmed the historical trip summary remained unchanged. All sixteen
browser checks passed, including flagged headline exclusions, retained original
samples, dynamic trip summaries, exports and narrow layouts. Android
release and instrumentation builds passed; the build script inspected the
packaged public configuration.

## Forced-idle check, battery optimization enabled

The first phone run used pilot 1.1.4 from source `84a37ba`. It lasted 376.975
seconds, with M-Lab disabled, and recorded 23 successful measurement jobs.

| Method | Retained evidence |
|---|---|
| ICMP | 7 bursts; 70/70 replies; pooled median 22.548 ms |
| UDP | 7 bursts; 139/140 replies; pooled median 279.864 ms |
| TCP | 6/6 connections; median 30.388 ms |
| Traceroute | 1/1 library-reported destination reached |
| Controlled download | 5,000,000 bytes; 20.240 s; 1.976 Mbps |
| Controlled upload | 1,000,000 bytes; 2.866 s; 2.791 Mbps |

The detector produced 25 evaluations and heartbeats, including 14 heartbeats
with device-idle true, screen noninteractive and battery exemption false. ASN
context was available in all 48 saved snapshots. Segment health matched the
saved job counts and recorded no skipped jobs or control gaps. All attempt
timing-validity flags were true. The offline analyzer found zero errors and
28 previously documented traceroute-label warnings.

Two forced-idle episodes included one approximately 159-second interval. Android
reported idle, but the CPU/control loop continued while USB remained attached;
the difference between elapsed-realtime and uptime did not show a new deep-sleep
interval. Consequently this did **not** reproduce the historical suspension or
physically validate `collector_gap` after deep sleep. Power-test overrides were
restored after the check.

The maximum invocation lateness was 29.057 seconds for the upload direction,
which shares the pair's planned slot with its preceding download. ICMP's maximum
was 18.668 seconds while measurements were serialized around the download.
Phase preservation and one-second eligibility tolerance do not guarantee
one-second invocation jitter during another running job. Both planned and actual
times remain in the records.

Post-stop upload was intentionally interrupted by diagnostic instrumentation.
The initial server audit correctly showed a partial session: 150/161 records,
11 missing versions, not complete. This is a pending upload, not missing local
evidence. The final retry audit confirmed 161/161 records, no missing versions
and the trip marked upload-complete.

## HTTP endpoint baseline

A 5,000,000-byte request to the API from the server's own loopback interface
completed in about 14.33 ms (2,791 Mbps application rate). A separate Mac-to-public
API request took 16.208 seconds (2.47 Mbps); the phone's download above took
20.240 seconds (1.98 Mbps). The public responses were uncompressed. These are
different paths and conditions, not a capacity comparison. They do not support a
fixed 1.4 Mbps application-server cap, nor identify the public-path bottleneck.
No shared-server network settings were changed. Further path/load diagnosis is
separate from recording partial progress and choosing a tolerable deadline.

## Fifteen-minute rotation check

The second run used the final pilot from source `30bef39`, with M-Lab disabled,
unrestricted battery access for this app, screen locked and USB attached. It
lasted 1,019.946 seconds (17 minutes), including a 21.358-second upload pause,
and produced two ordered segments in one trip: 48 and 7 measurement jobs.

| Method | Combined retained evidence |
|---|---|
| ICMP | 17 bursts; 170/170 replies |
| UDP | 17 bursts; 339/340 replies |
| TCP | 17/17 connections |
| Traceroute | 2/2 library-reported destination reached |
| Controlled download | 5,000,000 bytes; 11.180 s; 3.578 Mbps |
| Controlled upload | 1,000,000 bytes; 4.478 s; 1.786 Mbps |

All 55 measurement jobs succeeded; one missing UDP reply remains an individual
non-response. Both segment health records matched their saved job counts, with
zero skipped jobs, zero control gaps and zero timing exclusions. The 52 control
heartbeats continued across the boundary; within-segment maximum heartbeat
interval was 30.027 seconds (31.357 seconds across the segment boundary). All 107 context snapshots had ASN values. Snapshot
counts include repeated measurement context, not 107 fresh identity lookups.
The offline analyzers found zero errors, with 28 and 29 known ambiguous
traceroute-label warnings respectively.

The first segment closed 178 ms after its planned upload boundary. The measured
pause lasted 21.358 seconds, within the nominal 25-second limit, and collection
resumed automatically. The second segment retained the same trip ID. Transfer
reservation stayed 6,000,000 bytes across the boundary; diagnostics increased
from 130,560 to 151,296 bytes, and live upload reservations reached 374,338 bytes.
All 55 measurement identifiers were distinct. No probe execution overlapped
the recorded upload pause. Planned ICMP, UDP and TCP slots remained exactly
60,000 ms apart across rotation; traceroute slots remained 900,000 ms apart.
No transfer pair or observations were duplicated at rotation. The largest
second-segment start delay was 19.601 seconds after the upload pause, explicitly
retained as scheduling evidence rather than RTT.

### Upload throughput finding and fix

The first upload opportunity acknowledged one 50-record batch: 154,171 request
bytes took 12.743 seconds. It correctly left the session partial and resumed
collection instead of extending the pause. This exposed per-record database
lookups and autoflushes in ingestion. Source `420ecd0` preloads existing rows
with one bounded query and flushes new records/samples together, retaining the
session lock, exact version checks, atomic rejection and idempotent retries.
A 50-record regression requires one record lookup and at most one record-insert
statement; duplicate retries reconcile without adding records. All 44 backend
tests pass, with one optional PostgreSQL-only policy test skipped locally.
The isolated API deployment preserves the previous release for rollback and
does not restart UDP or alter unrelated services. Source `58e6bff` also batches
session-page totals into one grouped query, retaining pagination and ownership.
The new regression checks page order, zero and failure counts, one aggregate
query and account isolation. This removes the identified round trips; it is not
a general public-path throughput benchmark.

The final read-only hosted audit found **355/355 expected records** across the
two segments (304 and 51), zero missing versions and `uploadComplete=true`, with
no missing segments. Server aggregates matched all 55 local measurements and
the pooled probe counts above. The earlier interrupted 161-record diagnostic
also fully reconciled. Completion required retries after the initial short
window; the first live window did not upload the whole segment. The final API
release is `collector-lists-20261108-58e6bff`, with the prior releases retained
for rollback. An initial deployment health check used the wrong local port and
restored the previous release; the corrected check uses the service's verified
port 18000.

## Artifact and remaining validation

The final ARM64 pilot is version 1.1.4, code 6, from clean source `30bef39`.
Its SHA-256 is
`6bc6be7a4da3f036f279a76c0a28653fd19c4ac73083a81f44e49b080979322d`.
It is signed with the development key for private sharing. Original exports and
APK artifacts remain in ignored local `build/` paths; this document contains
aggregate evidence only.

Still required: a genuinely unplugged one-hour endurance run, a dedicated
600 ms delay/loss gateway, connectivity restoration, Recents/process termination
and reboot checks for this collector version, other OEM devices and real flights.
Do not apply traffic shaping to the shared lab host. Existing older lifecycle
tests do not establish this build's endurance.

See [collector-reliability.md](collector-reliability.md) for policies, formulas,
clock domains, buffered control evidence and missing-value interpretation.
