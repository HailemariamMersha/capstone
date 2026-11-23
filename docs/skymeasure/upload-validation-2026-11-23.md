# Delivery and boundary validation — 23 November 2026

## Scope

Pilot 1.2.6 (version code 14) uses `flight-pilot-delivery-2026-11-23`
and `collector-scheduler-2026-11-23`. It keeps one foreground service across
collection and post-Stop uploading, uses compressed bounded batches and durable
registration acknowledgements, and separates application interruptions from
measurement failures. Historical policies and original evidence remain intact.

This is a ground-network engineering check on a USB-connected Samsung Galaxy
A34 (Android 13 / API 33). The private AS5384 entry qualifies through the normal
ASN detector and marks the trip as ground-test data. It is not flight validation,
an unplugged endurance result or an Android 15 timeout test. Original phone and
server records remain in ignored private validation storage; only aggregate
observations are recorded here.

## Automated checks

At this checkpoint:

| Check | Result |
|---|---|
| Mobile Jest | 355 tests across 43 suites passed |
| Backend, isolated SQLite | 70 passed; one optional PostgreSQL integration check skipped |
| Dashboard browser tests | 23 passed |
| Baseline scheduler/reference suite | 26 passed, including 14-hour and 24-hour virtual schedules |
| Android NDT7 unit tests | Eight passed |
| Root and dashboard TypeScript | Passed |
| ESLint | No errors; existing/style warnings remain |
| Reproducible library patches | `patch-package --error-on-fail` passed |
| Configured Android release + diagnostics APKs | Built successfully |

Regression coverage includes immutable manifests, accepted-revision recovery,
partial and late acknowledgements, owner/environment cache isolation, 200-record
and decoded-byte targeting, gzip integrity and decoder limits, response-byte
settlement, uncertain dispatch accounting, orphan reservations, service-generation
races, native expiration, ten-minute stalls, retry cooldown, 180-second passes,
25-second live deadlines, light-job grace, heavy-job cancellation, interruption
filters/exports and historical-policy compatibility.

Virtual schedules use simulated clocks and transports. Their success establishes
scheduling invariants, not real Android execution or satellite accuracy.

## Payload sizing on the saved one-hour export

Run without modifying the original private file:

```sh
npm run uploads:size -- --input /path/to/private-trip-export.json
```

The four full segments contain 308–364 records. Their serialized record bodies
are approximately 0.94–0.98 MB decoded and 0.110–0.122 MB gzip-compressed at level
1. Both the 200-record ceiling and 512 KiB decoded target still apply, so each
full segment needs **two record requests**, rather than assuming one 200-record
request fits every segment. With a changed trip PUT, one session manifest and one
completion, this is five requests per full segment. Already accepted manifests
are omitted from later opportunities.

Repeating the largest accounted full segment yields 8,734,600 bytes over fourteen
hours and 14,973,600 bytes over twenty-four hours, within the unchanged 20 MiB
live-upload allocation **without retries**. The model includes known JSON
acknowledgement bodies and a legitimate changed trip update per window. It uses
record version 1 where exports do not expose queue versions and takes the worst
of three record orderings. It excludes authentication, request headers,
TLS/TCP overhead, retransmissions and uncertain-response reservations. It is not
a bandwidth bill or an upload-speed measurement.

## Physical short checks and faults found

The first 34.664-second monitoring check closed with zero measurements and
thirteen session/context/event records. Its foreground service remained alive
after Stop, but compressed manifests returned HTTP 400. Inspection of the
installed React Native source showed that `NetworkingModule.extractHeaders`
removes `Content-Encoding` from ArrayBuffer bodies. The corrected client retains
exact compressed bytes and also sends `X-SkyMeasure-Content-Encoding: gzip`;
the API processes that negotiated alias through its same strict gzip decoder.
A regression test covers the stripped-standard-header case, malformed/oversized
bodies and conflicting labels. The first check's thirteen records later
reconciled completely, after retry backoff and the correction; its delayed
completion is not a representative performance result.

The stalled service was released and then recreated by the visible-app retry
scheduler. The corrected drain persists at least a fifteen-minute retry delay
after a no-progress cutoff, preventing immediate repeated stalled services.
Explicit cancellation, OS expiration and a new Start preserve the queue. The
ten-minute cutoff and persisted cooldown are also tested with fake timers.

A fresh 13.959-second monitoring check closed at **17:44:48.663 UTC**. Its single
segment reconciled **10/10 records** at **17:44:57.662 UTC**, approximately **9.0
seconds after Stop**, and the foreground service was absent at 17:45:04.746 UTC.
No measurement or M-Lab test was scheduled during this short check. The screen
was locked after completion, so this observation alone does not establish a
screen-locked upload; that is part of the extended check below.

## Extended ground check

An approximately eighty-minute normal-detector run is in progress. The screen
was locked after arming. Its first segment reconciled **308/308 records** at
18:07:45.304 UTC, 21.778 seconds after the scheduled boundary. It contains 48
measurements, including successful packet probes and both controlled transfers.
Final measurements, live-window timings, reconciliation, service shutdown and
exact queue-version comparisons will be added after Stop.
No success is inferred from a running notification or an unclosed trip.

## Deployment checks and limits

Only the isolated SkyMeasure API release/service was changed. The UDP service,
unrelated lab applications and DigitalOcean rollback host were left untouched.
The region remains `lab-location-unconfirmed`. An incomplete release failed
startup and was rolled back. Runtime verification also found the missing public
database CA certificate in a source archive; restoring the tracked certificate
re-established verified database access. Source-only release checks must include
the export dictionary and public CA, an application import, a protected database
read, capability headers and HTTPS health. A basic health endpoint is insufficient
to establish database readiness.

No database migration or private credential change was required. Authentication
continues verifying each token with a reusable HTTP connection pool. Rejected
and accepted gzip requests retain the same ownership and consent checks.
The API's compact receipt and original JSON remain the evidence for successful
delivery; a request response or participant notification alone is insufficient.

Android 15+ expiration/quota behavior, force-stop/reboot recovery on the final
APK, unplugged endurance, loss/delay gateway tests and actual flights require
separate physical validation. Android force-stop prevents retries until the app
is reopened. The checked native expiration callback is not evidence that every
OS/OEM permits indefinite background collection or uploading.
