# Account-free phone pilot — 14 November 2026

Pilot 1.2.0 uses trip policy `flight-pilot-uncapped-2026-11-14` and consent `skymeasure-flight-pilot-2026-11-14`. This is a private evaluation build, not public recruitment or validated flight detection.

## Participant flow

Get started enrolls an invisible Supabase anonymous identity. No Google sign-in, email, account selection, researcher role, shadow toggle or manual collection control appears on the phone. The researcher website retains protected Google sign-in and role enforcement. Existing identities and records remain owned as before; no data is silently assigned to a replacement identity.

After reviewing research/M-Lab disclosure, enter flight number, departure, arrival and expected duration (hours/minutes, total 1–1440 minutes), then Start. There is no Skip. Duration controls controlled-transfer spacing only; it does not stop collection. Ground-test details may be explicitly synthetic, such as TEST001 / Test origin / Test destination / 1 hour. Entries are participant reports, not booking verification. Notifications are requested before Start; Wi-Fi-detail location permission remains optional. Automatic trips do not collect GPS.

Settings retains upload preferences, optional Wi-Fi details, study information and data deletion. Credential refresh stays internal. A failed refresh offers retry and local segment exports before an explicit installation reset; old pending evidence is never reassigned. First enrollment needs internet. Existing enrolled installations can arm offline and await a fresh ASN lookup.

## AS12 through the normal detector

The pilot builder enables `pilotTestAsnsEnabled` and Android `FLIGHT_PILOT`; both must be true. The normal six provider entries remain unchanged. The extra entry is AS12, **TEST New York University**, as returned by the server for the development Mac on 14 November. A phone must actually use an AS12 egress connection for this test; an ASN covers a provider network, not one Wi-Fi router.

No researcher gate or admission bypass is used. Two fresh matches at least thirty seconds apart admit collection. A confirmed nonmatch pauses; loss of qualifying connectivity for ten minutes after first qualification ends the trip. Unknown identity on the same previously qualified Wi-Fi retains outage attempts. Stop, battery safeguard and 24-hour ceiling remain. None of these inferences establishes an airborne aircraft or landing.

Any observed test-ASN match marks the whole trip `groundTest=true`, permanently, including earlier segments. Detector evidence records `qualificationSource=ground_test_asn`; normal matches record `provider_asn`. Backend trip/session lists, summary CSV and overview totals exclude ground tests by default. Researchers can check **Include ground-test data**. Individual evidence remains accessible and labelled; it is not discarded. Combined CSV repeats authoritative `trip.groundTest` from the trip envelope; local session JSON and the CSV bundle's `trip.json` sidecar identify the whole trip even when the segment's original config predates qualification. Historical records are not relabelled from a guessed current ASN.

Non-pilot configuration disables this test entry. A normal build's native adapter retains the bounded byte cutoff; the builder’s private pilot configuration is what enables uncapped testing. Remove the pilot exception and review capped policy/consent before public release.

## M-Lab traffic and safeguards

The private pilot removes the 90 MiB per-direction cutoff and the 200 MiB reservation. Nullable byte-limit/requested-size fields use JSON null, meaning **unbounded by bytes**, not zero traffic. The native client provenance is `ndt7-client-android`, `0.2.2-skymeasure.2`; upstream remains pinned and locally patched.

M-Lab is outside the remaining allocations: 60 MiB controlled transfers, 20 MiB diagnostics/context, 20 MiB live record uploads. There is no overall 300 MiB ceiling for this pilot. The protocol's normal duration, 60-second pair watchdog, per-direction wait/connection timeouts, Wi-Fi binding, Stop, one pair per trip and four reserved attempts per 24 hours remain. Memory/control-message limits remain too. Fifteen-minute segment rotation can still cancel a long operation; dedicated measurement-block scheduling is not implemented.

`mlabUsage.downloadClientBytes` and `uploadClientBytes` retain available client-reported payload counters after the test, including incomplete results. Null means unobserved. Upload client counters exclude locally queued WebSocket bytes when the library reports progress, but do not establish carrier-billed traffic. The upload headline uses server-receiver counters, not client submission rate. Successful download Mbps = client bytes × 8 / client seconds / 1,000,000; upload uses server bytes/time and preserves AppInfo versus TCPInfo provenance. Failed/partial runs keep `value=null` even when byte/time observations are available. Transport overhead, retransmissions and post-trip sync are additional traffic. Ten seconds at 1 Gbps is roughly 1.25 GB in one direction.

M-Lab public-IP/results publication is still disclosed; removing phone sign-in does not make measurements unidentifiable. Existing users must accept the new disclosure before an uncapped trip. Deleting study data does not retract M-Lab publications.

## Compatibility, build and validation

Old policies, budgets, consent versions and immutable manifests retain their meanings. Backend consent checks allow closed legacy uploads under their original policy, while uncapped trips require current consent, complete flight details and explicit ground-test provenance. Researcher authorization remains enforced for the website and older research clients. Additive JSON fields require no destructive database migration.

`npm run android:pilot` builds the configured ARM64 development-key APK, verifies packaged service/test-ASN settings and restores the sanitized tracked configuration. Review source commit, dirty-state flag and checksum in its manifest. Share the APK, not private datasets or environment files. See [CONTRIBUTING](../../CONTRIBUTING.md) for setup.

Automated checks cover admission, production-registry isolation, mandatory details, account-free UI, ownership, legacy ingestion, uncapped counters, nullable limits, ground filtering and exports. Physical tests must separately establish the phone's actual ASN, permission behavior, normal qualification, one live full-duration M-Lab pair with accepted disclosure, fifteen-minute rotation/reconciliation, nonmatching-network pause and the ten-minute ending rule. Record the exact build/device/power conditions. No unplugged endurance or real-flight accuracy is claimed by a successful build or a ground-ASN test.
