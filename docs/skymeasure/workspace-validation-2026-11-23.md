# Trip workspace and staging reset — 23 November 2026

This increment changes history management and researcher presentation. It does not
change probe methods, ASN admission, allowances, M-Lab policy or segment/upload
schedules. No flight detection accuracy or endurance claim follows from it.

## Automated checks and deployment

- 332 mobile/core tests in 40 suites passed; mobile TypeScript passed.
- 63 backend tests passed; one optional PostgreSQL policy test was skipped by the
  local SQLite suite. Separately, the deployed private schema's server-role
  SELECT/INSERT/UPDATE/DELETE checks passed in a rolled-back transaction. Browser
  roles remain denied. The four new tables use explicit server-only RLS policies.
- 20 Playwright tests passed with sanitized fixtures: access control, compact
  navigation, lazy evidence, exports, variable help, route ambiguity, payment
  restrictions and horizontal scrolling at 390/1280 pixels. Screenshots were
  inspected. Dashboard TypeScript and production build passed.
- Dashboard Next.js was updated to 16.4.5 after checking its security release;
  its dependency audit reported zero vulnerabilities at installation. This does
  not imply the separate React Native dependency tree has no advisories.
- The isolated API deployment passed health/authentication checks. The UDP service
  was not restarted. The Vercel `/trips` route returned HTTP 200 after the Git push.
  Live researcher Google sign-in was not repeated during this increment; browser
  authorization checks use fixtures, and deployed unauthenticated reads require
  authentication.

The initial additive migration used the administrator's public search path rather
than the runtime's private schema. The live benchmark caught the mismatch. The
previous API was restored while the four new empty tables were placed in the
correct schema and server RLS writes were verified. No original measurement data
was deleted during that correction. The committed migration explicitly selects
`skymeasure` and supplies its server policy.

## Performance before deleting history

The live PostgreSQL inventory contained 24 trips, 524 segments, 118,412 records and
170,780 samples. On the service host, ten compact-list reads returned twenty trips;
the cold read and maximum/p95 of these ten observations were **3.703 seconds**.
The largest trip contained 28,950 records: selected-trip detail took **13.674
seconds** uncached and **1.022 seconds** cached. These timings exclude JWT
verification and the browser/network path. They show bounded queries and caching,
not a guarantee that every network request finishes within a fixed deadline.

An independent synthetic SQLite fixture with 24 trips, 522 segments, 117,681
records and 169,599 samples gave a 153 ms compact-list p95 and 9 ms cached detail.
Those local timings must not be substituted for cloud or phone results.

After reset, three empty-list queries took **210, 172 and 170 ms** on the server.
A separate Mac-to-lab 1 MiB HTTPS check received only 692,800 bytes before its
30-second timeout (about 23 KB/s). This diagnoses that connection at that time;
it does not establish a server capacity limit. Full exports still depend on
network speed. The archive transfer was slower than metadata requests.

## Archive and reset evidence

The explicitly authorized scope was all existing staging test history, including
historical local records, while preserving identity/access and independent
archives. No private archive, NetID mapping or raw participant row is committed.

| Resource | Verified archive contents |
| --- | --- |
| Supabase history | 24 trips; 524 sessions/segment links; 118,412 records; 170,780 samples |
| Separate cloud payment mapping | 5 rows |
| Phone history | 24 trips; 624 sessions; 20,362 measurement parents; 82,624 events; 44,049 snapshots; 147,659 queue rows; 624 debug rows |
| Separate phone payment mapping | 5 rows |

The protected cloud archives are retained at
`/var/backups/skymeasure/cleanup-20261123/` on the lab host, separate from the live
Supabase database. Evidence archive SHA-256:
`fca72d4b1a7f4326d9dc7eb47db20b894942263ac2063963a55ca50d3398042d`.
A byte-identical cloud archive, separate payment file and manifest are also
protected locally under `build/cleanup/2026-11-23/cloud-complete/`; the Mac repeated
the full restore verification successfully. Temporary transfer fragments were
removed after both copies matched. The phone archive and separate payment file are protected locally under
`build/cleanup/2026-11-23/phone-v2/`. SQLite SHA-256:
`18356e75effaf41e4a5ef2eff60772190c3794618a26e3294bf4b0bf9d42bdf7`.

Cloud verification restored every table into a disposable foreign-key-enforced
SQLite database, then compared complete canonical rows, counts, IDs and versions.
The phone copy passed native inventory/integrity checks; an independent Mac
restore reinserted the separate payment rows and matched every table's full
logical hash. A failed initial Android PRAGMA attempt did not authorize deletion;
the corrected backup was verified before clearing the phone.

The transactional cloud reset verified zero history and an unchanged digest of
account IDs, participant IDs, roles, consent and upload preferences. Live deployed
guard checks reject old owned recordings with 410, other-owner IDs with 404 and
unregistered pre-cutoff manifests with 410; post-cutoff timestamps remain allowed.
The phone reset verified zero evidence/queue rows and an unchanged device row.
Keychain identity, consent, settings and the native M-Lab quota ledger were not
cleared. The app reopened directly to Home and showed **No trips saved yet**.
Only the temporary phone backup files created during this task were removed after
the protected Mac copy was verified.

See [the maintenance procedure](history-maintenance.md) for replay protection and
recovery. This reset does not erase disks on other installations. The updated app
retires their removed records from normal history/upload while retaining local
exportability and identity ownership.

## Shareable build and short check

The configured private ARM64 APK is `build/pilot/1.2.5/SkyMeasure-pilot-arm64.apk`,
version **1.2.5 / code 13**, 32,823,634 bytes. SHA-256:
`13261be3132dde58f70df407ef28ed29369d43f7c61f06e2674b4d5d174ba0d6`.
Packaged public configuration was verified. It is a development-key pilot for
compatible Android phones, not an iPhone build or a public store release.

The new `GROUND125` check used sanitized payment/flight details and the normal
Start/Stop path. Stop was tapped after **42.25 seconds**. The server received one
completed ground-test trip, labelled **TEST Etisalat**, with **13/13 expected
context/control records reconciled**. There were **zero measurement parents and
zero samples**: this deliberately short check ended before packet measurements,
M-Lab or controlled transfers. It validates the new post-reset ownership/storage/
upload path, not network measurement correctness. Selected-trip detail took
**1.629 seconds** on the service host. The phone returned to Home with Start
available and no collection left running. Its aggregate queue diagnostic reported
one Uploaded session, thirteen acknowledged records, zero attempts/retries and
no pending errors. Android reported no running SkyMeasure service. One new labelled ground trip remains
intentionally; the old history stays archived/removed. Linux reference comparisons,
unplugged endurance and actual-flight validation remain separate work.


## Standalone guide restored

The sidebar again includes **Measurement guide**, available at `/guide` without
selecting a trip. Its source-linked catalog explains actual Android/TypeScript
library calls, HTTP requests, targets, ports, payloads, timing boundaries, formulas
and saved fields. Linux comparison commands are labelled separately. It includes
current automatic methods, M-Lab counter selection and the HTTP/loaded-latency
tooling paths that are not scheduled in automatic trips. Search covers current
trip-table aliases and event fields as well as measurement/sample/scheduling fields.

**22 browser tests**, dashboard TypeScript and the production build passed after
this follow-up. The new narrow-screen guide check verifies implementation snippets,
port/event definitions and absence of trip/session evidence fetches. It does not
execute the displayed commands or initiate network experiments. Phone collection
and server behavior are unchanged by this guide update.
