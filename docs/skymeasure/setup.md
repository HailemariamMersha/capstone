# SkyMeasure staging setup

This repository contains the participant application, private researcher dashboard, and authenticated API. The collection libraries and probe algorithms are unchanged. Use a separate staging project and study test accounts; final research text and consent approval are deployment inputs. No cloud account, OAuth client, domain, or service key has been provisioned by this implementation.

## 1. Supabase and Google

Create a Supabase project in **Central EU / Frankfurt**, then enable Google under Authentication → Sign-in providers. In Google Cloud create a Web OAuth client. Register the Supabase callback URL shown by the provider settings (`https://PROJECT.supabase.co/auth/v1/callback`) with Google. Put the Google client ID/secret **only into Supabase**. Configure the OAuth consent screen and test users while the Google project is in testing.

In Supabase URL Configuration, use the dashboard HTTPS domain as the site URL and allow these exact redirects:

- `com.labpracticeapp://auth/callback` for the Android staging application;
- `https://YOUR-DASHBOARD/auth/callback`;
- `http://localhost:3000/auth/callback` for local web development, removed from production configuration.

Avoid broad wildcard redirect allowlists. Mobile uses an external browser with PKCE S256, a Keychain-held verifier, an exact callback check, and a ten-minute locally initiated sign-in window. Tokens are never passed in redirect fragments. This custom scheme works with the current Android application ID; before app-store release, configure a verified HTTPS App Link with your final domain and signing certificate. Android is the validated target; iOS URL registration/background operation are not promised here.

Use a **publishable key** (`sb_publishable_…`) in the apps. It is public configuration, not a secret. Keep the service-role key and database password exclusively on the server. Public signup always creates a participant; Google metadata cannot set research roles.

References: [Google OAuth](https://supabase.com/docs/guides/auth/social-login/auth-google), [PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [PostgreSQL connectivity](https://supabase.com/docs/guides/database/connecting-to-postgres).

## 2. Database and API

Use the Supabase session pooler connection when the server cannot reach the direct IPv6 endpoint. Use SQLAlchemy's `postgresql+psycopg://` scheme and require TLS. Create a dedicated login `skymeasure_api` with ownership of only the `sky_*` application tables, not a superuser. Run the migration with the table-owning role. `anon` and `authenticated` receive no direct grants and RLS is enabled without permissive browser policies; all application access goes through FastAPI. FastAPI validates each token with Supabase Auth, derives ownership from that result, and checks the server-owned role table. Do not grant the browser SQL privileges to work around a denied request.

Copy `deploy/.env.example` to `deploy/.env` and fill in values. The service-role key is needed by the identity deletion worker, not the ingestion path. Create the schema:

```sh
set -a
source deploy/.env
set +a
backend/.venv/bin/python -m backend.research.manage migrate
```

The migration creates new research tables and enables policies; it does not reset the old SQLite ingestion database or the phone database. OP-SQLite upgrades from version 2 to 3 add owner/upload metadata. Existing sessions have a null owner and remain local/exportable. They are never silently assigned to the first account.

Bootstrap the first administrator using their Supabase **Auth user UUID**, after their Google signup:

```sh
backend/.venv/bin/python -m backend.research.manage admin AUTH_USER_UUID
```

An administrator can then grant/revoke collaborators under Participants. A participant cannot grant roles, read researcher endpoints, or register/upload another participant's session. Research queries use pseudonymous participant IDs, not email addresses.

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

Set `SKYMEASURE_SUPABASE_URL`, `SKYMEASURE_SUPABASE_PUBLISHABLE_KEY`, `SKYMEASURE_API_URL`, `SKYMEASURE_PROBE_URL`, and `SKYMEASURE_UDP_IPV4` in your local shell, then:

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
