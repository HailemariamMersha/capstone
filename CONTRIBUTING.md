# Joining SkyMeasure

Start with the [README](README.md), [current architecture and source map](docs/architecture.md), and [ASN-only collection policy](docs/measurements/flight-collection.md). This is an Android research pilot, not a validated flight-detection product. Source access, live researcher access and server administration are separate permissions.

## 1. Get the current code

`main` is an older collector. Use the participant/dashboard branch for current work:

```sh
git clone --branch feature/skymeasure-participant-dashboard https://github.com/HailemariamMersha/capstone.git
cd capstone
git switch -c your-name/short-change-description
```

Contribute through a pull request targeting `feature/skymeasure-participant-dashboard`. Contributors without repository write access can fork it and use that same base branch. Do not merge the feature branch into `main`, change production settings or deploy as part of an ordinary contribution.

## 2. Choose a local starting point

| Work | Requirements | Live research access needed? |
| --- | --- | --- |
| Collector, data model or analysis tests | Node 22.13+, root npm dependencies | No; Jest uses mocks and local SQLite/sanitized fixtures |
| API ownership, ingestion or export tests | Python 3.10+ and pinned backend dependencies; Python 3.14 used for validation | No; default tests use disposable local SQLite and auth overrides |
| Dashboard component/browser tests | Node 22.13+, dashboard npm dependencies, Playwright Chromium | No; browser tests use mocked services and a local test server |
| Android build and device behavior | Root dependencies, JDK 17, Android SDK/build tools 36, NDK 27.1.12297006, USB-debugging Android device | Public app configuration for a configured pilot; real end-to-end tests need a staging identity |
| Inspect actual participant records | Approved Google researcher account | Yes; the study administrator grants the role separately |

A source-only contributor does not need SSH access, database credentials, a Google research role or private experiment exports. The checked-in mobile configuration deliberately leaves enrollment unconfigured. The iOS directory is a scaffold; iOS device, signing and background behavior are not validated.

## 3. Run the checks for your area

Run commands from the repository root. Keep development terminals separate from test runs that need their ports.

### Shared collector and analysis

```sh
npm ci
npm run typecheck
npm test -- --watchman=false --runInBand
```

Root installation applies the owned patches with `patch-package --error-on-fail` and generates bundled legacy NDT7 assets. Do not bypass a failed patch; check the pinned package and patch together. Root Jest excludes `dashboard/`. These tests do not run live speed tests or establish Android endurance.

### Backend

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python -m pytest backend/tests -q
```

Use a fresh terminal without `SKYMEASURE_TEST_DATABASE_URL` for the default SQLite suite. If that variable is deliberately configured, the integration fixture **drops and recreates tables** in a disposable database named `skymeasure_test`. Never point it at a research or shared database. The PostgreSQL-only policy check is skipped without that test database; a SQLite pass does not validate deployed PostgreSQL grants/RLS. Two optional original-dataset agreement tests also skip when the private local export is absent. New contributors do not need that export, and their expected skip count can differ from an operator’s run.

For a local HTTP probe server:

```sh
backend/.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Check `/health` or `/api/v1/probe/ping`. Probe-only startup does not configure authenticated `/api/v2` research operations. Those require a separate staging Supabase project, database configuration and migration as described in [service setup](docs/skymeasure/setup.md). Do not weaken authentication to make the dashboard load.

UDP is a separate process, not part of Uvicorn:

```sh
backend/.venv/bin/python -m backend.udp_echo --host 127.0.0.1 --port 9876
```

This default permits loopback only. A physical phone cannot reach the Mac through its own `127.0.0.1`, and `adb reverse` forwards TCP, not UDP. Use the configured staging probe or a deliberately scoped reachable Wi-Fi endpoint for device UDP checks. Do not open an unrestricted echo service.

### Researcher dashboard

```sh
npm ci --prefix dashboard
cd dashboard
npx playwright install chromium
cd ..
npm run typecheck --prefix dashboard
npm test --prefix dashboard
```

Playwright starts a local server on port 3100 with fixture public configuration and mocked API responses. No real Google account or production dataset is required. Stop another process using that port before running it. Next.js may regenerate `dashboard/next-env.d.ts`; inspect this incidental change rather than committing a development-only generated path.

For interactive development, copy `dashboard/.env.example` to `dashboard/.env.local`, supply your staging public endpoints and run `npm run dev --prefix dashboard` (default port 3000). Without real configured services/researcher approval, the live authenticated workspace will not show data. Configure the matching dashboard OAuth callback in staging. Public Supabase keys are safe client inputs; service-role keys and database URLs are never browser inputs.

