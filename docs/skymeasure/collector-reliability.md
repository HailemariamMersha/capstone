# Collector scheduling and evidence — policy collector-scheduler-2026-11-23

> Current pilot 1.3.0 adds the [paper-suite schedule](../measurements/paper-suite.md) on top of this lifecycle. New trips replace the scalar trace deadline and controlled transfer pairs with target-aware DNS/trace/CDN slots, persist round order across segments and reserve/settle CDN content bytes. HTTP/CDN and M-Lab are heavy jobs; long paper jobs are admitted only when their deadline fits before the boundary. The transfer paragraphs below describe historical policies.

> Pilot 1.2.6 adds bounded boundary grace and upload-service handoff. Older runs retain their saved scheduler and transfer policies. Qualification is separately documented by the [ASN-only policy](../measurements/flight-collection.md); historical GPS-based admission does not apply to new automatic trips.

The collector changes how existing tests are scheduled and explained. It adds
no network measurement method, changes no historical record, and does not
claim that Android always permits continuous background work. New sessions use
`collectorVersion=skymeasure-libraries-2` and the complete
`collectorPolicy=collector-scheduler-2026-11-23` configuration. Transfer budgets,
consent, ownership, probe libraries and flight qualification remain versioned
by their existing policy.

## Scheduling and isolation

Control and measurement work run as two asynchronous lanes. Control evaluates
network/flight evidence and records snapshots and heartbeats nominally every
30 seconds. Probe jobs remain serialized; record uploads never overlap a probe
job. Network identity requests may overlap a transfer and are labelled with
the current activity. They are deferred during record uploads. These are async
lanes on React Native's JavaScript runtime, not independent operating-system
processes: suspending that runtime can still pause both lanes.

Minute probes advance from their previous scheduled deadline, with a one-second
dispatch tolerance. This controls eligibility, not a guarantee of invocation within
one second: an already running serialized probe can delay another job. Its
actual lateness remains visible. Both directions of a transfer pair reference
the pair's planned slot; upload lateness includes the preceding download.
Missed slots are counted and skipped; they are not replayed.
After a control wake-up over 90 seconds late, a `collector_gap` records the
unobserved interval and skipped slots. Packet deadlines restart with different
offsets. Overdue transfer opportunities advance to a future slot; an unstarted
M-Lab job is deferred with new randomized spacing. Elapsed time is not invented
measurement coverage.

At a segment boundary, the control lane stops admission of new measurement jobs.
An in-flight ICMP, UDP, TCP or traceroute job can finish within ten seconds of the
scheduled boundary; the timer cancels it if that grace expires. Controlled HTTP
and M-Lab transfers are cancelled immediately. The worker waits for native cleanup
before closing the immutable session and attempting uploads. Grace is measured
from the scheduled boundary, not the next worker callback. The next boundary
remains on the original fifteen-minute schedule; grace does not accumulate.
`segment_drain` records the cleanup interval separately from `upload_pause`.
Control observations during the pause are bounded, persisted in the owned local
trip and written to the next segment with `bufferedDuringUpload`. Recovery after
interruption preserves surviving buffered observations in an interrupted evidence
segment. A closed trip is not silently resumed.

The 24-hour safety deadline is checked before network control work and before
starting another probe after waking. A late handling event records the actual
handling time and its lateness; it does not backdate the stop. SDK cancellation,
CPU suspension or a native cleanup delay can still delay final handling. The
collector prioritizes preventing overlapping network jobs over pretending a
native job has already stopped.

## Identity, heavy jobs and transfers

Identity requests have a ten-second deadline, retry after fifteen seconds on
failure and normally refresh each minute. A successful cache entry survives a
transient request failure until its existing two-minute freshness limit. A
network change invalidates it immediately. Oversized, malformed, stale or delayed
responses never become fresh evidence merely because their callbacks arrived.
Request outcomes are recorded without tokens, response bodies or exception URLs.
The proposed five-minute freshness extension is deferred until gateway/600 ms
link validation.

M-Lab retains its native sixty-second watchdog and randomized one-to-three-minute
initial spacing. Controlled transfers stay at least sixty seconds away from the
actual completion of a heavy job. A pair retains its reservation and remaining
direction across ordinary segment boundaries. After a collector gap, remaining
reserved directions are explicitly skipped and their existing charge is retained;
they are not replayed on wake-up. Two consecutive endpoint failures disable
that direction for the trip. Boundary cancellations and timing interruptions do
not count as endpoint failures. No reservation is refunded or silently moved
between budget categories.

