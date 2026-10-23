# SkyMeasure implementation and validation — 2026-10-22

## Delivered source increments

| Area | Implemented behavior |
| --- | --- |
| Participant app | SkyMeasure light theme; Google welcome/consent; Home, Sessions and Account tabs; ten-minute / 100 MiB packet defaults; Advanced settings; owned session results and upload badges; optional Wi-Fi permissions; historical ownerless exports. |
| Authentication and ownership | Supabase browser PKCE with S256, exact callback checks and Keychain storage; offline cached participant identity; API-derived ownership; additive SQLite migration; participant/researcher/admin access; server administrator command; account deletion and identity-deletion worker. |
| Ingestion and research workspace | Immutable closed-session manifests, bounded versioned batches, exact acknowledgements, persistent retry backoff and reconciliation; collection/upload activity gate; Android Headless JS hooks; PostgreSQL indexed fields and JSONB; researcher filters, charts, individual observations, raw evidence and CSV/JSON downloads. |
| Staging preparation | Docker API/UDP/HTTPS proxy, separate deletion worker, environment templates, public mobile configuration generator, Vercel instructions, Frankfurt region labels, and physical-device acceptance procedure. |

The collector libraries, scheduler algorithms and original phone CSV bundle remain in place. Researcher combined CSV is an additional view. No kernel collection was added.

## Executed checks

- **196 mobile/core tests across 30 suites** passed, including existing measurement/export/repository tests and new onboarding, navigation, secure callbacks, offline identity, account scope, headless persisted-state protection, sync acknowledgements, retry backoff and reconciliation tests. Navigation/auth tests use controlled mocks; they do not validate Google itself.
- Mobile TypeScript and ESLint checks passed.
- Android debug and bundled release APK builds passed. Release packaging uses the project's existing development signing setup, not an app-store signing key.
- The bundled app launched on the Android API 36.1 emulator without a JavaScript/runtime crash. Welcome/setup-pending UI was inspected at normal and 200% font size. Accessibility hierarchy includes the Google button label; full TalkBack navigation with signed-in screens remains a physical acceptance item.
- Android registered persisted JobScheduler job 999, with 15-minute minimum cadence, start-on-boot and Headless JS. After confirming the background app process had exited, a forced job created a new process and called `finish` / `jobFinished`; this verifies callback wiring, not authenticated background delivery or real scheduling reliability.
- **34 backend tests passed with SQLite**, with the PostgreSQL-only policy check skipped in that run. The research suite also passed against **local PostgreSQL 17**, **11 research integration tests passed on PostgreSQL**, including denied cross-account operations, participant role escalation, revoked/invalid auth, partial/duplicate/conflicting uploads, deletion, preserved future fields, malformed records and original-dataset round trips.
- PostgreSQL migration enabled RLS. `anon` and `authenticated` could not read account rows even when temporarily granted SELECT inside a rolled-back test transaction. Application access uses FastAPI's validated identity and server-owned role checks.
- Next.js production build and TypeScript passed. Three Playwright browser tests passed: participant denied research navigation, approved researcher inspection/downloads, and narrow-screen sign-in. Browser API data/auth are sanitized fixtures, not a live Supabase deployment.
- The staging Docker image built. Container smoke checks passed for health, HTTP probe response, and disabled legacy ingestion.

## Saved experiment agreement

The original private `2026-10-12-library-ten-minute` JSON was read locally, registered through the API, uploaded in bounded batches, reconciled and exported. Its raw measurement objects remained equal after the round trip. No original private dataset is committed or sent to cloud services by these tests.

| Quantity | Expected | Observed |
| --- | ---: | ---: |
| Measurements | 41 | 41 |
| Stored samples, including baseline observations | 232 | 232 |
| ICMP replies / attempts | 98 / 100 | 98 / 100 |
| UDP replies / attempts | 40 / 40 | 40 / 40 |
| Standalone measurements without samples | 14 | 14 |
| Combined CSV rows | 246 | 246 |

Counts use distinct parent measurement IDs. Combined CSV parent fields repeat on sample rows and must not be summed. Zero RTT and missing RTT are separate cases. Large decimal-string timestamps survive unchanged. Spreadsheet formula prefixes are escaped.

## Pending live acceptance

The initial implementation used an emulator; subsequent physical-phone and server checks are recorded below. Supabase and the Google provider are now configured, and the private backend has a verified database connection. **Public HTTPS/dashboard deployment, real Google sign-in, final research consent, and the complete physical-phone-to-dashboard path are not validated**.

Follow [setup.md](setup.md) to complete staging and perform locked-screen, Recents removal, connectivity restoration, reboot, force-stop, account switching, expiry/revocation, deletion and TalkBack checks. OS background execution is opportunistic; passing a forced emulator callback is not proof of autonomous retry timing. The full PostgreSQL integration suite was run locally; the hosted Supabase connection/migration checks below do not replace it with real Google users. iOS background behavior is unvalidated.

The existing React Native toolchain has npm audit advisories that require a separate upgrade assessment before a public production release. This increment preserves the current measurement-tested React Native version rather than silently upgrading it. The dashboard dependency install reported no advisories at installation time. No store publication or production readiness claim is made here.

