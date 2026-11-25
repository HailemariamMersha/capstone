# Account-free phone pilot — updated 25 November 2026

**Current: pilot 1.3.0**, policy `flight-paper-core-2026-11-25`, consent `skymeasure-paper-core-2026-11-25`. The [paper suite](../measurements/paper-suite.md) replaces controlled pairs with CDN comparisons and DNS discovery while retaining account-free enrollment, NetID separation, existing minute probes and one M-Lab pair. The sections below describe the 1.2.6 delivery baseline where explicitly versioned; its historical transfer schedule is not used for new trips.

Pilot 1.2.6 uses trip policy `flight-pilot-delivery-2026-11-23` and consent `skymeasure-flight-payment-2026-11-20`. The prior 1.2.3 hourly policy remains valid for saved trips. This is a private evaluation build, not public recruitment or validated flight detection.

## Participant flow

Get started enrolls an invisible Supabase anonymous identity. No Google sign-in, email, account selection, researcher role, shadow toggle or manual collection control appears on the phone. The researcher website retains protected Google sign-in and role enforcement. Existing identities and records remain owned as before; no data is silently assigned to a replacement identity.

After reviewing research/M-Lab disclosure, enter NYU NetID, flight number, departure and arrival, then Start. There is no Skip. NetIDs are participant-reported payment details, accessible only to administrators and stored separately from measurement exports. New trips use fixed hourly controlled transfers after the first pair at five minutes; no duration is collected. Ground-test details may be explicitly synthetic, such as TEST001 / Test origin / Test destination. Entries are participant reports, not booking verification. Notifications are requested before Start; Wi-Fi-detail location permission remains optional. Automatic trips do not collect GPS.

Settings retains upload preferences, optional Wi-Fi details, study information and data deletion. Credential refresh stays internal. A failed refresh offers retry and local segment exports before an explicit installation reset; old pending evidence is never reassigned. First enrollment needs internet. Existing enrolled installations can arm offline and await a fresh ASN lookup.

## Etisalat through the normal detector

The pilot builder enables `pilotTestAsnsEnabled` and Android `FLIGHT_PILOT`; both must be true. The normal six provider entries remain unchanged. The sole extra entry is AS5384, **TEST Etisalat**. AS12 (NYU) no longer qualifies in new builds; historical NYU trips remain valid ground-test evidence. A phone must actually use one of those egress ASNs for this test; an ASN covers a provider network, not one Wi-Fi router.

No researcher gate or admission bypass is used. Two fresh matches at least thirty seconds apart admit collection. A confirmed nonmatch pauses; loss of qualifying connectivity for ten minutes after first qualification ends the trip. Unknown identity on the same previously qualified Wi-Fi retains outage attempts. Stop, battery safeguard and 24-hour ceiling remain. None of these inferences establishes an airborne aircraft or landing.

Any observed test-ASN match marks the whole trip `groundTest=true`, permanently, including earlier segments. Detector evidence records `qualificationSource=ground_test_asn`; normal matches record `provider_asn`. Backend trip/session lists, summary CSV and overview totals exclude ground tests by default. Researchers can check **Include ground-test data**. Individual evidence remains accessible and labelled; it is not discarded. Combined CSV repeats authoritative `trip.groundTest` from the trip envelope; local session JSON and the CSV bundle's `trip.json` sidecar identify the whole trip even when the segment's original config predates qualification. Historical records are not relabelled from a guessed current ASN.

Non-pilot configuration disables this test entry. A normal build's native adapter retains the bounded byte cutoff; the builder’s private pilot configuration is what enables uncapped testing. Remove the pilot exception and review capped policy/consent before public release.

## M-Lab traffic and safeguards

The private pilot removes the 90 MiB per-direction cutoff and the 200 MiB reservation. Nullable byte-limit/requested-size fields use JSON null, meaning **unbounded by bytes**, not zero traffic. The native client provenance is `ndt7-client-android`, `0.2.2-skymeasure.3`; upstream remains pinned and locally patched.

M-Lab is outside the remaining allocations: 60 MiB controlled transfers, 20 MiB diagnostics/context, 20 MiB live record uploads. There is no overall 300 MiB ceiling for this pilot. The protocol's normal duration, 60-second pair watchdog, per-direction wait/connection timeouts, Wi-Fi binding, Stop, one pair per trip and four reserved attempts per 24 hours remain. Memory/control-message limits remain too. Fifteen-minute segment rotation can still cancel a long operation; dedicated measurement-block scheduling is not implemented.

`mlabUsage.downloadClientBytes` and `uploadClientBytes` retain available client-reported payload counters after the test, including incomplete results. Null means unobserved. Upload client counters exclude locally queued WebSocket bytes when the library reports progress, but do not establish carrier-billed traffic. The upload headline uses server-receiver counters, not client submission rate. Successful download Mbps = client bytes × 8 / client seconds / 1,000,000; upload uses server bytes/time and preserves AppInfo versus TCPInfo provenance. Failed/partial runs keep `value=null` even when byte/time observations are available. Transport overhead, retransmissions and post-trip sync are additional traffic. Ten seconds at 1 Gbps is roughly 1.25 GB in one direction.

