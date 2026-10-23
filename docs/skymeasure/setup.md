# SkyMeasure staging setup

This repository contains the participant application, private researcher dashboard, and authenticated API. The collection libraries and probe algorithms are unchanged. Use a separate staging project and study test accounts; final research text and consent approval are deployment inputs. The one-GiB London Droplet now has a Supabase-backed private API. The Google provider is enabled; real user sign-in, a domain, public HTTPS and the public dashboard remain pending.

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

The UDP service only echoes the exact existing 128-byte measurement format and permits at most 100 replies per second. The API limits body sizes, per-process request rate, and server concurrency. Because the proxy is the API's visible peer, the per-process limit is deliberately conservative and shared behind this proxy. Add an edge per-client quota before broader recruitment and load-test the chosen quota so it does not bias experiment results. `PROBE_REGION=fra1` labels HTTP responses; session configuration also records the configured probe region for packet tests. Google targets are not claimed to be physically located in Frankfurt.

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

After configuring the domain and Supabase, replace the placeholder values using `deploy/.env.example`, retain the actual region, run `manage migrate` with the same two Compose files, and start the remaining services with `up -d --no-build`. Backups, real Google sign-in and the phone-to-dashboard acceptance run are still required. Host swap and container memory limits do not establish probe timing accuracy; check server load alongside experiments.

## 4. Dashboard on Vercel

Import this repository with **Root Directory `dashboard`**, Next.js framework, `npm ci` and `npm run build`. Fill the three public values in `dashboard/.env.example` into the Vercel staging environment. Deploy to the final staging domain and add its exact origin to `DASHBOARD_ORIGINS` and its exact callback to Supabase. Do not configure `SUPABASE_SERVICE_ROLE_KEY` or `DATABASE_URL` as `NEXT_PUBLIC_*` values. Preview deployments need explicit origins/callbacks; they do not automatically get research access.

For a local dashboard:

```sh
cp dashboard/.env.example dashboard/.env.local
# Edit the public staging values.
npm ci --prefix dashboard
npm run dev --prefix dashboard
```

The web app checks roles for presentation; FastAPI independently enforces them for every query/download. It polls visible data every 15 seconds, showing received sessions only. Client-held tokens are cleared on sign-out and the query cache is discarded. Downloads are authenticated fetches, not public storage links.

## 5. Android public configuration

Set `SKYMEASURE_SUPABASE_URL`, `SKYMEASURE_SUPABASE_PUBLISHABLE_KEY`, `SKYMEASURE_API_URL`, `SKYMEASURE_PROBE_URL`, `SKYMEASURE_UDP_IPV4`, and `SKYMEASURE_PROBE_REGION` in your local shell, then:

```sh
npm run skymeasure:configure
npm run android
```

The generator writes only public values into `src/config/public.json` and refuses secret-looking Supabase keys. Use a separate configuration/build for staging. Run `npm run skymeasure:docs` after changing the measurement guide or dictionary to refresh the dashboard copies. The checked-in defaults deliberately leave sign-in disabled until configured; there is no fake account or silent production fallback.

Default sessions are ten minutes, 100 MiB, library packet probes, and a 15% battery safeguard. HTTP is optional. Duration, budget, transfer sizes/intervals, probe switches and loaded latency live under Advanced. Notes are optional. Notification permission is requested on start; Wi-Fi-detail permission is requested separately in Account.

Before shipping, supply a proper Android release keystore; the existing project debug signing setup is for development. This work does not publish to an app store.

## 6. Physical acceptance run

Use two real Google test accounts, one ordinary participant and one approved researcher. No physical phone was attached when implementation started; no Google client/project was supplied. The following checks require those inputs and must not be reported as passed by mocked tests:

1. Cancel Google sign-in; return successfully on another attempt; accept the displayed version of consent. Test TalkBack focus, 200% text size, and touch targets on Welcome, Home, Sessions and Account.
2. Start a ten-minute session, lock the screen, stop, verify results and Wi-Fi upload. Confirm HTTP remains optional and the exact configuration is stored. Missing values must say unavailable.
3. Remove the app from Recents, restore Wi-Fi, and inspect eventual delivery. Reboot and repeat. BackgroundFetch is opportunistic, generally no more frequent than 15 minutes; exact timing is not guaranteed.
4. Force-stop separately. Android suppresses retries until reopening. Reopening must recover an interrupted collection before uploading its saved evidence.
5. Start offline after a previous login. Sign out with pending records, sign in as Account B, and verify A's sessions are invisible and are not uploaded by B. Sign back in as A and retry. Expired/revoked credentials leave the queue pending.
6. Interrupt an upload; resend the same batch; verify partial status and exact reconciliation. Check the raw JSON, distinct measurement count, sample count, chart units and combined export.
7. Delete A's data, confirm server and local rows disappear, B is unaffected, and the identity-deletion worker completes. Confirm queued data from another device cannot reappear.

[Background-fetch behavior](https://github.com/transistorsoft/react-native-background-fetch) explains Android termination/reboot and OS limits. Never imply that the dashboard can see unsent sessions or active phones.
