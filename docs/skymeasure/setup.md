# SkyMeasure staging setup

> Current phone UX and limits are defined by [pilot 1.2.0](uncapped-pilot.md): no phone Google/researcher controls, required flight details, AS12 normal admission and uncapped M-Lab. Google configuration below applies to the researcher website and historical clients.

> Current hosting: isolated SkyMeasure API/UDP services on the shared lab host, Supabase PostgreSQL/Auth, and Vercel dashboard. Region is `lab-location-unconfirmed`. DigitalOcean instructions below document the original deployment and retained rollback host; do not reprovision it for the current pilot. Current qualification is [ASN-only](../measurements/flight-collection.md).

> For the current anonymous-participant flight pilot, follow [flight rollout and MaxMind setup](flight-rollout.md). Google/PKCE instructions below apply to researchers and retained Google accounts. The new participant flow uses background anonymous enrollment and fifteen-minute trip segments.

**Deployment history:** the 31 October lab cutover is recorded in [lab migration](lab-migration.md). Later ground-device checks and the latest ASN-only build have separate evidence in [validation](validation.md). Do not read a dated pending/passed check as the status of every later build.

This repository contains the participant application, private researcher dashboard, and authenticated API. The collection libraries and probe algorithms are unchanged. Use a separate staging project and study test accounts; final research text and consent approval are deployment inputs. The shared lab server now serves the Supabase-backed API at `https://api.hailemariam.com`; the former London Droplet remains available for rollback. The dashboard is live at `https://capstone-backend-henna.vercel.app`; the user confirmed browser Google sign-in, and the first administrator role has been verified. Later lab-configured ground runs are documented in [validation](validation.md); physical validation of the new ASN-only pilot remains pending. New contributors should start with [CONTRIBUTING](../../CONTRIBUTING.md), which separates credential-free local checks from deployment setup.

## 1. Supabase and Google

Create a Supabase project near the backend; the initial deployment uses **West Europe / London (`eu-west-2`)** alongside the London Droplet. Then enable Google under Authentication → Sign-in providers. In Google Cloud create a Web OAuth client. Register the Supabase callback URL shown by the provider settings (`https://PROJECT.supabase.co/auth/v1/callback`) with Google. Put the Google client ID/secret **only into Supabase**. Configure the OAuth consent screen and test users while the Google project is in testing.

In Supabase URL Configuration, use the dashboard HTTPS domain as the site URL and allow these exact redirects:

- `com.labpracticeapp://auth/callback` for the Android staging application;
- `https://YOUR-DASHBOARD/auth/callback`;
- `http://localhost:3000/auth/callback` for local web development, removed from production configuration.

Avoid broad wildcard redirect allowlists. Mobile uses an external browser with PKCE S256, a Keychain-held verifier, an exact callback check, and a ten-minute locally initiated sign-in window. Tokens are never passed in redirect fragments. This custom scheme works with the current Android application ID; before app-store release, configure a verified HTTPS App Link with your final domain and signing certificate. Android is the validated target; iOS URL registration/background operation are not promised here.

Use a **publishable key** (`sb_publishable_…`) in the apps. It is public configuration, not a secret. Keep the service-role key and database password exclusively on the server. Public signup always creates a participant; Google metadata cannot set research roles.