## 4. Build or debug the participant app

Copy `.env.skymeasure.example` to `.env.skymeasure.local` and fill in public staging configuration. The coordinator can provide endpoints, the publishable key and the actual/unknown probe region without sharing server secrets.

For a bundled, shareable ARM64 pilot without Metro:

```sh
npm run android:pilot
```

The builder writes `build/pilot/current/SkyMeasure-pilot-arm64.apk` and `manifest.json`, verifies bundled public configuration, and restores the original tracked config. It uses package `com.labpracticeapp.flightpilot`, the pilot callback and a development signing key. It is for supervised pilot testing, not a production store release. The manifest records source commit/dirty state; use a clean tree for reviewable release evidence. The APK is the installation artifact; the manifest is not required to install it.

For development with Metro, generate local public configuration explicitly. Unlike the pilot builder, the configure script does not automatically read the local env file:

```sh
SKYMEASURE_REDIRECT_URL=com.labpracticeapp://auth/callback node --env-file=.env.skymeasure.local scripts/configure-skymeasure.cjs
npm start
```

In a second terminal:

```sh
adb devices
adb reverse tcp:8081 tcp:8081
npm run android
```

The development package uses callback `com.labpracticeapp://auth/callback`; the pilot uses `com.labpracticeapp.flightpilot://auth/callback`. Register the right callback in your staging project. Running the configure script changes tracked `src/config/public.json`; never commit installation-specific settings. When finished, review its diff and restore the sanitized template if the diff consists only of your local configuration.

Participants enroll without a login screen, accept research/M-Lab disclosure, complete flight number/route/expected length and Start. Notifications are requested before Start; location is optional for Wi-Fi identifiers. Ordinary home Wi-Fi usually will not match the configured provider ASN allowlist. To exercise collection on the ground, use the configured pilot on an AS12 (NYU) connection and enter clearly synthetic required flight details. The normal ASN detector will qualify it and label the trip as a ground test, with no researcher sign-in or bypass. The new pilot M-Lab run is uncapped by bytes, so review the new disclosure before Start. It does not validate airborne status. See [the current pilot policy](docs/skymeasure/uncapped-pilot.md).

Native instrumentation includes dated/operator-specific tests that read saved records, contact staging or require explicit live-test consent. Review and select tests intentionally. The current `AppLaunchTest` checks the participant onboarding/Home/recovery screens, not the former Google welcome. Building an instrumentation APK is not evidence that those tests ran or passed. Do not run the whole device suite blindly on a participant phone.

## 5. Make a reviewable change

Use the [source map](docs/architecture.md) to choose the correct layer. Keep scheduling/control logic in TypeScript; preserve library provenance when editing adapters. Do not turn unavailable values into zero or present inferred connectivity as verified flight evidence.

For a collector/auth/sync change, run TypeScript and the affected meaningful Jest tests, then the full root suite when shared behavior changed. API/export changes need the relevant backend checks. Dashboard behavior changes need its typecheck/browser checks. Documentation-only edits need link/command review and generated-copy checks, not a new application test suite.

Edit measurement definitions in `scripts/measurements/columns.json`, then run `npm run measurements:docs` and `npm run skymeasure:docs`. Do not edit generated dictionary/dashboard copies directly. Tests must use sanitized fixtures, not private exports under Downloads or a colleague's account.

Before committing, inspect `git status --short`, `git diff` and the staged diff. Keep secrets, raw datasets, APKs and local configuration out of the commit; follow [SECURITY.md](SECURITY.md). Use small commits with a concrete message such as `fix(sync): preserve pending records after token expiry`. Describe the changed behavior, validation and remaining device limitations in the pull request.

## 6. Current work and remaining evidence

Useful starting areas are validating selected-Wi-Fi routing with cellular/captive portals, unplugged/background lifecycle tests, M-Lab capped/partial behavior, long-task cancellation at segment boundaries, and real-flight ASN coverage. The current scheduler still uses fifteen-minute upload segments; dedicated measurement blocks are a proposal. Coordinate an issue/task before changing measurement semantics, ownership, policy versions or consent.

The [current validation record](docs/skymeasure/validation.md) distinguishes automated, ground-device and real-flight evidence. No existing test run establishes airborne detection accuracy, all-manufacturer background reliability or iOS support. Live deployments and public recruitment require the study coordinator; ordinary development changes do not need access to the shared lab host.
