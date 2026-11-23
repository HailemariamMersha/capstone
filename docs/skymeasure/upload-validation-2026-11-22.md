# Upload handoff validation — 22 November 2026

## Scope and changes

Pilot 1.2.4 (Android version code 12) prioritizes a new trip over a pending upload. Start requests cancellation and receives the exclusive activity lease only after the uploader has stopped its request and finished acknowledgement cleanup. No measurement/upload overlap is allowed. Stop returns control after closing the trip rather than keeping Start disabled during the subsequent upload. Cancellation preserves unsent records without marking them failed or adding retry backoff. If cleanup does not settle within five seconds, Start reports that the upload is still stopping; it never force-unlocks the request.

Record-request timeouts and HTTP 413 halve the persisted per-owner/per-session record batch limit: 50, 25, 12, 6, 3, 1. Existing 512 KiB targeting remains; a single larger raw record stays intact. Manifest/completion errors do not shrink record batches. Safe retry diagnostics distinguish manifest, records and complete stages. A completion timeout no longer penalizes the previously acknowledged batch. Parent cancellation retains its cause instead of later becoming a timeout.

Post-trip uploads cannot enter an armed trip's collection window. The background coordinator checks the activity state again after cursor persistence. The API completion query projects record kind, identifier and version instead of loading raw evidence. No measurement method, ownership rule, authentication policy, allowance or historical record format changed.

## Automated checks

The mobile suite passed 329 tests across 40 suites. TypeScript passed. Backend tests passed 52 checks with one optional PostgreSQL integration check skipped in this local SQLite run. Two existing TestClient deprecation warnings remain.

Regression tests cover active-upload cancellation, late acknowledgements, idempotent release, duplicate Start, unresponsive cancellation without forced unlock, per-stage failures, persisted owner-scoped batch tuning, first cancellation cause, pre-cancelled credential requests, runtime Start, a trip arming during cursor persistence, and Start becoming enabled while a Stop-triggered upload remains pending. Backend SQL inspection checks that reconciliation does not select raw payloads.

## Phone and service observations

Installed the configured arm64 APK over the existing pilot on a Samsung Galaxy A34 without clearing app data. Packaged public configuration and the private test-ASN registry passed builder verification. Aggregate-only, opt-in device inspection found 55,249 pending queue records across the installation and 88,849 acknowledged records. A later aggregate inspection showed 54,471 pending and 89,627 acknowledged records: 778 additional acknowledgements during the check. Both final APK launch and aggregate inspection tests passed. Those totals span historical trips and are not the newest trip's counts. Instrumentation restarts the app and was used only while collection was stopped.

A Start attempt with a labelled ground form passed the former sync blocker and reached the existing Wi-Fi/VPN routing guard in approximately 2.3 seconds. The phone's VPN was active, so the app rejected Start before creating a trip. This establishes the routing guard and absence of the old sync error in that attempt; the subsequent VPN-free check below completes physical Start/Stop validation. No new M-Lab benchmark was run. Deterministic active-request handoff is covered by integration tests.

After the participant disabled the VPN, a labelled `TESTSTART` / Ground-to-Ground check reached the monitoring screen with a “Ground network test” label in 3.481 seconds despite the pending installation backlog. Stop was tapped at 3.540 seconds; by 5.973 seconds the normal flight form and enabled Start control were visible again. The active screen showed zero measurement records; collection never reached the qualification/benchmark schedule. This validates physical Start/Stop responsiveness with a pending backlog, while deterministic overlap with an in-flight upload request is separately established by the integration tests. No live M-Lab test was run. The server subsequently received the ground-labelled, participant-stopped trip and reconciled its one segment completely: 10/10 context/session/event records and zero measurements. Its receipt timestamp was 16:06:02 UTC (20:06:02 Dubai), confirming post-Stop upload resumption.

The isolated SkyMeasure API was updated with a source-only release and health-checked rollback path. Health returned HTTP 200, unauthenticated research access remained HTTP 401, and the UDP process was not restarted. No database migration or unrelated service change was made.

## Overnight trip: received evidence remains partial

The overnight trip ran for 24 hours and reported 96 segments, ending at the safety ceiling. At 15:53 UTC, 11 segments had reconciled completely: 3,131/3,131 expected records **within those registered segments**, 479 measurements and four unsuccessful measurements. Another 85 segment positions had not yet arrived. Earlier in this check only 2,946 records had arrived and one of the 11 registered segments was incomplete, so ingestion progressed during diagnosis. This observation does not isolate which change caused the improvement.

By 15:56 UTC, a twelfth segment manifest had arrived: 11 complete segments and 3,131/3,424 records expected across the 12 registered segments; 84 segment positions remained unreceived.

The received slice contained 1,529/1,530 ICMP replies (median 23.732 ms), 2,972/3,080 UDP replies (median 286.119 ms), 154/154 TCP connections (median connection duration 33.603 ms), and 11/11 traceroutes with library-reported destination reach. Controlled downloads were 0/2; controlled uploads 2/3. M-Lab download completed at approximately 117.084 Mbps and upload recorded a network error. These are **received-slice results**, not the full 24-hour totals or evidence of real-flight detection accuracy.

The four unsuccessful records were two downloads (network error and timeout), one cancelled controlled upload and one M-Lab upload network error. Record creation timestamps and a segment boundary do not establish the exact cause or instant of cancellation. A detector pause was present, but its generic stale/unavailable identity reason cannot prove VPN causation.

## Remaining limits

The request timeout reports a request that exceeded the client's 15-second deadline; it is not evidence that locally saved records vanished. Its precise network/server cause was not established. Automatic retries and idempotent versions retain partial progress, but the large backlog is not yet fully uploaded. Neither these checks nor foreground retry observations establish uninterrupted delivery after force-stop, locked-screen endurance or real-flight correctness.