All automatic downloads use `@dr.pogodin/react-native-fs`, avoiding full-body
conversion in JavaScript. New pilot trips request **500,000 bytes** with a
**45-second** total deadline. Controlled uploads remain 1,000,000 bytes with a
30-second deadline. Connection and read-idle limits remain ten and thirty seconds.
Older hourly pilot trips retain 5,000,000-byte downloads and the saved 90-second
deadline; do not reinterpret their results as the new size. Non-overridden
transfer deadlines use `min(90s, max(30s, 10s + bytes * 8 / 500000))`; 0.5 Mbps
is a scheduling assumption, not an inferred capacity. The detector continues
while either transfer is in progress.

Failed downloads retain the last observed native file-byte count when available.
Unknown progress stays null, including uploads without a complete server
acknowledgement. Failed tests retain a null primary throughput value. Partial
bytes/rates are not a bound on network capacity. HTTP transfers still measure a
complete transaction, including setup and acknowledgement, rather than an
Ookla-equivalent capacity benchmark.

UDP remains pipelined: the next send follows the native send callback and a
250 ms interval, not the previous echo reply. The existing three-second reply
grace and bounded burst deadline remain. At 600 ms RTT, propagation alone does
not multiply the duration by the number of packets.

## Record meanings

| Field/event | Meaning and units |
|---|---|
| `measurement.scheduledAt` | Intended slot, ISO wall-clock string; distinct from actual execution. |
| `measurement.timestamp` | Existing method's execution timestamp; existing interpretation retained. |
| `scheduling.startedAt` | JavaScript job invocation after route/power checks, ISO string. |
| `scheduling.callbackAt` | Result returned to the scheduler, ISO string. |
| `scheduling.saveRequestedAt` | Save requested from the repository, ISO string. |
| `measurement_saved.persistedAt` | Repository save returned; join by measurement identifier, ISO string. |
| `scheduling.latenessMs` | Job invocation minus intended slot, milliseconds; up to 1 s early is allowed. |
| `scheduling.wallDurationMs` | Callback minus invocation on the wall clock, milliseconds; wall-clock changes can affect it. |
| `start/endElapsedRealtimeMs` | Android monotonic milliseconds since boot, including deep sleep; null if unavailable. |
| `scheduling.timingValid` | False when elapsed-clock duration exceeds the method's reported duration by more than 2 s. This conservative flag does not identify a particular Android cause. |
| `scheduling.reportedValue` | Original method headline value retained when timing is rejected; unit follows the measurement. |
| `transfer.stage` | Last observed connecting/body/acknowledgement/completed stage; not a DNS/TLS timing breakdown. |
| `transfer.observedBytes`, `bytesScope` | Last observed file bytes or complete acknowledged payload, with explicit scope; null means unavailable. |
| `transfer.headersAfterMs` | Time from invocation to the header callback, milliseconds; includes earlier connection work. |
| `collector_heartbeat` | Activity, app state and available Android clock/power flags at control observation time. |
| `collector_gap` | Unobserved interval, duration, skipped jobs and clock/power evidence; not proof of internet downtime. |
| `collector_identity` | Identity request interval, outcome, overlapping activity and whether cache evidence remained fresh. |
| `collector_upload_request` | Manifest/batch/completion stage, outcome, duration, request bytes and safe failure category. A response is not itself proof of complete trip reconciliation. |
| `upload_pause` | Actual pause interval, nominal 25 s limit, intended boundary and outcome; ISO times in new exports. |
| `segment_health` | Expected/started/settled jobs by type, skipped jobs by reason, gap count, unobserved duration and maximum nonnegative lateness. Counts describe measurement jobs/bursts, not individual packets. |