## Physical-phone smoke check — 2026-10-22–23

- Updated a Samsung Galaxy A34 (SM-A346E), Android 13, using `adb install -r` and the bundled ARM64 release APK. No uninstall or app-data clearing was performed; no collection service was active before the update.
- Built the app and instrumentation APK successfully after quarantining one corrupted local Gradle transform cache entry.
- Updated `AppLaunchTest` to expect the SkyMeasure Google welcome screen instead of the retired prototype heading. Ran `AppLaunchTest` and `LibraryProbeTest` on the phone: **5 tests passed**.
- The library checks cover IPv4/IPv6 loopback ICMP header/payload bytes, loopback UDP traceroute library results, error-field interpretation, and ICMP cancellation followed by another probe. They do not establish Internet-path reliability or test the React Native UDP echo service.
- Inspected the physical screen and accessibility hierarchy: welcome content rendered, Google sign-in was disabled, and the staging-setup explanation appeared. The app remained open without starting a measurement session.
- Confirmed persisted BackgroundFetch JobScheduler job 999 with a 15-minute interval. Registration alone does not establish that authenticated uploads run in the background.
- Public Supabase/API configuration remains empty. No account was created, no new session was collected, and no phone-to-dashboard upload was tested. Historical session contents were not audited during this smoke check.

## London pilot server preparation — 2026-10-23

- Confirmed the purchased Basic Droplet reports `lon1` from DigitalOcean metadata, Ubuntu 24.04, 961 MiB usable RAM and a roughly 25-GB disk. Installed Docker Engine/Compose and a persistent one-GiB host swap file (`swappiness=10`).
- Copied only backend/deployment source and the measurement dictionary; original private experiments and local credentials were excluded. Validated the merged base/small Compose configuration and built one shared image on the server.
- Started only `api` and `udp`, with one API worker, concurrency 16, bounded logs and memory limits. Container swap is disabled to avoid silently relying on disk-backed memory during measurements. The API is bound to host `127.0.0.1:8000`; UDP is published on 9876. HTTPS proxy and identity-deletion worker remain stopped pending configuration.
- HTTP health returned `{"status":"ok","region":"lon1"}`. Real server-loopback requests downloaded exactly one MiB and acknowledged exactly one MiB uploaded. These transfers do not validate an Internet HTTP path.
- From the Mac, **5/5 UDP probes** returned their exact 128-byte payload from the server. Public TCP port 8000 was not reachable. This is one short Mac-to-server check, not a phone or reliability experiment. DigitalOcean Cloud Firewall settings were not inspected through its control plane.
- **20 existing HTTP/UDP backend tests passed** inside a temporary container on the host. An unauthenticated profile request returned 401; legacy ingestion returned 404. No account or research database was provisioned.
- An idle snapshot after tests showed about 65 MiB for the API, 17 MiB for UDP, 482 MiB host memory available and zero swap usage. This is not a concurrent-load capacity result. Monitor server saturation/restarts alongside future measurements.
- The mobile configuration generator now requires `SKYMEASURE_PROBE_REGION`. Temporary-fixture checks confirmed `lon1` is written and missing/invalid regions are rejected without overwriting output; Node-compatible script lint passed. No participant build was reconfigured or installed during this server preparation.

## Hosted Supabase database connection — 2026-10-23

- Verified the project's public auth settings: Google provider enabled and public signup allowed. This does not establish that a real user can complete OAuth or that every redirect is configured correctly.
- After the user updated their password locally, authenticated successfully to the London session pooler. Obtained the public CA from the download URL in Supabase Studio's official source; certificate-chain and hostname verification then succeeded with `sslmode=verify-full`.
- Provisioned `skymeasure_api` with a generated, separately stored password and no superuser, create-database, create-role, replication or bypass-RLS privileges. It owns only the dedicated `skymeasure` schema and its application tables. It is not granted to browser roles. The project's `postgres` administrator can manage this role; the backend has no administrator password.
- Created `sky_accounts`, `sky_sessions`, `sky_records` and `sky_samples` using the existing SQLAlchemy models in one transaction, with RLS enabled and direct table grants revoked from PUBLIC, anon and authenticated. Browser roles also have no USAGE on the private schema. As table owner, the backend relies on FastAPI for per-account authorization; RLS does not independently constrain its own queries.
- Transferred only runtime credentials and the public CA to the London host over SSH; mounted the CA read-only and recreated only the API service. A real connection from that container confirmed verified TLS, `current_user=skymeasure_api`, `current_schema=skymeasure`, four protected tables and zero research rows.
- Missing and deliberately invalid bearer tokens both returned HTTP 401 from the running API. Health remained `ok` with region `lon1`. No user or measurement records were inserted, no real-account ingestion was exercised and no historical private datasets were uploaded.
- Credential files are ignored by Git and restricted to owner access. No credential values are included in this record. The account-deletion worker remains stopped because its separate service-role credential is not configured. Public HTTPS and the dashboard remain pending.

## UI previews

The dashboard images use synthetic browser-test records; the Android image shows the actual bundled app with staging configuration pending.

- [Android welcome](previews/android-welcome.png)
- [Research overview](previews/research-overview.png)
- [Session evidence](previews/session-detail.png)