References: [Google OAuth](https://supabase.com/docs/guides/auth/social-login/auth-google), [PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [PostgreSQL connectivity](https://supabase.com/docs/guides/database/connecting-to-postgres).

## 2. Database and API

Use the Supabase session pooler connection when the server cannot reach the direct IPv6 endpoint. Use SQLAlchemy's `postgresql+psycopg://` scheme with `sslmode=verify-full` and the [public Supabase CA](../../deploy/certs/README.md). System CA bundles alone do not trust this pooler's private certificate authority. Compose mounts the certificate read-only; local Python commands must instead use its local filesystem path.

The initial deployment uses a dedicated `skymeasure_api` login and a private `skymeasure` schema. Provision them once through the administrator connection, using a generated password stored in protected local configuration:

```sql
CREATE ROLE skymeasure_api LOGIN PASSWORD 'REPLACE_WITH_GENERATED_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 12;
GRANT skymeasure_api TO postgres;
GRANT CONNECT ON DATABASE postgres TO skymeasure_api;
CREATE SCHEMA skymeasure AUTHORIZATION skymeasure_api;
REVOKE ALL ON SCHEMA skymeasure FROM PUBLIC, anon, authenticated;
ALTER ROLE skymeasure_api IN DATABASE postgres
  SET search_path = skymeasure, pg_catalog;
```

These provisioning statements are for a new deployment, not a password-rotation script. Do not rerun them against existing objects without checking ownership. The pooler login is `skymeasure_api.PROJECT_REF`; the PostgreSQL role itself is `skymeasure_api`. The runtime URL in `deploy/.env.example` explicitly sets the schema search path. The administrator password is used only for provisioning and is not sent to the backend host. In Supabase Table Editor, select the **skymeasure** schema to see the four research tables; they are not in `public`.

Run migrations with the table-owning role. `anon` and `authenticated` receive no direct schema/table grants and RLS is enabled without permissive browser policies; do not expose the private schema through Supabase Data API. The backend role owns its tables and therefore bypasses their RLS as owner; FastAPI independently enforces account ownership and researcher roles using verified Supabase identities. Do not grant browser SQL privileges to work around a denied request.

Copy `deploy/.env.example` to `deploy/.env` and fill in values. The service-role key is needed by the identity deletion worker, not the ingestion path. Create the schema:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.small.yaml run --rm --no-deps api python -m backend.research.manage migrate
```

The migration creates new research tables and enables policies; it does not reset the old SQLite ingestion database or the phone database. OP-SQLite upgrades from version 2 to 3 add owner/upload metadata. Existing sessions have a null owner and remain local/exportable. They are never silently assigned to the first account.

Bootstrap the first administrator using their Supabase **Auth user UUID**, after their Google signup:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.small.yaml run --rm --no-deps api python -m backend.research.manage admin AUTH_USER_UUID
```

An administrator can then grant/revoke collaborators under Participants. A participant cannot grant roles, read researcher endpoints, or register/upload another participant's session. Research queries use pseudonymous participant IDs, not email addresses.

The Mac's ignored `deploy/.env.bootstrap.local` stores administrator setup inputs as literal data, not executable shell commands. `deploy/.env.db-role.local` holds the generated backend password; `deploy/.env` holds the runtime connection string. Never print or commit these files. Compose reads runtime `.env` directly; do not `source` an unquoted database URL containing shell metacharacters. The optional service-role credential is still needed before starting identity deletion; it is separate from the database password.

For local API-only tests, use `DATABASE_URL=sqlite:////absolute/path/to/staging.sqlite`; this is a test convenience, not the production database. Auth still requires Supabase unless replaced by a test dependency override. Legacy `/api/v1/ingest` works only with `CAPSTONE_LOCAL_DEV=1`. The public probe endpoints remain available because the existing measurement libraries call them directly.

## 3. DigitalOcean Frankfurt

Create a Docker-capable Ubuntu Droplet in `fra1`; assign a stable public IPv4 address and point the API domain to it. Copy the repository and a server-only `deploy/.env`, then run:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml build
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm api python -m backend.research.manage migrate
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
```

The Caddy proxy obtains HTTPS certificates, and leaves probe bodies uncompressed. Open inbound TCP **80/443**, UDP **9876**, and restrict SSH to your administration IP. Do not expose the internal API port 8000. Allow outbound HTTPS to Supabase and the configured database port. DigitalOcean supports separate [TCP and UDP firewall rules](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/); opening TCP 9876 does not enable UDP.

The UDP service only echoes the exact existing 128-byte measurement format and permits at most 100 replies per second. The API limits body sizes, per-process request rate, and server concurrency. The lab proxy now replaces forwarded headers and the API trusts only its loopback proxy; limits can use the transport-observed public caller. Passengers sharing an aircraft NAT still share that public address. Add an edge per-client quota before broader recruitment and load-test the chosen quota so it does not bias experiment results. `PROBE_REGION=fra1` labels HTTP responses; session configuration also records the configured probe region for packet tests. Google targets are not claimed to be physically located in Frankfurt.

Deletion removes the research rows immediately and records an upload-blocking tombstone. The worker retries Supabase identity removal every five minutes. Monitor failures and run `python -m backend.research.manage delete-identities` manually if needed. The minimal tombstone remains to reject valid-but-old tokens and queued uploads from another device. Define retention, backup deletion, and study contact wording before participant recruitment.

### One-GiB pilot and preparation without a domain

The initial purchased pilot uses a one-GiB Basic Droplet in **London (`lon1`)**. Frankfurt above remains the original deployment choice; always use the server's actual region in both `PROBE_REGION` and the mobile `probeRegion`. Do not label London measurements as Frankfurt measurements. Google targets still have no claimed probe region.

On a fresh Ubuntu 24.04 host, install Docker Engine and the Compose plugin using [Docker's official apt instructions](https://docs.docker.com/engine/install/ubuntu/). A one-GiB swap file with `vm.swappiness=10` provides host/build headroom. It is not extra measurement capacity: the small overlay disables container swap, sets memory limits, runs one API worker with a concurrency limit of 16, and rotates each container's logs at 10 MB × 3 files. Under load, requests may receive 503 or containers may reach their memory limit; monitor those outcomes before increasing test volume. No larger participant count is validated by this configuration alone.

Use `deploy/compose.small.yaml` after the base file in **every** Compose command. Its image is shared by the API, UDP service and deletion worker; build it once through `api`. The database and dashboard remain on their separate managed services, not this one-GiB host.

For initial preparation without a domain or Supabase credentials, copy only deployment source to `/opt/skymeasure` (never private datasets or local secrets), then:

```sh
cd /opt/skymeasure
cp deploy/.env.pilot.example deploy/.env
chmod 600 deploy/.env
# Edit PROBE_REGION if this server is not in lon1.
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.small.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.small.yaml build api
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.small.yaml up -d --no-build api udp
curl --fail http://127.0.0.1:8000/health
```

This starts public UDP on 9876 and HTTP bound **only to host loopback** on 8000. Keep the Cloud Firewall's public TCP 8000 closed. The UDP endpoint accepts only the existing 128-byte test format, at most 100 replies per second, with no payload amplification. Allow UDP 9876 explicitly in the Cloud Firewall; Docker-published ports can bypass UFW, so UFW alone is not an adequate rule check. Do not start `proxy` or `identity-deletions` with the placeholder environment. Authenticated ingestion remains unconfigured, and legacy ingestion stays disabled.

To inspect the HTTP API from a Mac before HTTPS is configured:

```sh
ssh -N -L 18000:127.0.0.1:8000 root@YOUR_SERVER_IP
# In another terminal:
curl --fail http://127.0.0.1:18000/health
```

After configuring the domain and Supabase, replace the placeholder values using `deploy/.env.example`, retain the actual region, run `manage migrate` with the same two Compose files, and start the HTTPS proxy with `up -d --no-deps proxy`. Start `identity-deletions` separately only after its service-role credential is configured. Backups and the phone-to-dashboard acceptance run, including mobile Google sign-in, are still required. Host swap and container memory limits do not establish probe timing accuracy; check server load alongside experiments.

### Original London HTTPS endpoint (rollback only)

Before the 31 October lab migration, the GoDaddy DNS A record `api.hailemariam.com` pointed to `142.93.34.57`. It now points to `23.235.205.53`; the following describes the retained rollback host. `API_DOMAIN=api.hailemariam.com` configures Caddy, which listens on TCP 80/443 and persists its automatic certificate state in the Compose volumes. HTTP redirects to HTTPS. The backend remains bound to host loopback on port 8000; UDP still uses `142.93.34.57:9876` directly.

Use `https://api.hailemariam.com` for `NEXT_PUBLIC_API_URL`, `SKYMEASURE_API_URL` and `SKYMEASURE_PROBE_URL`. The Mac's ignored environment files contain these values; the checked-in mobile defaults and installed phone build are not automatically changed. `/health` is a health endpoint, not a dashboard page. Use `PROBE_REGION=lon1` only on the original London host; the lab uses `lab-location-unconfirmed`. The API allows `https://capstone-backend-henna.vercel.app` in `DASHBOARD_ORIGINS`; add any future dashboard origin explicitly.

## 4. Dashboard on Vercel

The current implementation is on branch `feature/skymeasure-participant-dashboard`; configure Vercel to deploy that branch. Import this repository with **Root Directory `dashboard`**, Next.js framework, `npm ci` and `npm run build`. Fill the three public values in `dashboard/.env.example` into the Vercel staging environment. Deploy to the final staging domain and add its exact origin to `DASHBOARD_ORIGINS` and its exact callback to Supabase. Do not configure `SUPABASE_SERVICE_ROLE_KEY` or `DATABASE_URL` as `NEXT_PUBLIC_*` values. Preview deployments need explicit origins/callbacks; they do not automatically get research access.

### Current Vercel deployment and troubleshooting

The stable dashboard address is `https://capstone-backend-henna.vercel.app`. Use this as Supabase's Site URL and add `https://capstone-backend-henna.vercel.app/auth/callback` to its Redirect URLs. Retain the Android callback above. In Google Cloud, the Web OAuth client's authorized redirect URI is the **Supabase** callback `https://ospntgsbsmssfeqwtwbl.supabase.co/auth/v1/callback`. These are two different stages of the sign-in flow; registering the dashboard callback with Google does not replace the Supabase callback.

- `dashboard` exists on `feature/skymeasure-participant-dashboard`, not the current `main`. If Vercel initially imports `main`, change Settings → Environments → Production → Branch Tracking to the feature branch, set Root Directory to `dashboard`, and create a deployment from that branch.
- Use the Next.js preset, `npm ci`, and `npm run build`. Keep the **Output Directory override off**. After changing build settings, create a new deployment; an existing deployment does not acquire the new build settings.
- Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `NEXT_PUBLIC_API_URL` in each intended Vercel environment (Production and Preview for this staging project). The API URL is `https://api.hailemariam.com`. Missing values leave the Google button disabled with a staging-configuration message.
- These public variables are embedded during the Next.js build. Save them and rebuild after changes; promoting an older preview cannot supply settings absent from that build. The public JavaScript bundle was checked after redeployment to confirm all three expected values.
- Google `redirect_uri_mismatch` requires correcting the exact authorized redirect URI on the Web OAuth client configured in Supabase. That provider-setting change does not require a Vercel rebuild.
- New Google users are participants. Bootstrap the first administrator using the management command above and their confirmed Auth user UUID, then refresh the dashboard. Do not commit personal account identifiers or credentials to deployment documentation.

For a local dashboard:

```sh
cp dashboard/.env.example dashboard/.env.local
# Edit the public staging values.
npm ci --prefix dashboard
npm run dev --prefix dashboard
```

The web app checks roles for presentation; FastAPI independently enforces them for every query/download. It polls visible data every 15 seconds, showing received sessions only. Client-held tokens are cleared on sign-out and the query cache is discarded. Downloads are authenticated fetches, not public storage links.

## 5. Current Android public configuration

Copy `.env.skymeasure.example` to the ignored `.env.skymeasure.local` and supply public staging endpoint/publishable-key values. For a configured ARM64 pilot:

```sh
npm run android:pilot
```

The builder reads that file automatically, chooses `com.labpracticeapp.flightpilot://auth/callback`, verifies actual bundled settings and restores the tracked sanitized configuration. The development-key APK and build manifest are under `build/pilot/current/`. The Supabase project must register that callback. No database password, OAuth secret or service-role key belongs in this file or APK.

For Metro/debug builds, the package instead uses `com.labpracticeapp://auth/callback`. See [the explicit configure/run commands](../../CONTRIBUTING.md#4-build-or-debug-the-participant-app); `npm run skymeasure:configure` alone reads the shell environment, not `.env.skymeasure.local`. Local generated public configuration must not be committed. Before public distribution, use protected production signing; this setup does not publish an app store release.

Current participants enroll pseudonymously without an email/password screen, review research/M-Lab disclosure, enter required flight number, route and expected duration, then Start. Duration controls transfer spacing, not when the trip ends. ASN-only admission controls automatic collection; automatic trips do not sample GPS. Notifications are requested before Start; location is optional for Wi-Fi identifiers. The private pilot has uncapped M-Lab alongside bounded 60/20/20 MiB controlled/probe/upload allocations; HTTP transfers are part of the automatic policy, with loaded-latency tests off. The ten-minute/100 MiB Advanced session screen is retained researcher tooling, not the participant trip default. Exact rules are in [the current collection policy](../measurements/flight-collection.md).

## 6. Current physical acceptance procedure

Use a separate staging installation/project and an approved Google researcher account; participants use internal anonymous authentication. A test involving M-Lab needs its public-data disclosure and permission to spend the reserved traffic. Mocked tests and a built APK do not satisfy these device checks:

1. Enroll a new participant online; review the displayed consent and M-Lab disclosure. Cancel/retry researcher Google sign-in separately. Check TalkBack focus, larger text and touch targets across onboarding, Home, Trips and Settings.
2. Verify ordinary nonmatching Wi-Fi remains Watching beyond ten minutes. Use AS12 through the normal detector for the current ground pipeline test; no phone researcher role or shadow toggle is needed. Validate real ASN admission on a suitable provider connection; a synthetic match is not flight validation. Start/Stop, locked screen, results and closed-segment upload must agree with saved evidence.
3. Test optional location denial, hidden SSID, Wi-Fi plus cellular and captive portals per protocol. A missing identifier must not block ASN admission; traffic must not be silently labelled Wi-Fi while routed over cellular.
4. Exercise a fifteen-minute rotation, upload timeout, connectivity restoration and retained budgets/deadlines. Remove from Recents and reboot separately. BackgroundFetch is opportunistic; exact retry timing is not guaranteed. Interrupted evidence survives; new collection requires Start.
5. Force-stop separately. Android suppresses retries until reopening. Reopening must reconcile the interrupted trip before uploading saved evidence.
6. Arm offline after prior enrollment, then restore Wi-Fi. Test expired/revoked identity, pending records, researcher sign-out/account switching and explicit reset without transferring ownership to a new identity.
7. Interrupt/duplicate uploads and verify expected versions, missing segments, raw JSON, distinct measurements/sample counts, chart units and combined CSV. A session can upload completely while containing failed probes.
8. Use disposable identities for deletion checks: confirm deleted ownership cannot reappear through queued records, unrelated accounts remain intact, and the configured identity-deletion worker completes. Do not delete a shared researcher account to test this.

[Background-fetch behavior](https://github.com/transistorsoft/react-native-background-fetch) explains Android termination/reboot and OS limits. The dashboard sees received evidence, not active phones. Record each test’s APK/source version, device/OS, power/connectivity conditions and timestamps; retain limitations alongside successful checks. See [validation](validation.md) for what has actually run.
