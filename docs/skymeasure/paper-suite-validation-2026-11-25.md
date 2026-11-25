# Paper-suite validation — 25 November 2026

Scope: pilot 1.3.0 / paper-core-v1, an unrooted Android ground-test implementation. The [suite guide](../measurements/paper-suite.md) defines URLs, timing scopes, budgets and exclusions. Earlier upload/endurance observations belong to their recorded 1.2.6 build and are not new-suite accuracy evidence.

## Automated evidence

- 379 JavaScript tests across 46 suites pass, including historical collector fixtures, two paper rounds across rotation, literal/hostname targets, partial cancellation, reservation accounting, nullable resolver discovery, dictionary coverage and exports. Full type checks pass; ESLint has no errors (16 pre-existing warnings).
- 72 backend tests pass; one optional PostgreSQL-specific test is skipped in the local SQLite run. New tests exercise versioned consent, ownership, monotonic counters, duplicate ingestion, target/provider filters, separated CDN medians, null resolver fields, large nanosecond strings and combined CSV/raw JSON preservation.
- Eight native JVM tests pass using a local trusted TLS server: correct object/phase observations, mismatch, redirect without following, bounded body, normal unconfigured response, absent resolver IP, cancellation with following request, exact nanosecond strings and callback drop counts.
- The terminal harness passes 28 tests, including 14-hour and 24-hour paper schedules plus frozen historical policies. These simulations establish software scheduling properties, not Android endurance or flight accuracy.
- Dashboard production build succeeds. The 23 existing browser scenarios and the added paper-suite scenario pass; the new scenario verifies the actual trip workspace, provider/target requests, phase medians and nullable resolver history. Browser evidence uses sanitized synthetic records.
- The configured ARM64 pilot build succeeds. Its builder verifies public service configuration, suite/policy strings and the generated registry inside the actual APK. Build manifests and APKs remain local under ignored `build/pilot/`.

## Live feasibility and pending checks

A terminal preflight fetched each of the five configured CDN URLs with HTTP 200, 89,501 bytes and the identical registry SHA-256. A random NextDNS host returned a bounded JSON diagnostic response. These are endpoint feasibility checks, not a phone/reference comparison.

The connected phone is a Samsung Galaxy A34 (Android 13). The previous pilot was idle before the upgrade; the update uses install-in-place and does not delete local evidence or replace its anonymous identity. New third-party disclosure must be accepted by the participant before a live run.

A complete two-round ground run, exact local/server reconciliation on the final APK, same-Wi-Fi Linux comparison, impaired-link testing, Android 15+ behavior and real-flight detection accuracy remain separate checks. Do not claim live results or reliability from the unit fixtures. Ground-ASN tests stay labelled ground tests and excluded from flight totals by default.

## Deployment and compatibility

Backend changes add optional JSON fields and read models; no new table or destructive migration is needed. Deploy the compatible API before the APK. Historical trip policies, consent, immutable manifests, fixed-transfer evidence and raw future fields remain uploadable. Keep the public database CA and dictionary in the source-only API archive. Only SkyMeasure's isolated lab API service may be restarted; unrelated lab services and the DigitalOcean rollback host remain untouched.

The phone still uses hidden anonymous enrollment, required NetID/flight route, ASN-only qualification and continuous trips with closed upload segments. M-Lab publication and its once-per-trip/four-attempt quota remain unchanged. DNS/CDN traffic is separately disclosed; no GPS coordinates, raw packet engine, kernel TCP state or additional regional service is introduced.
