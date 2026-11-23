# Delivery and boundary validation — 23–24 November 2026

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
| Mobile Jest | 364 tests across 43 suites passed |
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

Follow-up lifecycle checks cover process-owned drain registration, Wi-Fi
preference enforcement after screen teardown, progress from coalesced callers,
and slow unsuccessful passes that must not extend the no-progress deadline.

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

## Extended ground check: received-data checkpoint

The normal-detector run started at **17:52:23.526 UTC on 23 November**. The
intended eighty-minute check continued during a tooling interruption; it must
not be described as a completed eighty-minute experiment. A repeatable-read
server snapshot at **22:38:36.790 UTC** contains **nineteen closed segments,
5,686 records and 875 parent measurements**, covering about four hours and
forty-five minutes of closed collection intervals. Every received segment's
`(type, id, version)` set exactly matches its immutable manifest: **zero missing
or unexpected versions**. The trip's last reported state is still active.
This establishes segment reconciliation, not final trip completion or a match
to a fresh local queue export.

The screen was locked after arming. After removing only SkyMeasure from Recents
at approximately 18:17:59 UTC, the same process and foreground service remained
alive. Subsequent segments continued to arrive. The nineteen segment health
records report **zero collector gaps**. Three `busy_deadline` events each account
for three skipped deadlines, one event each for ICMP, UDP and TCP. Maximum
reported scheduling lateness is **37,837 ms**; zero gap events does not imply
perfectly periodic measurements.

| Measurement | Recorded result in the closed segments |
|---|---|
| ICMP | 282 bursts; 2,755/2,820 echo probes replied; 65 timeouts |
| UDP | 281 bursts; 5,501/5,620 echo probes replied; 119 timeouts |
| TCP | 281/281 connection attempts succeeded |
| Traceroute | 19/19 reported destination reached, subject to the library's qualified hop labels |
| Fixed-size download | 5/5 completed; 500,000 bytes each; 4.67–13.50 s |
| Fixed-size upload | 5/5 completed; 1,000,000 bytes each; 2.51–7.33 s |
| M-Lab | One download and one upload parent blocked by the existing daily quota; no valid speed result |

A successful burst parent does not mean every constituent probe replied. Both
M-Lab parents carry the existing generic `network` error label, but their
`reference_unavailable` event says **QUOTA**. The rolling four-attempt guard
prevented socket initialization; there are no bytes or transport callbacks for
these rows. The two unsuccessful parents are quota blocks, not observed M-Lab
transport failures. The quota was not reset.

Eighteen recorded upload pauses, measured on the phone's own clock, lasted
**15.015–23.091 s**, with a **19.556 s median**; all fit their 25-second opportunity.
Their allowlisted request events contain eighteen changed trip updates,
eighteen accepted session manifests, **thirty-six record requests**, eighteen
completions and one payment request: 91 HTTP 200 responses. Repeated immutable
manifests were not needed during these successful windows. Serialized request
bodies total **2,085,448 encoded bytes versus 17,376,707 decoded bytes**; known
response bodies add **386,437 bytes**. These are recorded body sizes, not network
billing or complete trip traffic. Authentication and unobservable transport
overhead are excluded.

Pause/request events are saved into the next segment, which explains why this
snapshot has nineteen completed segments but only eighteen uploaded pause
records. Do not synthesize the missing last pause from server timestamps.
Cross-host receipt times are not used as precise upload durations.

Offline analysis of all nineteen exports found **zero errors**, **531 warnings
about ambiguous traceroute library labels**, and **two unavailable focused-view
checks for the quota-blocked M-Lab rows**. Recomputed counts, loss, summaries,
throughput and supported byte/header checks passed. The warnings remain visible;
the analysis does not infer original ICMP type/code from those traceroute labels.
Independent same-destination reference measurements remain necessary to establish
measurement accuracy.

Final Stop-to-receipt timing, local/server queue-version comparison and foreground
service shutdown remain pending connection of the physical phone. The installed
long-run candidate predates the later service-adoption fix below and the final
snapshot-freezing follow-up; its results must retain that build provenance.

## Android OS expiration and retry: synthetic emulator check

On 24 November local time, an isolated **Android 16 / API 36 emulator** used a
local mock authentication/ingestion service, synthetic flight details and an
unknown provider ASN. It remained in Watching: **no network probes or M-Lab
benchmark ran**, and no production account was used. Its existing non-pilot
fixture policy was retained; this check exercises common service cancellation
and idempotent delivery, not the new pilot's allowance arithmetic.

The test shortened Android's `data_sync_fgs_timeout_duration` to 3,000 ms and
made the mock commit record bodies before delaying their acknowledgement for
ten seconds. The first active-request test exposed a real ownership defect:
the service expired but a previously screen-owned upload continued. The corrected
`syncAccount` promotes a joined pass to service ownership, attaches the service's
abort signal and bounded deadline to the actual request, and prevents a screen
callback from starting a competing pass during handoff. Three targeted
regression tests cover those cases.

With the correction installed, the same native service record changed from
collection type `0x40000000` to `dataSync` type `0x1`, retaining
`startForegroundCount=1`. It was absent by the seven-second observation. The
in-flight record request cancelled after **3,309 ms** with
`reason=opportunity_cancelled`, null HTTP status and unknown response bytes.
**All fourteen local record versions remained pending**. Although the mock had
committed those fourteen records, the segment remained incomplete: a sent body
was not mistaken for an acknowledgement.

After restoring Android's normal timeout and removing the mock response delay,
reopening the app retried the same records without repeating the accepted trip
or session manifest. Server reconciliation stayed at **14/14 distinct records**,
the local queue became fully acknowledged, the saved trip revision matched its
uploaded revision, and the foreground service exited. This demonstrates recovery
from an uncertain acknowledgement without duplicate records. The accelerated
OS test does not establish six-hour endurance or physical-OEM behavior. The
timeout override was removed after the check. See Android's
[foreground-service timeout documentation](https://developer.android.com/develop/background-work/services/fgs/timeout)
for the platform mechanism used by this fixture.

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

A read-only comparison against all thirty-seven tracked release paths found that
deployed executable API sources, the export dictionary and public database CA
match the committed files. Only two README files and a newly added test file
differ or are absent from the earlier archive. No API restart was needed for the
mobile-only cancellation fix, avoiding an interruption to the active ground run.

Physical Android 15+ expiration/quota behavior, force-stop/reboot recovery on the
final APK, unplugged endurance, loss/delay gateway tests and actual flights still
require separate validation. The final APK's offline Stop → Recents removal →
Wi-Fi restoration check also awaits the physical phone. Android force-stop
prevents retries until the app is reopened. Neither the native callback nor the
synthetic emulator test establishes indefinite OS/OEM background execution.
