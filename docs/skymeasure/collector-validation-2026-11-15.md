# Private ground-pilot validation — 15 November 2026

## Scope and artifacts

One explicitly consented ground experiment used the normal ASN detector on the connected Android phone. The selected Wi-Fi independently reported AS5384 / Etisalat. The approved private test registry calls it **TEST Etisalat**, requires the ordinary two fresh evaluations, and permanently marks the trip as ground-test evidence. The six production providers were unchanged. An ASN identifies an egress network, not an individual router or an airborne aircraft.

Collection used pilot 1.2.1/code 9, source `e497ec079700b511ae38cf596bb0e5fee5f1ac8c`. The phone retained its existing identity, accepted the new research/M-Lab disclosure, and used synthetic mandatory flight details. No visible sign-in or researcher-mode bypass was used. Fresh anonymous enrollment was not retested in this experiment.

After Stop, pilot 1.2.2/code 10 was installed over the existing application to validate upload retries without clearing records or starting another measurement. Its clean source is `9874f9946a8d6cd908d15956ba03811c728c13d5`; APK size 32,791,494 bytes; SHA-256 `4245c8f00733c94c48fb8eba8ed1a4cbb2ea6228cd3609fbc98d7c8ac56227b0`. The local artifact is `build/pilot/2026-11-15-fair-sync/SkyMeasure-pilot-arm64.apk`. Packaged public settings and private test-provider gates passed the builder checks. Signing remains the development key for private evaluation.

## Observed collection

The trip ran approximately 19 minutes 48 seconds, including initial watching. Its two closed collection intervals total approximately 19 minutes 20 seconds. The first segment lasted fifteen minutes; one bounded upload pause lasted 25.379 seconds, then collection resumed in the same trip. Stop closed the second segment. Evidence contains 64 measurements, 758 sample/callback rows (including M-Lab progress callbacks), 239 events and 130 snapshots; those are different row granularities and must not be added together as measurement totals.

| Measurement | Complete-trip phone evidence |
| --- | --- |
| ICMP | 17 bursts; 170/170 replies; pooled median RTT 22.4005 ms |
| UDP | 18 bursts; 352/360 replies; pooled median reply RTT 273.0633 ms |
| TCP | 19/19 connections; pooled median connection duration 32.2062 ms |
| Traceroute | 2/2 reported reaching the destination; 66 probe observations |
| Controlled download | 3/3 succeeded |
| Controlled upload | 2/3 succeeded; one 30.009-second timeout |
| M-Lab download | One completed result: 108.9833 Mbps; 144,703,488 client payload bytes |
| M-Lab upload | One completed result: 87.8839 Mbps; 118,923,264 client payload bytes |

Both M-Lab directions have `stopReason=complete`, `success=true` and `requestedBytes=null`. Each exceeded the former 90 MiB direction cutoff. Upload headline throughput uses receiver-side server counters; the client payload count is separate traffic evidence, not the headline numerator or a carrier-billing measurement. Exactly one pair was run. No further M-Lab run was started during upload troubleshooting.

The timed-out controlled upload retains null transferred bytes: its partial byte count was not observed. This remains a measurement limitation; null must not be read as zero. Controlled fixed-size transfer rates are not a comprehensive link-capacity measurement.

## Scheduling and locked-screen evidence

The screen was locked roughly seven minutes into the trip and remained locked through the first rotation. The foreground service stayed active. USB remained connected; `dumpsys deviceidle` reported ACTIVE for deep/light idle, even while display wakefulness was Dozing. This was **not an unplugged or deep-Doze endurance test**.

Across both segments, the largest recorded detector-evaluation spacing was 39.507 seconds and heartbeat spacing 39.513 seconds. Neither segment reported a `collector_gap`; three minute-probe opportunities were explicitly skipped as `busy_deadline` (two ICMP, one UDP). Maximum recorded measurement lateness was 79.442 seconds in the first segment and 76.627 seconds in the second. Successful measurements therefore do not establish an exact one-minute cadence.

The offline analyzer reported zero errors for both original phone exports. Its 60 warnings qualify ambiguous traceroute library error classes; two unavailable focused-view checks concern the separately retained M-Lab records. Raw evidence was preserved. Private originals, account/trip identifiers, network addresses and device identifiers remain outside Git.

## Upload findings and fixes

The first live upload committed records but exceeded its client opportunity before durable acknowledgement. Retries must be idempotent: server commitment alone does not prove the local queue acknowledged those records.

Two issues were corrected:

1. Backend ground-provenance validation issued a database query inside the batch loop, causing repeated ORM autoflushes and remote database round trips. Commit `874cf26` validates the session's trip once before processing the bounded batch. A regression checks one lookup for a 42-record ground-evidence batch. The isolated API release was deployed with health, schema and authorization checks; the UDP process and unrelated services were untouched.
2. Two older 96-segment trips consumed successive 25-second opportunities before the new trip could progress. Commit `9874f99` persists an owner-scoped round-robin cursor across trips and the standalone legacy queue. A failure or cancellation advances the next opportunity without dropping evidence. New tests cover starvation, legacy backlog, failed manifests, collection exclusion and owner scoping.

Final read-only server verification found the trip closed and `uploadComplete=true`, with both segments reconciled: **435 expected / 435 received records**, zero missing or unexpected record versions, and no missing segments. Interrupted acknowledgements were safely retried; original records were neither deleted nor rewritten. The final retries respected the persisted exponential backoff rather than clearing it.

The server's combined-CSV projection produced **764 rows** (581 + 183), representing exactly **64 unique parent measurements** (47 + 17). Every row carried the authoritative `trip.groundTest=true`. Live overview queries including versus excluding ground evidence differed by exactly 64 measurements. Researchers must enable **Include ground-test data** to see this experiment in default-filtered lists and totals. CSV repetition is sample granularity, not extra measurements.

Post-trip foreground retries were exercised through the application's normal controls. This establishes complete eventual reconciliation for this stopped trip, not guaranteed completion within one live 25-second window. Slow or interrupted acknowledgements still need bounded retries; upload latency under satellite conditions remains a separate validation target.

## Automated checks and remaining acceptance

Mobile TypeScript and 288 tests across 38 Jest suites passed after the retry fix. Backend tests passed 49 checks, with one optional PostgreSQL check skipped locally. Earlier dashboard validation passed 18 browser checks, and the Etisalat update passed its two focused ground-filter checks. Seven native NDT7 JVM checks passed. Configured Android application/instrumentation builds passed. Read-only physical instrumentation independently verified the selected Wi-Fi ASN, valid saved service credentials and stopped local evidence.

Ground-test exclusion was checked against live server query results; a real signed-in browser UI check was not repeated today. Nonmatching-network pause and the ten-minute ending grace were not physically exercised. Captive-portal/cellular coexistence, unplugged endurance, force-stop/reboot recovery, fresh anonymous enrollment, Linux-reference comparison and real-flight detection accuracy still require separate validation. No coordinates were requested for this ASN-only trip. Public recruitment still requires approved participant text and enrollment protection.
