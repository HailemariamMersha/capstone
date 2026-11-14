# Private uncapped pilot validation — 14 November 2026

## Implementation and artifact

Participant pilot 1.2.0 (version code 8) removes visible phone sign-in/researcher controls, requires flight/route/duration, permits AS12 through normal pilot admission with sticky ground-test provenance, and separates uncapped M-Lab payload counters from bounded allocations. See [the current policy](uncapped-pilot.md).

Configured ARM64 APK: `build/pilot/2026-11-14-uncapped/SkyMeasure-pilot-arm64.apk` (local ignored artifact). Source commit: `7947993b938cd048786d3c842736ab6da8704ac1`; source dirty: `False`. Size: 32,790,714 bytes; SHA-256 `1c249a671a13e8d6414992145ff54085057e083939702c20b13649371c0d0235`. The builder verified packaged public endpoints/test-ASN markers and restored the sanitized tracked config. Android release and instrumentation assembly passed. The standard development signing key is for private pilot distribution only.

## Executed checks

- Mobile TypeScript and 282 Jest tests across 37 suites passed, including strict Start validation, invisible identity/ownership, AS12 normal qualification, production-list isolation, uncapped large counters, nullable pending attempts and latest trip provenance in local exports.
- Backend: 47 tests passed; one PostgreSQL-only check skipped in the local SQLite run. Tests cover new consent/required metadata, bounded versus uncapped policy accounting, legacy consent uploads, immutable/idempotent manifests, sticky ground flags, default filtered totals and explicit inclusion, with authoritative CSV labels.
- Dashboard: TypeScript, production build and 18 Playwright checks passed, including the ground-test inclusion control and large payload-counter display. Browser checks use sanitized services, not actual participant credentials/data.
- Android NDT7 library: seven JVM tests passed, including explicit bounded outcomes, nullable uncapped download behavior and receiver-counter interpretation. These tests are not a live M-Lab benchmark.
- Focused ESLint had no errors and two pre-existing navigation component warnings. Updated local documentation links and generated copies were checked.

## Deployment and device status

The implementation commits were pushed to `feature/skymeasure-participant-dashboard`. Lab deployment was attempted using only the isolated SkyMeasure release/service procedure with health checks and rollback prepared. SSH to `23.235.205.53:22` refused the connection **before any remote mutation**. External HTTPS `/health` returned 200; `/openapi.json` still lacked `TripUpdate.groundTest`, confirming the new backend was not deployed. No database migration, unrelated host change, UDP restart or DigitalOcean operation occurred.

The USB phone became authorized. Its installed pilot remains **1.1.4, version code 6**; no active pilot foreground service was found. The new APK was deliberately not installed against the incompatible live backend. No new phone measurement, speed-test publication or research-data upload was started. Once lab access is restored, deploy the compatible backend before installing the APK and obtaining acceptance of the new disclosure.

## Pending acceptance

Verify the phone's selected Wi-Fi actually resolves to AS12 (the Mac lookup returned AS12 / New York University; that does not prove the phone uses the same egress). Use clearly synthetic required flight details, then validate normal two-evaluation qualification, a consented full-duration uncapped M-Lab pair, payload evidence, fifteen-minute rotation/reconciliation and dashboard ground filtering. Switch to a nonmatching network to verify pause and the ten-minute ending grace. Keep physical-phone, unlocked/locked, power and connectivity conditions explicit.

No new unplugged endurance, captive-portal routing, process-death recovery, real-flight detection accuracy or Linux-reference comparison is claimed. Byte limits can be restored through a separately versioned policy before public distribution; memory, timing, cancellation and frequency safeguards remain in this pilot.