M-Lab public-IP/results publication is still disclosed; removing phone sign-in does not make measurements unidentifiable. Existing users must accept the new disclosure before an uncapped trip. Deleting study data does not retract M-Lab publications.

> **Rollout status:** The compatible backend and additive payment-table migration were deployed to the isolated lab API on 20 November. Pilot 1.2.3 passed the [21 November physical ground check](collector-validation-2026-11-21.md), including final reconciliation of 225/225 records. New installations of the backend still require the migration below. The dashboard payment view requires deployment of the updated dashboard. The earlier 1.2.2 checkpoint is historical. The consented AS5384 ground run completed both M-Lab directions, rotated a fifteen-minute segment and retained its evidence. See [15 November validation](collector-validation-2026-11-15.md) for upload reconciliation, measured outcomes and limitations. [14 November validation](collector-validation-2026-11-14.md) remains the historical record of the initial SSH block.

## Upload retry fairness

In pilot 1.2.6, live and headless OS upload opportunities remain bounded to 25 seconds. After Stop the existing foreground service transitions to dataSync and drains successive 180-second passes, including while backgrounded. It stops after reconciliation or ten minutes without progress, and handles Android expiration. A persisted cursor scoped to the owner rotates between pending trips and the historical standalone-session queue, so an old backlog cannot monopolize every opportunity. Records within each trip remain ordered oldest first. The cursor advances before work, including on timeout or failure; committed records still require exact acknowledgements and server reconciliation. No record is dropped to advance the cursor. A cancelled opportunity leaves evidence saved for retry rather than requiring a new measurement run.

After a no-progress cutoff, automatic foreground retries wait at least fifteen
minutes rather than immediately restarting another stalled service. Existing
per-session backoff and server Retry-After deadlines can delay a retry further.

## Compatibility, build and validation

Old policies, budgets, consent versions and immutable manifests retain their meanings. Backend consent checks allow closed legacy uploads under their original policy, while uncapped trips require current consent, complete flight details and explicit ground-test provenance. Researcher authorization remains enforced for the website and older research clients. Additive JSON fields require no destructive database migration.

`npm run android:pilot` builds the configured ARM64 development-key APK, verifies packaged service/test-ASN settings and restores the sanitized tracked configuration. Review source commit, dirty-state flag and checksum in its manifest. Share the APK, not private datasets or environment files. See [CONTRIBUTING](../../CONTRIBUTING.md) for setup.

Automated checks cover admission, production-registry isolation, mandatory details, account-free UI, ownership, legacy ingestion, uncapped counters, nullable limits, ground filtering and exports. Physical tests must separately establish the phone's actual ASN, permission behavior, normal qualification, one live full-duration M-Lab pair with accepted disclosure, fifteen-minute rotation/reconciliation, nonmatching-network pause and the ten-minute ending rule. Record the exact build/device/power conditions. No unplugged endurance or real-flight accuracy is claimed by a successful build or a ground-ASN test.

## Administrator-only payment mapping and upgrade

Deploy the backend before installing 1.2.3. Run `python -m backend.research.manage migrate` with the protected migration database configuration; this additively creates `sky_trip_payments`, enables RLS and revokes Supabase browser-role access. Ensure the dedicated API database identity has SELECT/INSERT/UPDATE/DELETE on that new table using the existing runtime-grant procedure. Restart only SkyMeasure's isolated API service. Historical trips, manifests, consent and AS12 test evidence are retained without rewrites.

New trips send a separate idempotent `PUT /api/v2/trips/{id}/payment` after trip registration. Ownership comes from the verified token. The phone keeps this record in a separate SQLite table until acknowledged; account deletion removes it. `GET /api/v2/admin/payments` is administrator-only, paginated and marked no-store. Administrators see payment mappings under Participants → Payment reconciliation. NetIDs are not proof of flight, identity or payment eligibility. They are excluded from ordinary researcher routes, measurement JSON/CSV, M-Lab inputs and logs. Approved research text must describe this identifiable payment mapping before recruitment.

Consent is now `skymeasure-flight-payment-2026-11-20`; the M-Lab publication authorization retains its existing identifier because its publication terms have not changed. Previous consent versions remain valid for historical uploads. Existing users review the new payment disclosure before starting new trips.

## Pilot 1.2.6 delivery update

New trips use policy `flight-pilot-delivery-2026-11-23`: controlled download 500,000 bytes / 45 seconds; upload remains 1,000,000 bytes. M-Lab remains a separate normal-duration pair with the same publication consent and quotas. Redacted transport callbacks now retain phase, close code, queued bytes, HTTP status and allowlisted failure category; no signed URLs, close text or exception messages. Partial results never become completed speed results.

Deploy the compatible backend before the APK. This update adds no PostgreSQL tables or destructive migration; durable client receipts/journals use owner-scoped entries in existing local app_settings, and outstanding live reservations stay in local trip state. Previous policies remain uploadable unchanged. The foreground service needs the added dataSync declaration/permission, with a checked patch-package patch to change phase without restarting its Headless JS task. See [delivery validation](upload-validation-2026-11-23.md).