Boundary-cancelled, participant-stopped and timing-invalid attempts are
interruptions, separate from network/measurement failures. New records retain an
explicit `interruptionReason` and null headline value. Their
original samples, callbacks and reported headline value remain available for
audit. Trip-card timing medians exclude explicitly flagged attempts, while reply
observations and separate interruption counts remain visible. The session table
labels timing evidence and omits flagged headline values, median, p95 and
successive-difference statistics. Its individual samples and original downloads
retain the recorded values. Scheduling uses the new scheduler invocation time
when present and falls back to the historical method timestamp. Historical attempts
without the new flag retain their prior interpretation. Do not combine clock
domains or compare boot-relative values across reboots. Android `uptimeMs`
excludes deep sleep, while `elapsedRealtimeMs` includes it; wall time can change.
See [Android's clock definitions](https://developer.android.com/reference/android/os/SystemClock).

These additive fields remain in original JSON and combined exports. Existing
focused CSV projections retain their format; use the original JSON and event
details for the additional scheduler evidence. No positions or raw location
objects enter these records.

## Upload lifecycle and transport

Each live upload opportunity starts after durable segment closure and has one
absolute 25-second deadline shared by all requests. The service and detector
remain alive. After Stop, collection releases its routing/activity lease and
the existing foreground service switches in place to `dataSync`. The uploader
uses successive 180-second passes, stopping when final receipts reconcile,
authentication/conflict needs attention, Android expires execution, a new Start
preempts it, or ten minutes pass without new record/completion acknowledgements.
Connectivity/backoff waits do not reset that no-progress timer. Pending evidence
stays local. Headless OS opportunities remain bounded to 25 seconds and cannot
cancel a service-owned drain.

The drain handler is registered for the JavaScript process lifetime, rather than
by a screen. Its own network listener enforces the Wi-Fi/mobile-data preference
even after the activity is removed. UI teardown stops only the visible retry
scheduler, not service-owned uploading. New acknowledgements returned by an
already-running shared upload pass still reset the drain's progress timer.

V2 transport gzip-compresses bodies of at least 1 KiB when compression saves
bytes. The server limits both encoded and decoded bodies to 8 MiB. Record batches
target at most 200 records and 512 KiB decoded; an individually larger record
stays intact. Until the server advertises support, clients retain the 50-record
identity-encoding contract. Android React Native's `NetworkingModule` strips
`Content-Encoding` for binary request bodies, so the client also supplies the
negotiated `X-SkyMeasure-Content-Encoding: gzip` alias. The API uses the same
strict gzip decoder for both headers and rejects conflicting labels. This avoids
recompressing a string natively with an unobservable compressed size.

An owner/API-scoped fingerprint records accepted immutable session manifests.
Unchanged accepted manifests are skipped; changed accepted bodies require review.
Trip registration snapshots retain their accepted revision, while compact receipts
verify final segment reconciliation. Exact record ID/version acknowledgements
are durably applied even if a response arrives after opportunity cancellation.

The 20 MiB live-upload allocation is unchanged. New-policy requests reserve the
encoded body plus 64 KiB, then settle a known response to encoded request bytes
plus UTF-8 response-body bytes. A dispatched request without a response keeps
its full reservation; only a proven pre-dispatch failure is free. Crash-surviving
reservations are conservatively charged on recovery. Headers, TLS/TCP overhead,
retransmissions and authentication traffic remain outside this payload account.
Old trip policies retain their original accounting rather than being rewritten.

The `react-native-background-actions@4.1.0` patch is checked in under `patches/`.
It changes service type/notification without restarting Headless JS, returns
Android's accepted type for verification, and forwards OS expiration. `npm ci`
applies it with `patch-package --error-on-fail`; incompatibility must fail setup.
Run the executor/coordinator tests and an Android build after any library update.
See the [dated validation report](upload-validation-2026-11-23.md) for measured
results and platform limits; implementation intent is not endurance evidence.

## Battery configuration and validation

Researcher Home exposes battery-optimization status and the Android settings
page. The app does not grant itself an exemption or require another runtime
permission. Native power evidence records whether the setting was enabled for
each observation. A foreground notification alone does not prove continuous
execution. Test both ordinary optimization and explicitly allowed background
access. [Android documents Doze restrictions and the diagnostic commands](https://developer.android.com/training/monitoring-device-state/doze-standby).

For diagnostic shadow runs, researchers can turn **Include M-Lab in shadow test**
off before Start. Ordinary participant trips retain automatic M-Lab and the
combined consent. Tests with it disabled do not publish an M-Lab result.

Fake-timer regression tests cover phase-preserving deadlines, late wake-ups,
control during long jobs, boundary cancellation, stale identity responses,
heavy-job spacing, per-direction failure cutoffs, post-ceiling resume and
clock-discontinuous results. API timeout tests verify that caller cancellation
does not replace the per-request deadline. Download tests retain known partial
progress without inventing throughput. Backend tests verify median exclusions
without deleting original sample values.

The [dated physical checks](collector-validation-2026-11-08.md) cover forced
idle and a screen-locked fifteen-minute boundary, including complete
post-trip reconciliation. They did not reproduce actual deep sleep while USB
was connected. A one-hour unplugged endurance test, a dedicated 600 ms
delay/loss gateway, OEM diversity and actual flights remain separate validation
requirements. Do not apply traffic shaping to the shared lab host.

`CollectorEvidenceTest` is an opt-in, read-only export of stopped v2 collector
sessions. Stop the trip before invoking instrumentation: Android restarts the
target application when instrumentation starts. Exported private data stays in
the app's external-files directory and ignored local `build/` artifacts; it must
not be committed. The optional diagnostic companion also exports local queue
counts and retry deadlines for the stopped session; it never exports
authentication settings.
